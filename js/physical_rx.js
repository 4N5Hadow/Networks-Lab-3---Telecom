'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// PHYSICAL RX  —  OpenCV.js camera receiver (ultra-robust version)
//
// Key improvements:
//   1. Adaptive thresholding on HSV Value channel for rock-solid black square
//      segmentation under any ambient light and on any phone display.
//   2. Scale-invariant candidate filtering (0.015% to 15% image area) supporting
//      close-up to 2+ meters distance.
//   3. Quad optimization: when multiple dark blobs exist (e.g. 4 corner markers +
//      clock cell + background noise), finds the best 4-corner convex quad
//      enclosing the screen.
//   4. Stable corner sorting (clockwise by angle, TL identified by min(x+y)).
//   5. Temporal quad smoothing & single-frame loss tolerance to eliminate jitter.
//   6. Precise canonical perspective warp to 400×400 canvas.
//   7. Robust clock transition edge-detection with K-frame debouncing.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    const LO = window.LAYOUT;
    const CS = LO.CANON_SIZE;  // 400

    class PhysicalRX {
        constructor(video) {
            this.video   = video;
            this.running = false;

            // Calibration
            this.calibrated   = false;
            this.refColors    = null;
            this.clockMidLuma = 128;

            // Clock debounce
            this.lastClockState = 'B';
            this._debounce      = [];
            this.K              = 4;

            // Marker detection params (scale invariant)
            this.markerMinFrac = 0.00015;  // > 0.015% of image (handles ~2m distance)
            this.markerMaxFrac = 0.15;     // < 15% of image (handles close range)
            this.DS_W          = 640;      // downsample width for fast detection

            // Internal canvases
            this._capCanvas  = document.createElement('canvas');
            this._capCtx     = this._capCanvas.getContext('2d', { willReadFrequently: true });
            this._warpCanvas = Object.assign(document.createElement('canvas'), { width: CS, height: CS });
            this._warpCtx    = this._warpCanvas.getContext('2d', { willReadFrequently: true });

            // Calibration accumulation
            this._calibrating  = false;
            this._calibSamples = [];
            this._calibDone    = null;

            this._stream = null;
            this._raf    = null;

            // Last good quad & temporal tracking
            this._lastQuad           = null;
            this._lostQuadFrames     = 0;
            this._MAX_LOST_FRAMES    = 4; // allow up to 4 dropped frames before declaring lost
            this._lastWarpOk         = false;
            this._lastCandidateCount = 0;

            // Callbacks
            this.onNewSymbol = null;
            this.onDebug     = null;
        }

        // ── Camera ───────────────────────────────────────────────────────────

        async start() {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        facingMode: { ideal: 'environment' },
                        width:  { ideal: 1280 },
                        height: { ideal: 720 },
                    },
                    audio: false,
                });
                this._stream = stream;
                this.video.srcObject = stream;
                await new Promise(r => { this.video.onloadedmetadata = r; });
                this.video.play();
                this.running = true;
                this._loop();
                return true;
            } catch (e) {
                console.warn('[PhysicalRX] camera error:', e.message);
                return false;
            }
        }

        stop() {
            this.running = false;
            if (this._raf)    cancelAnimationFrame(this._raf);
            if (this._stream) this._stream.getTracks().forEach(t => t.stop());
        }

        /** Get the internal warped canvas (400×400) for debug display. */
        getWarpedCanvas() {
            return this._lastWarpOk ? this._warpCanvas : null;
        }

        // ── Frame loop ───────────────────────────────────────────────────────

        _loop() {
            if (!this.running) return;
            this._raf = requestAnimationFrame(() => this._loop());
            if (this.video.readyState < 2) return;
            if (!window._cvReady) {
                if (this.onDebug) this.onDebug({ screenFound: false, cvReady: false });
                return;
            }
            try { this._processFrame(); }
            catch (e) { console.error('[PhysicalRX] frame error:', e); }
        }

        _processFrame() {
            const VW = this.video.videoWidth, VH = this.video.videoHeight;
            if (!VW || !VH) return;

            // Downsample for detection
            const dsH = Math.round(this.DS_W * VH / VW);
            this._capCanvas.width  = this.DS_W;
            this._capCanvas.height = dsH;
            this._capCtx.drawImage(this.video, 0, 0, this.DS_W, dsH);

            // Detect 4 finder markers
            const quad = this._findMarkers(this.DS_W, dsH);

            let activeQuad = null;
            if (quad) {
                // Scale from downsample space to native video space
                const sx = VW / this.DS_W, sy = VH / dsH;
                const fullQuad = {
                    TL: { x: quad.TL.x * sx, y: quad.TL.y * sy },
                    TR: { x: quad.TR.x * sx, y: quad.TR.y * sy },
                    BL: { x: quad.BL.x * sx, y: quad.BL.y * sy },
                    BR: { x: quad.BR.x * sx, y: quad.BR.y * sy },
                };

                // Temporal smoothing (exponential moving average: alpha = 0.65)
                if (this._lastQuad) {
                    const a = 0.65, b = 1 - a;
                    this._lastQuad = {
                        TL: { x: a * fullQuad.TL.x + b * this._lastQuad.TL.x, y: a * fullQuad.TL.y + b * this._lastQuad.TL.y },
                        TR: { x: a * fullQuad.TR.x + b * this._lastQuad.TR.x, y: a * fullQuad.TR.y + b * this._lastQuad.TR.y },
                        BL: { x: a * fullQuad.BL.x + b * this._lastQuad.BL.x, y: a * fullQuad.BL.y + b * this._lastQuad.BL.y },
                        BR: { x: a * fullQuad.BR.x + b * this._lastQuad.BR.x, y: a * fullQuad.BR.y + b * this._lastQuad.BR.y },
                    };
                } else {
                    this._lastQuad = fullQuad;
                }
                this._lostQuadFrames = 0;
                activeQuad = this._lastQuad;
            } else if (this._lastQuad && this._lostQuadFrames < this._MAX_LOST_FRAMES) {
                // Temporary drop tolerance: hold previous quad for up to MAX_LOST_FRAMES
                this._lostQuadFrames++;
                activeQuad = this._lastQuad;
            } else {
                this._lastQuad   = null;
                this._lastWarpOk = false;
                if (this.onDebug) this.onDebug({
                    screenFound: false, cvReady: true,
                    candidateCount: this._lastCandidateCount || 0,
                });
                return;
            }

            // Full-res capture for perspective warp
            this._capCanvas.width  = VW;
            this._capCanvas.height = VH;
            this._capCtx.drawImage(this.video, 0, 0, VW, VH);

            // Warp
            if (!this._warpPerspective(activeQuad, VW, VH)) {
                this._lastWarpOk = false;
                return;
            }
            this._lastWarpOk = true;

            const warpedData = this._warpCtx.getImageData(0, 0, CS, CS);

            // Calibration
            if (this._calibrating) {
                this._accumCalib(warpedData);
                if (this.onDebug) this.onDebug({
                    screenFound: true, quad: activeQuad, calibrating: true, cvReady: true,
                    calibProgress: this._calibSamples.length,
                });
                return;
            }
            if (!this.calibrated) {
                if (this.onDebug) this.onDebug({
                    screenFound: true, quad: activeQuad, calibrating: false, cvReady: true,
                });
                return;
            }

            // Sample clock
            const ck    = LO.CANON_CLOCK;
            const ckRgb = this._mean(warpedData.data, CS, CS, ck.x, ck.y, ck.hw);
            const luma  = 0.299 * ckRgb.r + 0.587 * ckRgb.g + 0.114 * ckRgb.b;
            const ckSt  = luma < this.clockMidLuma ? 'B' : 'W';

            // K-frame debounce
            this._debounce.push(ckSt);
            if (this._debounce.length > this.K) this._debounce.shift();
            let newSymbol = false;
            if (this._debounce.length === this.K &&
                this._debounce.every(s => s === this._debounce[0]) &&
                this._debounce[0] !== this.lastClockState) {
                this.lastClockState = this._debounce[0];
                newSymbol = true;
            }

            // Sample data cells
            const rawCellRgb = LO.CANON_CELLS.map(c =>
                this._mean(warpedData.data, CS, CS, c.x, c.y, c.hw));
            const cellColors = rawCellRgb.map(rgb => this._classify(rgb));

            if (this.onDebug) {
                this.onDebug({
                    screenFound: true,
                    quad: activeQuad,
                    clockState: ckSt,
                    luma: luma.toFixed(1),
                    midLuma: this.clockMidLuma.toFixed(1),
                    cellColors: cellColors.map(c => Framing.COLOR_NAMES[c]),
                    cellRgb: rawCellRgb.map(c => `(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`),
                    newSymbol,
                    cvReady: true,
                });
            }

            if (newSymbol && this.onNewSymbol) this.onNewSymbol([...cellColors]);
        }

        // ── Marker detection ─────────────────────────────────────────────────

        _findMarkers(W, H) {
            let src = null, rgb = null, hsv = null, hsvChannels = null, valueChan = null;
            let blur = null, binary = null, closed = null;
            let contours = null, hierarchy = null, kernel = null;
            this._lastCandidateCount = 0;

            try {
                const imgData = this._capCtx.getImageData(0, 0, W, H);
                src = cv.matFromImageData(imgData);

                // Convert RGBA -> RGB -> HSV
                // Value channel V = max(R,G,B). Saturated colors (Red, Green, Blue, White, Grey bg)
                // all have high Value (>= 180). Black markers and black clock have low Value (< 70).
                rgb = new cv.Mat();
                cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
                hsv = new cv.Mat();
                cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
                hsvChannels = new cv.MatVector();
                cv.split(hsv, hsvChannels);
                valueChan = hsvChannels.get(2); // H=0, S=1, V=2

                blur = new cv.Mat();
                cv.GaussianBlur(valueChan, blur, new cv.Size(5, 5), 0);

                // Adaptive thresholding: local contrast separates dark markers on light screen
                // regardless of distance or room lighting.
                binary = new cv.Mat();
                const blockSize = Math.max(15, (Math.round(W / 25) | 1)); // odd number ~25-31
                cv.adaptiveThreshold(blur, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                                     cv.THRESH_BINARY_INV, blockSize, 12);

                kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
                closed = new cv.Mat();
                cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);

                contours  = new cv.MatVector();
                hierarchy = new cv.Mat();
                cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

                const imgArea = W * H;
                const minArea = imgArea * this.markerMinFrac;
                const maxArea = imgArea * this.markerMaxFrac;
                const candidates = [];

                for (let i = 0; i < contours.size(); i++) {
                    const cnt  = contours.get(i);
                    const area = cv.contourArea(cnt);

                    if (area >= minArea && area <= maxArea) {
                        const peri   = cv.arcLength(cnt, true);
                        const approx = new cv.Mat();
                        cv.approxPolyDP(cnt, approx, 0.04 * peri, true);

                        const rect = cv.boundingRect(cnt);
                        const bboxArea = rect.width * rect.height;
                        const fill = area / (bboxArea || 1);
                        const asp  = Math.min(rect.width, rect.height) / (Math.max(rect.width, rect.height) || 1);

                        // Quad-like blob with solid rectangular/diamond fill (fill >= 0.45 handles any perspective rotation)
                        const isQuadLike = approx.rows >= 4 && approx.rows <= 8;

                        if (isQuadLike && fill >= 0.45 && asp >= 0.40) {
                            const M  = cv.moments(cnt, false);
                            if (M.m00 > 0) {
                                const cx = M.m10 / M.m00;
                                const cy = M.m01 / M.m00;
                                candidates.push({ x: cx, y: cy, area });
                            }
                        }
                        approx.delete();
                    }
                    cnt.delete();
                }

                this._lastCandidateCount = candidates.length;
                if (candidates.length < 4) return null;

                // Pick the best 4 candidates forming the transmitter screen quad
                return this._selectBestQuad(candidates, W, H);

            } catch (e) {
                console.warn('[PhysicalRX] findMarkers:', e.message);
                return null;
            } finally {
                src?.delete(); rgb?.delete(); hsv?.delete();
                hsvChannels?.delete(); valueChan?.delete();
                blur?.delete();
                binary?.delete(); closed?.delete(); kernel?.delete();
                contours?.delete(); hierarchy?.delete();
            }
        }

        /**
         * Find the best 4-point convex quadrilateral from candidate marker blobs.
         */
        _selectBestQuad(candidates, W, H) {
            // If candidates are many, prioritize top 10 by area
            const pool = candidates.slice(0, 10);
            if (pool.length < 4) return null;

            if (pool.length === 4) {
                const quad = this._sortCorners(pool);
                return this._isConvexQuad(quad) ? quad : null;
            }

            // Test 4-point subsets and score them
            let bestQuad = null, bestScore = -Infinity;
            const N = pool.length;

            for (let i = 0; i < N - 3; i++) {
                for (let j = i + 1; j < N - 2; j++) {
                    for (let k = j + 1; k < N - 1; k++) {
                        for (let l = k + 1; l < N; l++) {
                            const pts = [pool[i], pool[j], pool[k], pool[l]];
                            const quad = this._sortCorners(pts);
                            if (!this._isConvexQuad(quad)) continue;

                            // Compute quadrilateral properties
                            const topW = Math.hypot(quad.TR.x - quad.TL.x, quad.TR.y - quad.TL.y);
                            const botW = Math.hypot(quad.BR.x - quad.BL.x, quad.BR.y - quad.BL.y);
                            const lftH = Math.hypot(quad.BL.x - quad.TL.x, quad.BL.y - quad.TL.y);
                            const rgtH = Math.hypot(quad.BR.x - quad.TR.x, quad.BR.y - quad.TR.y);

                            const avgW = (topW + botW) / 2;
                            const avgH = (lftH + rgtH) / 2;
                            if (avgW < 10 || avgH < 10) continue;

                            // Aspect ratio should be roughly 1.0 (screen canvas is square)
                            const aspect = Math.min(avgW, avgH) / Math.max(avgW, avgH);
                            if (aspect < 0.45) continue; // reject heavily distorted non-square sets

                            // Area ratio of candidate markers (markers should be similar in size)
                            const areas = pts.map(p => p.area);
                            const maxA = Math.max(...areas), minA = Math.min(...areas);
                            const areaRatio = minA / (maxA || 1);

                            // Approximate quad area
                            const quadArea = avgW * avgH;

                            // Score: higher area + higher aspect + area consistency
                            const score = Math.log(quadArea + 1) * 3 + aspect * 4 + areaRatio * 2;

                            if (score > bestScore) {
                                bestScore = score;
                                bestQuad  = quad;
                            }
                        }
                    }
                }
            }

            return bestQuad;
        }

        _isConvexQuad(quad) {
            if (!quad) return false;
            // Cross product test for strictly convex polygon in clockwise order
            const pts = [quad.TL, quad.TR, quad.BR, quad.BL];
            let sign = 0;
            for (let i = 0; i < 4; i++) {
                const p1 = pts[i];
                const p2 = pts[(i + 1) % 4];
                const p3 = pts[(i + 2) % 4];
                const dx1 = p2.x - p1.x, dy1 = p2.y - p1.y;
                const dx2 = p3.x - p2.x, dy2 = p3.y - p2.y;
                const cross = dx1 * dy2 - dy1 * dx2;
                if (Math.abs(cross) < 1e-4) return false;
                if (i === 0) sign = cross > 0 ? 1 : -1;
                else if ((cross > 0 ? 1 : -1) !== sign) return false;
            }
            return true;
        }

        _sortCorners(pts) {
            // Compute centroid
            const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
            const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;

            // Sort points by angle around centroid in clockwise order (in screen coordinates y down)
            const sortedByAngle = [...pts].sort((a, b) =>
                Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
            );

            // TL corner is the one with smallest (x + y) in upright/near-upright orientation
            let tlIdx = 0, minSum = Infinity;
            sortedByAngle.forEach((p, idx) => {
                const sum = p.x + p.y;
                if (sum < minSum) { minSum = sum; tlIdx = idx; }
            });

            // Follow clockwise order from TL: TL -> TR -> BR -> BL
            const TL = sortedByAngle[tlIdx];
            const TR = sortedByAngle[(tlIdx + 1) % 4];
            const BR = sortedByAngle[(tlIdx + 2) % 4];
            const BL = sortedByAngle[(tlIdx + 3) % 4];

            return { TL, TR, BR, BL };
        }

        // ── Warp ─────────────────────────────────────────────────────────────

        _warpPerspective(quad, VW, VH) {
            let src = null, srcPts = null, dstPts = null, M = null, dst = null;
            try {
                const imgData = this._capCtx.getImageData(0, 0, VW, VH);
                src = cv.matFromImageData(imgData);

                srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
                    quad.TL.x, quad.TL.y,
                    quad.TR.x, quad.TR.y,
                    quad.BR.x, quad.BR.y,
                    quad.BL.x, quad.BL.y,
                ]);
                dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
                    0,  0,
                    CS, 0,
                    CS, CS,
                    0,  CS,
                ]);

                M   = cv.getPerspectiveTransform(srcPts, dstPts);
                dst = new cv.Mat();
                cv.warpPerspective(src, dst, M, new cv.Size(CS, CS),
                                   cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

                cv.imshow(this._warpCanvas, dst);
                return true;
            } catch (e) {
                console.warn('[PhysicalRX] warp:', e.message);
                return false;
            } finally {
                src?.delete(); srcPts?.delete(); dstPts?.delete(); M?.delete(); dst?.delete();
            }
        }

        // ── Calibration ──────────────────────────────────────────────────────

        startCalibration(onDone) {
            this._calibSamples = [];
            this._calibDone    = onDone;
            this._calibrating  = true;
        }

        _accumCalib(warpedData) {
            const cellSamples = LO.CANON_CELLS.map(c =>
                this._mean(warpedData.data, CS, CS, c.x, c.y, c.hw));
            const clockSample = this._mean(warpedData.data, CS, CS,
                LO.CANON_CLOCK.x, LO.CANON_CLOCK.y, LO.CANON_CLOCK.hw);

            this._calibSamples.push({ cells: cellSamples, clock: clockSample });

            if (this._calibSamples.length >= 30) {
                const N = this._calibSamples.length;

                this.refColors = [0, 1, 2, 3].map(ci => ({
                    r: this._calibSamples.reduce((s, f) => s + f.cells[ci].r, 0) / N,
                    g: this._calibSamples.reduce((s, f) => s + f.cells[ci].g, 0) / N,
                    b: this._calibSamples.reduce((s, f) => s + f.cells[ci].b, 0) / N,
                }));

                const whiteLuma = 0.299 * this.refColors[0].r +
                                  0.587 * this.refColors[0].g +
                                  0.114 * this.refColors[0].b;
                const blackLuma = this._calibSamples.reduce((s, f) => {
                    const { r, g, b } = f.clock;
                    return s + (0.299 * r + 0.587 * g + 0.114 * b);
                }, 0) / N;
                this.clockMidLuma = (whiteLuma + blackLuma) / 2;

                this._calibrating   = false;
                this.calibrated     = true;
                this.lastClockState = 'B';
                this._debounce      = [];

                if (this._calibDone) this._calibDone();
            }
        }

        // ── Pixel helpers ────────────────────────────────────────────────────

        _mean(pixels, W, H, cx, cy, hw) {
            const x0 = Math.max(0, Math.round(cx - hw));
            const x1 = Math.min(W - 1, Math.round(cx + hw));
            const y0 = Math.max(0, Math.round(cy - hw));
            const y1 = Math.min(H - 1, Math.round(cy + hw));
            let r = 0, g = 0, b = 0, n = 0;
            for (let y = y0; y <= y1; y++)
                for (let x = x0; x <= x1; x++) {
                    const i = (y * W + x) * 4;
                    r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; n++;
                }
            return n ? { r: r / n, g: g / n, b: b / n } : { r: 0, g: 0, b: 0 };
        }

        _classify(rgb) {
            if (!this.refColors || this.refColors.length < 4) return 0;
            let minD = Infinity, minI = 0;
            this.refColors.forEach((ref, i) => {
                const d = (rgb.r - ref.r) ** 2 + (rgb.g - ref.g) ** 2 + (rgb.b - ref.b) ** 2;
                if (d < minD) { minD = d; minI = i; }
            });
            return minI;
        }

        resetClock() {
            this.lastClockState  = 'B';
            this._debounce       = [];
            this._lastQuad       = null;
            this._lostQuadFrames = 0;
        }

        reset() {
            this._calibrating    = false;
            this._calibSamples   = [];
            this._calibDone      = null;
            this.calibrated      = false;
            this.resetClock();
        }
    }

    window.PhysicalRX = PhysicalRX;
})();
