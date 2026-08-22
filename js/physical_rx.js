'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// PHYSICAL RX  —  OpenCV.js camera receiver (robust version)
//
// Key improvements over v1:
//   1. Marker detection uses approxPolyDP to find 4-vertex convex contours
//      (actual squares), not just "any blob with decent fill ratio"
//   2. Area filtering uses percentage of total image area, adapting to
//      different camera distances automatically
//   3. Corner sorting uses sum/difference method (robust to rotation)
//   4. warpPerspective destination maps to MARKER CENTROIDS, matching
//      the canonical coordinate system in layout.js
//   5. Calibration requires markers to be found (rejects garbage frames)
//   6. Clock debounce K increased to 4 for more stability
//   7. Exposes getWarpedCanvas() for debug visualisation
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

            // Marker detection params (adaptive: fraction of image area)
            this.markerMinFrac = 0.001;   // marker must be > 0.1% of image
            this.markerMaxFrac = 0.08;    // marker must be < 8% of image
            this.DS_W          = 640;     // downsample width for detection

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

            // Last good warp for debug
            this._lastWarpOk = false;

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

            if (!quad) {
                this._lastWarpOk = false;
                if (this.onDebug) this.onDebug({
                    screenFound: false, cvReady: true,
                    candidateCount: this._lastCandidateCount || 0,
                });
                return;
            }

            // Scale to native video space
            const sx = VW / this.DS_W, sy = VH / dsH;
            const fullQuad = {
                TL: { x: quad.TL.x * sx, y: quad.TL.y * sy },
                TR: { x: quad.TR.x * sx, y: quad.TR.y * sy },
                BL: { x: quad.BL.x * sx, y: quad.BL.y * sy },
                BR: { x: quad.BR.x * sx, y: quad.BR.y * sy },
            };

            // Full-res capture for warp
            this._capCanvas.width  = VW;
            this._capCanvas.height = VH;
            this._capCtx.drawImage(this.video, 0, 0, VW, VH);

            // Warp
            if (!this._warpPerspective(fullQuad, VW, VH)) {
                this._lastWarpOk = false;
                return;
            }
            this._lastWarpOk = true;

            const warpedData = this._warpCtx.getImageData(0, 0, CS, CS);

            // Calibration
            if (this._calibrating) {
                this._accumCalib(warpedData);
                if (this.onDebug) this.onDebug({
                    screenFound: true, quad: fullQuad, calibrating: true, cvReady: true,
                    calibProgress: this._calibSamples.length,
                });
                return;
            }
            if (!this.calibrated) {
                if (this.onDebug) this.onDebug({
                    screenFound: true, quad: fullQuad, calibrating: false, cvReady: true,
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
                    quad: fullQuad,
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
            let src = null, gray = null, blur = null, binary = null, closed = null;
            let contours = null, hierarchy = null, kernel = null;
            this._lastCandidateCount = 0;

            try {
                const imgData = this._capCtx.getImageData(0, 0, W, H);
                src = cv.matFromImageData(imgData);
                gray = new cv.Mat();
                cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

                blur = new cv.Mat();
                cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

                binary = new cv.Mat();
                cv.threshold(blur, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

                kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
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
                        // Approximate contour to polygon
                        const peri   = cv.arcLength(cnt, true);
                        const approx = new cv.Mat();
                        cv.approxPolyDP(cnt, approx, 0.04 * peri, true);

                        // Must have ~4 vertices (square) and be convex
                        if (approx.rows >= 4 && approx.rows <= 6 && cv.isContourConvex(approx)) {
                            const rect = cv.boundingRect(cnt);
                            const bboxArea = rect.width * rect.height;
                            const fill = area / (bboxArea || 1);
                            const asp  = Math.min(rect.width, rect.height) / (Math.max(rect.width, rect.height) || 1);

                            // Square-ish: fill > 0.7 (actual squares fill well), aspect > 0.5
                            if (fill >= 0.65 && asp >= 0.5) {
                                const M  = cv.moments(cnt, false);
                                const cx = M.m10 / (M.m00 || 1);
                                const cy = M.m01 / (M.m00 || 1);
                                candidates.push({ x: cx, y: cy, area });
                            }
                        }
                        approx.delete();
                    }
                    cnt.delete();
                }

                this._lastCandidateCount = candidates.length;
                if (candidates.length < 4) return null;

                // Top 4 by area
                candidates.sort((a, b) => b.area - a.area);
                const top4 = candidates.slice(0, 4);

                // Reject if sizes differ too much (max 8× ratio for perspective)
                const maxA = top4[0].area, minA2 = top4[3].area;
                if (minA2 * 8 < maxA) return null;

                return this._sortCorners(top4);

            } catch (e) {
                console.warn('[PhysicalRX] findMarkers:', e.message);
                return null;
            } finally {
                src?.delete(); gray?.delete(); blur?.delete();
                binary?.delete(); closed?.delete(); kernel?.delete();
                contours?.delete(); hierarchy?.delete();
            }
        }

        _sortCorners(pts) {
            // Sort by (x + y) → smallest = TL, largest = BR
            const sorted = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
            const TL = sorted[0], BR = sorted[3];
            // Sort the middle two by (x - y) → larger = TR, smaller = BL
            const mid = [sorted[1], sorted[2]].sort((a, b) => (b.x - b.y) - (a.x - a.y));
            return { TL, TR: mid[0], BL: mid[1], BR };
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
            let minD = Infinity, minI = 0;
            this.refColors.forEach((ref, i) => {
                const d = (rgb.r - ref.r) ** 2 + (rgb.g - ref.g) ** 2 + (rgb.b - ref.b) ** 2;
                if (d < minD) { minD = d; minI = i; }
            });
            return minI;
        }

        resetClock() {
            this.lastClockState = 'B';
            this._debounce      = [];
        }
    }

    window.PhysicalRX = PhysicalRX;
})();
