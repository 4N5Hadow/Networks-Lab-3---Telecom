'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// PHYSICAL RX  —  OpenCV.js-based camera receiver
//
// Pipeline per animation-frame:
//   1. Capture video frame → canvas → cv.Mat (RGBA)
//   2. Grayscale → Gaussian blur → Otsu threshold (BINARY_INV)
//      → Morphological close → findContours
//      → Filter for square blobs → pick top-4 by area → sort into TL/TR/BL/BR
//   3. getPerspectiveTransform (marker centroids → 400×400 canonical square)
//      + warpPerspective  →  clean canonical view
//   4. In canonical view: mean-RGB sample at LAYOUT.CANON_CLOCK and CANON_CELLS
//   5. Clock K-frame debounce → onNewSymbol([TL,TR,BL,BR]) callback
//
// Calibration: sender shows the fixed colour-grid frame; receiver samples
// 30 warped frames to compute per-colour reference centroids + clock threshold.
//
// All tunable parameters are exposed as instance properties.
// Requires: window.cv (OpenCV.js loaded), window.LAYOUT (layout.js), window.Framing.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    const LO = window.LAYOUT;
    const CS = LO.CANON_SIZE;  // 400 px

    // ─────────────────────────────────────────────────────────────────────────
    class PhysicalRX {
        /** @param {HTMLVideoElement} video */
        constructor(video) {
            this.video   = video;
            this.running = false;

            // ── Calibration state ──────────────────────────────────────────
            this.calibrated   = false;
            this.refColors    = null;    // [{r,g,b} × 4] — WHITE, RED, GREEN, BLUE
            this.clockMidLuma = 128;

            // ── Clock debounce ────────────────────────────────────────────
            this.lastClockState = null;   // 'B' | 'W'
            this._debounce      = [];
            this.K              = 3;      // frames of agreement required

            // ── Marker detection tuning ───────────────────────────────────
            this.markerMinArea  = 20;     // px² in downsampled space (DS_W × DS_H)
            this.markerMaxArea  = 12000;  // px²
            this.markerFillMin  = 0.40;   // contour_area / bbox_area
            this.markerAspMin   = 0.25;   // w/h or h/w must exceed this
            this.DS_W           = 480;    // width for downsampled detection pass

            // ── Internal canvases (not attached to DOM) ───────────────────
            this._capCanvas  = document.createElement('canvas');   // capture at DS_W
            this._capCtx     = this._capCanvas.getContext('2d', { willReadFrequently: true });
            this._warpCanvas = Object.assign(document.createElement('canvas'), { width: CS, height: CS });
            this._warpCtx    = this._warpCanvas.getContext('2d', { willReadFrequently: true });

            // ── Calibration accumulation ──────────────────────────────────
            this._calibrating  = false;
            this._calibSamples = [];
            this._calibDone    = null;

            this._stream = null;
            this._raf    = null;

            // ── Public callbacks ──────────────────────────────────────────
            /** @type {((cells: number[]) => void)|null} */
            this.onNewSymbol = null;
            /** @type {((info: object) => void)|null}
             *  info includes: { screenFound, quad?, clockState?, luma?, midLuma?,
             *                   cellColors?, newSymbol?, calibrating? } */
            this.onDebug     = null;
        }

        // ── Camera lifecycle ─────────────────────────────────────────────────

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

            // ── Downsample for detection ──────────────────────────────────────
            const dsH = Math.round(this.DS_W * VH / VW);
            this._capCanvas.width  = this.DS_W;
            this._capCanvas.height = dsH;
            this._capCtx.drawImage(this.video, 0, 0, this.DS_W, dsH);

            // ── Detect 4 finder markers via OpenCV ────────────────────────────
            const quad = this._findMarkers(this.DS_W, dsH);

            if (!quad) {
                if (this.onDebug) this.onDebug({ screenFound: false, cvReady: true });
                return;
            }

            // Scale quad from downsampled space → native video space
            const sx = VW / this.DS_W, sy = VH / dsH;
            const fullQuad = {
                TL: { x: quad.TL.x * sx, y: quad.TL.y * sy },
                TR: { x: quad.TR.x * sx, y: quad.TR.y * sy },
                BL: { x: quad.BL.x * sx, y: quad.BL.y * sy },
                BR: { x: quad.BR.x * sx, y: quad.BR.y * sy },
            };

            // ── Capture full-res frame for warp ──────────────────────────────
            this._capCanvas.width  = VW;
            this._capCanvas.height = VH;
            this._capCtx.drawImage(this.video, 0, 0, VW, VH);

            // ── Perspective warp → CS×CS canonical view ───────────────────────
            if (!this._warpPerspective(fullQuad, VW, VH)) return;

            const warpedData = this._warpCtx.getImageData(0, 0, CS, CS);

            // ── Calibration ───────────────────────────────────────────────────
            if (this._calibrating) {
                this._accumCalib(warpedData);
                if (this.onDebug) this.onDebug({ screenFound: true, quad: fullQuad, calibrating: true, cvReady: true });
                return;
            }
            if (!this.calibrated) {
                if (this.onDebug) this.onDebug({ screenFound: true, quad: fullQuad, calibrating: false, cvReady: true });
                return;
            }

            // ── Sample clock cell ─────────────────────────────────────────────
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

            // ── Sample data cells ─────────────────────────────────────────────
            const cellColors = LO.CANON_CELLS.map(c => {
                const rgb = this._mean(warpedData.data, CS, CS, c.x, c.y, c.hw);
                return this._classify(rgb);
            });

            if (this.onDebug) {
                this.onDebug({
                    screenFound: true,
                    quad: fullQuad,
                    clockState: ckSt,
                    luma: luma.toFixed(1),
                    midLuma: this.clockMidLuma.toFixed(1),
                    cellColors: cellColors.map(c => Framing.COLOR_NAMES[c]),
                    newSymbol,
                    cvReady: true,
                });
            }

            if (newSymbol && this.onNewSymbol) this.onNewSymbol([...cellColors]);
        }

        // ── OpenCV marker detection ──────────────────────────────────────────

        /** Find 4 finder-marker centroids in the current downsampled canvas.
         *  Returns { TL, TR, BL, BR } or null. */
        _findMarkers(W, H) {
            let src = null, gray = null, blur = null, binary = null, closed = null;
            let contours = null, hierarchy = null, kernel = null;
            try {
                const imgData = this._capCtx.getImageData(0, 0, W, H);
                src    = cv.matFromImageData(imgData);
                gray   = new cv.Mat();
                cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

                // Gaussian blur — reduces noise/compression artefacts
                blur   = new cv.Mat();
                cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

                // Otsu threshold + BINARY_INV → dark pixels become white blobs
                binary = new cv.Mat();
                cv.threshold(blur, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

                // Morphological close to fill small holes inside markers
                kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
                closed = new cv.Mat();
                cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);

                // Find external contours
                contours  = new cv.MatVector();
                hierarchy = new cv.Mat();
                cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

                // ── Filter for square-ish blobs ────────────────────────────
                const candidates = [];

                for (let i = 0; i < contours.size(); i++) {
                    const cnt  = contours.get(i);
                    const area = cv.contourArea(cnt);

                    if (area >= this.markerMinArea && area <= this.markerMaxArea) {
                        const rect = cv.boundingRect(cnt);
                        const bboxArea = rect.width * rect.height;
                        const fill     = area / (bboxArea || 1);
                        const asp      = rect.width / (rect.height || 1);
                        const aspInv   = rect.height / (rect.width || 1);

                        if (fill >= this.markerFillMin &&
                            asp >= this.markerAspMin && aspInv >= this.markerAspMin) {
                            // Compute centroid via moments
                            const M   = cv.moments(cnt, false);
                            const cx  = M.m10 / (M.m00 || 1);
                            const cy  = M.m01 / (M.m00 || 1);
                            candidates.push({ x: cx, y: cy, area });
                        }
                    }
                    cnt.delete();
                }

                if (candidates.length < 4) return null;

                // Sort by area descending → take 4 largest (markers are the biggest squares)
                candidates.sort((a, b) => b.area - a.area);

                // If the 4th-largest is much smaller than the 1st, skip (unlikely all 4 are markers)
                // (allow 10× size variation due to perspective foreshortening)
                const top4 = candidates.slice(0, 4);
                const maxA = top4[0].area, minA = top4[3].area;
                if (minA * 10 < maxA) return null;

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

        /** Sort 4 centroids into { TL, TR, BL, BR } by position. */
        _sortCorners(pts) {
            const s   = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
            const TL  = s[0], BR = s[3];
            const mid = [s[1], s[2]].sort((a, b) => a.x - b.x);
            return { TL, TR: mid[1], BL: mid[0], BR };
        }

        // ── Perspective warp ─────────────────────────────────────────────────

        /** Warp the captured frame so that the 4 marker centroids map to the
         *  corners of the CS×CS canonical canvas.  Returns false on error. */
        _warpPerspective(quad, VW, VH) {
            let src = null, srcPts = null, dstPts = null, M = null, dst = null;
            try {
                const imgData = this._capCtx.getImageData(0, 0, VW, VH);
                src = cv.matFromImageData(imgData);

                // Order: TL → TR → BR → BL  (must match dst order)
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

                // Render to internal canvas for pixel sampling
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

        /** Start accumulating calibration frames.
         *  The sender must be showing the calibration colour grid.
         *  @param {() => void} onDone */
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

                // Average each colour cell across all frames
                this.refColors = [0, 1, 2, 3].map(ci => ({
                    r: this._calibSamples.reduce((s, f) => s + f.cells[ci].r, 0) / N,
                    g: this._calibSamples.reduce((s, f) => s + f.cells[ci].g, 0) / N,
                    b: this._calibSamples.reduce((s, f) => s + f.cells[ci].b, 0) / N,
                }));

                // Clock threshold: midpoint between white-cell luma and black-clock luma
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
                this.lastClockState = null;
                this._debounce      = [];

                if (this._calibDone) this._calibDone();
            }
        }

        // ── Pixel helpers ────────────────────────────────────────────────────

        /** Mean RGB in a square patch centred at (cx, cy) with half-width hw. */
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

        /** Nearest-centroid colour classification.
         *  @returns {0|1|2|3}  0=WHITE, 1=RED, 2=GREEN, 3=BLUE */
        _classify(rgb) {
            let minD = Infinity, minI = 0;
            this.refColors.forEach((ref, i) => {
                const d = (rgb.r - ref.r) ** 2 + (rgb.g - ref.g) ** 2 + (rgb.b - ref.b) ** 2;
                if (d < minD) { minD = d; minI = i; }
            });
            return minI;
        }

        /** Reset clock debounce and initialize lastClockState to current clock state to avoid spurious symbol trigger. */
        resetClock() {
            this.lastClockState = 'B'; // Idle/calibration state clock is BLACK
            this._debounce      = [];
        }
    }

    window.PhysicalRX = PhysicalRX;
})();
