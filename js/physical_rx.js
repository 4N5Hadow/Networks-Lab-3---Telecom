'use strict';
(function () {
    const LO = window.LAYOUT;
    const CS = LO.CANON_SIZE;

    class PhysicalRX {
        constructor(video) {
            this.video   = video;
            this.running = false;

            this.calibrated   = false;
            this.refColors    = null;
            this.clockMidLuma = 128;

            this.lastClockState  = 'B';
            this._debounce       = [];
            this.K               = 3;
            this._symbolCooldown = 0;
            this.COOLDOWN_FRAMES = 4;

            this.DS_W = 640;

            this._capCanvas    = document.createElement('canvas');
            this._capCtx       = this._capCanvas.getContext('2d', { willReadFrequently: true });
            this._warpCanvas   = Object.assign(document.createElement('canvas'), { width: CS, height: CS });
            this._warpCtx      = this._warpCanvas.getContext('2d', { willReadFrequently: true });
            this._binaryCanvas = document.createElement('canvas');
            this._binaryCtx    = this._binaryCanvas.getContext('2d', { willReadFrequently: true });

            this._calibrating  = false;
            this._calibSamples = [];
            this._calibDone    = null;

            this._stream = null;
            this._raf    = null;

            this._lastQuad           = null;
            this._lostQuadFrames     = 0;
            this._MAX_LOST_FRAMES    = 3;
            this._lastWarpOk         = false;
            this._lastCandidateCount = 0;
            this._lastFps            = 0;
            this._lastFrameTime      = performance.now();

            this.onNewSymbol = null;
            this.onDebug     = null;
        }

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
                this._lastFrameTime = performance.now();
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

        getWarpedCanvas() {
            return this._lastWarpOk ? this._warpCanvas : null;
        }

        getBinaryCanvas() {
            return this._binaryCanvas;
        }

        _loop() {
            if (!this.running) return;
            this._raf = requestAnimationFrame(() => this._loop());
            if (this.video.readyState < 2) return;
            if (!window._cvReady) {
                if (this.onDebug) this.onDebug({ screenFound: false, cvReady: false });
                return;
            }

            const now = performance.now();
            const dt = now - this._lastFrameTime;
            this._lastFrameTime = now;
            this._lastFps = dt > 0 ? Math.round(1000 / dt) : 0;

            try { this._processFrame(); }
            catch (e) { console.error('[PhysicalRX] frame error:', e); }
        }

        _processFrame() {
            const VW = this.video.videoWidth, VH = this.video.videoHeight;
            if (!VW || !VH) return;

            const dsH = Math.round(this.DS_W * VH / VW);
            this._capCanvas.width  = this.DS_W;
            this._capCanvas.height = dsH;
            this._capCtx.drawImage(this.video, 0, 0, this.DS_W, dsH);

            const quad = this._findMarkers(this.DS_W, dsH);

            let activeQuad = null;
            if (quad) {
                const sx = VW / this.DS_W, sy = VH / dsH;
                const fullQuad = {
                    TL: { x: quad.TL.x * sx, y: quad.TL.y * sy },
                    TR: { x: quad.TR.x * sx, y: quad.TR.y * sy },
                    BL: { x: quad.BL.x * sx, y: quad.BL.y * sy },
                    BR: { x: quad.BR.x * sx, y: quad.BR.y * sy },
                };

                if (this._lastQuad) {
                    const a = 0.55, b = 1 - a;
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
                this._lostQuadFrames++;
                activeQuad = this._lastQuad;
            } else {
                this._lastQuad      = null;
                this._lastWarpOk    = false;
                if (this.onDebug) this.onDebug({
                    screenFound: false, cvReady: true,
                    candidateCount: this._lastCandidateCount || 0,
                    fps: this._lastFps,
                });
                return;
            }

            this._capCanvas.width  = VW;
            this._capCanvas.height = VH;
            this._capCtx.drawImage(this.video, 0, 0, VW, VH);

            if (!this._warpPerspective(activeQuad, VW, VH)) {
                this._lastWarpOk = false;
                return;
            }
            this._lastWarpOk = true;

            const warpedData = this._warpCtx.getImageData(0, 0, CS, CS);

            if (this._calibrating) {
                this._accumCalib(warpedData);
                if (this.onDebug) this.onDebug({
                    screenFound: true, quad: activeQuad, calibrating: true, cvReady: true,
                    calibProgress: this._calibSamples.length,
                    candidateCount: this._lastCandidateCount || 4,
                    fps: this._lastFps,
                });
                return;
            }

            const ck    = LO.CANON_CLOCK;
            const ckRgb = this._trimmedMean(warpedData.data, CS, CS, ck.x, ck.y, ck.hw);
            const luma  = 0.299 * ckRgb.r + 0.587 * ckRgb.g + 0.114 * ckRgb.b;
            const hyst  = 6;
            let ckSt    = this.lastClockState;
            if (this.lastClockState === 'B') {
                if (luma > this.clockMidLuma + hyst) ckSt = 'W';
            } else {
                if (luma < this.clockMidLuma - hyst) ckSt = 'B';
            }

            if (this._symbolCooldown > 0) this._symbolCooldown--;

            const rawCellRgb = LO.CANON_CELLS.map(c =>
                this._trimmedMean(warpedData.data, CS, CS, c.x, c.y, c.hw));
            const cellColors = rawCellRgb.map(rgb => this._classify(rgb));

            let newSymbol = false;
            this._debounce.push(ckSt);
            if (this._debounce.length > this.K) this._debounce.shift();

            const debounceAllSame = this._debounce.length === this.K &&
                                    this._debounce.every(s => s === this._debounce[0]);
            const clockTransition = debounceAllSame &&
                                    this._debounce[0] !== this.lastClockState &&
                                    this._symbolCooldown === 0;

            if (clockTransition) {
                this.lastClockState  = this._debounce[0];
                this._debounce       = [];
                this._symbolCooldown = this.COOLDOWN_FRAMES;
                newSymbol            = true;
            }

            if (this.onDebug) {
                this.onDebug({
                    screenFound: true,
                    quad: activeQuad,
                    clockState: ckSt,
                    luma: luma.toFixed(1),
                    midLuma: this.clockMidLuma.toFixed(1),
                    cellColors: cellColors.map(c => Framing.COLOR_NAMES[c]),
                    cellRgb: rawCellRgb.map(c => `(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`),
                    rawCellRgb,
                    newSymbol,
                    cvReady: true,
                    candidateCount: this._lastCandidateCount || 4,
                    fps: this._lastFps,
                    cooldown: this._symbolCooldown,
                });
            }

            if (newSymbol && this.onNewSymbol) this.onNewSymbol([...cellColors]);
        }

        _findMarkers(W, H) {
            let src = null, rgb = null;
            let rCh = null, gCh = null, bCh = null, rgbChans = null;
            let diffRG = null, diffBG = null, maskRG = null, maskBG = null;
            let maskR = null, maskB = null, mask = null, closed = null, kernel = null;
            let gray = null, blur = null, binary = null;
            let contours = null, hierarchy = null;
            this._lastCandidateCount = 0;

            try {
                const imgData = this._capCtx.getImageData(0, 0, W, H);
                src = cv.matFromImageData(imgData);

                rgb = new cv.Mat();
                cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);

                rgbChans = new cv.MatVector();
                cv.split(rgb, rgbChans);
                rCh = rgbChans.get(0);
                gCh = rgbChans.get(1);
                bCh = rgbChans.get(2);

                diffRG = new cv.Mat();
                diffBG = new cv.Mat();
                cv.subtract(rCh, gCh, diffRG);
                cv.subtract(bCh, gCh, diffBG);

                maskRG = new cv.Mat();
                maskBG = new cv.Mat();
                maskR  = new cv.Mat();
                maskB  = new cv.Mat();
                cv.threshold(diffRG, maskRG, 25, 255, cv.THRESH_BINARY);
                cv.threshold(diffBG, maskBG, 25, 255, cv.THRESH_BINARY);
                cv.threshold(rCh,    maskR,  70, 255, cv.THRESH_BINARY);
                cv.threshold(bCh,    maskB,  70, 255, cv.THRESH_BINARY);

                mask = new cv.Mat();
                cv.bitwise_and(maskRG, maskBG, mask);
                cv.bitwise_and(mask,   maskR,  mask);
                cv.bitwise_and(mask,   maskB,  mask);

                kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
                closed = new cv.Mat();
                cv.morphologyEx(mask, closed, cv.MORPH_CLOSE, kernel);

                this._binaryCanvas.width  = W;
                this._binaryCanvas.height = H;
                cv.imshow(this._binaryCanvas, closed);

                contours  = new cv.MatVector();
                hierarchy = new cv.Mat();
                cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

                let candidates = this._extractCandidates(contours, W, H);

                if (candidates.length < 4) {
                    gray = new cv.Mat();
                    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
                    blur = new cv.Mat();
                    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
                    binary = new cv.Mat();
                    const blockSize = Math.max(15, (Math.round(W / 25) | 1));
                    cv.adaptiveThreshold(blur, binary, 255,
                        cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, blockSize, 10);

                    const kernel2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
                    const closed2 = new cv.Mat();
                    cv.morphologyEx(binary, closed2, cv.MORPH_CLOSE, kernel2);

                    contours.delete(); hierarchy.delete();
                    contours  = new cv.MatVector();
                    hierarchy = new cv.Mat();
                    cv.findContours(closed2, contours, hierarchy,
                        cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
                    closed2.delete(); kernel2.delete();

                    const candidates2 = this._extractCandidates(contours, W, H);
                    if (candidates2.length > candidates.length) candidates = candidates2;
                }

                this._lastCandidateCount = candidates.length;
                if (candidates.length < 4) return null;

                return this._selectBestQuad(candidates, W, H);

            } catch (e) {
                console.warn('[PhysicalRX] findMarkers:', e.message);
                return null;
            } finally {
                src?.delete(); rgb?.delete();
                rgbChans?.delete(); rCh?.delete(); gCh?.delete(); bCh?.delete();
                diffRG?.delete(); diffBG?.delete(); maskRG?.delete(); maskBG?.delete();
                maskR?.delete(); maskB?.delete();
                mask?.delete(); closed?.delete(); kernel?.delete();
                gray?.delete(); blur?.delete(); binary?.delete();
                contours?.delete(); hierarchy?.delete();
            }
        }

        _extractCandidates(contours, W, H) {
            const imgArea = W * H;
            const minArea = imgArea * 0.0003;
            const maxArea = imgArea * 0.08;
            const candidates = [];

            for (let i = 0; i < contours.size(); i++) {
                const cnt  = contours.get(i);
                const area = cv.contourArea(cnt);

                if (area >= minArea && area <= maxArea) {
                    const peri   = cv.arcLength(cnt, true);
                    const approx = new cv.Mat();
                    cv.approxPolyDP(cnt, approx, 0.05 * peri, true);

                    const rect     = cv.boundingRect(cnt);
                    const bboxArea = rect.width * rect.height;
                    const fill     = area / (bboxArea || 1);
                    const asp      = Math.min(rect.width, rect.height) /
                                     (Math.max(rect.width, rect.height) || 1);

                    const isQuadLike = approx.rows >= 4 && approx.rows <= 6;

                    if (isQuadLike && fill >= 0.55 && asp >= 0.50) {
                        const M = cv.moments(cnt, false);
                        if (M.m00 > 0) {
                            candidates.push({
                                x: M.m10 / M.m00,
                                y: M.m01 / M.m00,
                                area,
                                w: rect.width,
                                h: rect.height,
                            });
                        }
                    }
                    approx.delete();
                }
                cnt.delete();
            }
            return candidates;
        }

        _selectBestQuad(candidates, W, H) {
            const sorted = candidates.slice().sort((a, b) => b.area - a.area);
            const pool   = sorted.slice(0, 10);
            if (pool.length < 4) return null;

            if (pool.length === 4) {
                const quad = this._sortCorners(pool);
                return (this._isConvexQuad(quad) && this._isValidQuad(quad, W, H)) ? quad : null;
            }

            let bestQuad = null, bestScore = -Infinity;
            const N = pool.length;

            for (let i = 0; i < N - 3; i++) {
                for (let j = i + 1; j < N - 2; j++) {
                    for (let k = j + 1; k < N - 1; k++) {
                        for (let l = k + 1; l < N; l++) {
                            const pts  = [pool[i], pool[j], pool[k], pool[l]];
                            const quad = this._sortCorners(pts);
                            if (!this._isConvexQuad(quad)) continue;
                            if (!this._isValidQuad(quad, W, H)) continue;

                            const topW = Math.hypot(quad.TR.x - quad.TL.x, quad.TR.y - quad.TL.y);
                            const botW = Math.hypot(quad.BR.x - quad.BL.x, quad.BR.y - quad.BL.y);
                            const lftH = Math.hypot(quad.BL.x - quad.TL.x, quad.BL.y - quad.TL.y);
                            const rgtH = Math.hypot(quad.BR.x - quad.TR.x, quad.BR.y - quad.TR.y);

                            const avgW = (topW + botW) / 2;
                            const avgH = (lftH + rgtH) / 2;

                            const aspect = Math.min(avgW, avgH) / Math.max(avgW, avgH);
                            const parW = Math.min(topW, botW) / Math.max(topW, botW);
                            const parH = Math.min(lftH, rgtH) / Math.max(lftH, rgtH);

                            const areas    = pts.map(p => p.area);
                            const maxA     = Math.max(...areas), minA = Math.min(...areas);
                            const areaRatio = minA / (maxA || 1);

                            const quadArea = avgW * avgH;
                            const score = Math.log(quadArea + 1) * 3.0
                                        + aspect    * 5.0
                                        + (parW + parH) * 2.0
                                        + areaRatio * 2.5;

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

        _isValidQuad(quad, W, H) {
            const imgArea = W * H;
            const topW = Math.hypot(quad.TR.x - quad.TL.x, quad.TR.y - quad.TL.y);
            const botW = Math.hypot(quad.BR.x - quad.BL.x, quad.BR.y - quad.BL.y);
            const lftH = Math.hypot(quad.BL.x - quad.TL.x, quad.BL.y - quad.TL.y);
            const rgtH = Math.hypot(quad.BR.x - quad.TR.x, quad.BR.y - quad.TR.y);
            const d1   = Math.hypot(quad.BR.x - quad.TL.x, quad.BR.y - quad.TL.y);
            const d2   = Math.hypot(quad.BL.x - quad.TR.x, quad.BL.y - quad.TR.y);

            const avgW    = (topW + botW) / 2;
            const avgH    = (lftH + rgtH) / 2;
            const quadArea = avgW * avgH;

            if (quadArea < imgArea * 0.005) return false;
            if (quadArea > imgArea * 0.70)  return false;

            const aspect = Math.min(avgW, avgH) / (Math.max(avgW, avgH) || 1);
            if (aspect < 0.40) return false;

            const parW = Math.min(topW, botW) / (Math.max(topW, botW) || 1);
            const parH = Math.min(lftH, rgtH) / (Math.max(lftH, rgtH) || 1);
            if (parW < 0.50 || parH < 0.50) return false;

            const diagRatio = Math.min(d1, d2) / (Math.max(d1, d2) || 1);
            if (diagRatio < 0.55) return false;

            return true;
        }

        _isConvexQuad(quad) {
            if (!quad) return false;
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
            const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
            const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;

            const sortedByAngle = pts.map(p => ({
                p,
                angle: Math.atan2(p.y - cy, p.x - cx),
            })).sort((a, b) => a.angle - b.angle).map(item => item.p);

            let tlIdx = 0, minSum = Infinity;
            for (let i = 0; i < sortedByAngle.length; i++) {
                const sum = sortedByAngle[i].x + sortedByAngle[i].y;
                if (sum < minSum) {
                    minSum = sum;
                    tlIdx = i;
                }
            }

            const Q = [];
            for (let i = 0; i < 4; i++) {
                Q.push(sortedByAngle[(tlIdx + i) % 4]);
            }

            const dx1 = Q[1].x - Q[0].x, dy1 = Q[1].y - Q[0].y;
            const dx2 = Q[3].x - Q[0].x, dy2 = Q[3].y - Q[0].y;
            const cross = dx1 * dy2 - dy1 * dx2;

            let TL, TR, BR, BL;
            if (cross > 0) {
                TL = Q[0]; TR = Q[1]; BR = Q[2]; BL = Q[3];
            } else {
                TL = Q[0]; TR = Q[3]; BR = Q[2]; BL = Q[1];
            }

            return { TL, TR, BR, BL };
        }

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

        startCalibration(onDone) {
            this._calibSamples = [];
            this._calibDone    = onDone;
            this._calibrating  = true;
        }

        _accumCalib(warpedData) {
            const cellSamples = LO.CANON_CELLS.map(c =>
                this._trimmedMean(warpedData.data, CS, CS, c.x, c.y, c.hw));
            const clockSample = this._trimmedMean(warpedData.data, CS, CS,
                LO.CANON_CLOCK.x, LO.CANON_CLOCK.y, LO.CANON_CLOCK.hw);

            this._calibSamples.push({ cells: cellSamples, clock: clockSample });

            if (this._calibSamples.length >= 25) {
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

        _trimmedMean(pixels, W, H, cx, cy, hw) {
            const x0 = Math.max(0, Math.round(cx - hw));
            const x1 = Math.min(W - 1, Math.round(cx + hw));
            const y0 = Math.max(0, Math.round(cy - hw));
            const y1 = Math.min(H - 1, Math.round(cy + hw));
            const samples = [];

            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    const i = (y * W + x) * 4;
                    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
                    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
                    samples.push({ r, g, b, luma });
                }
            }

            if (!samples.length) return { r: 0, g: 0, b: 0 };

            samples.sort((a, b) => a.luma - b.luma);
            const trim = Math.floor(samples.length * 0.08);
            const valid = samples.slice(trim, samples.length - trim);

            let sumR = 0, sumG = 0, sumB = 0;
            for (const s of valid) { sumR += s.r; sumG += s.g; sumB += s.b; }
            const N = valid.length || 1;
            return { r: sumR / N, g: sumG / N, b: sumB / N };
        }

        _classify(rgb) {
            const { r: R, g: G, b: B } = rgb;
            const I = R + G + B || 1;
            const rNorm = R / I, gNorm = G / I, bNorm = B / I;
            const maxVal = Math.max(R, G, B), minVal = Math.min(R, G, B);
            const sat = maxVal > 0 ? (maxVal - minVal) / maxVal : 0;

            if (sat < 0.22 && I > 150) return 0;

            if (rNorm > 0.44 && R > G + 20 && R > B + 20) return 1;
            if (gNorm > 0.40 && G > R + 15 && G > B + 15) return 2;
            if (bNorm > 0.40 && B > R + 15 && B > G + 15) return 3;

            if (this.refColors && this.refColors.length === 4) {
                let bestIdx = 0, bestDist = Infinity;

                for (let i = 0; i < 4; i++) {
                    const ref = this.refColors[i];
                    const refI = ref.r + ref.g + ref.b || 1;
                    const rRef = ref.r / refI, gRef = ref.g / refI, bRef = ref.b / refI;
                    const refMax = Math.max(ref.r, ref.g, ref.b), refMin = Math.min(ref.r, ref.g, ref.b);
                    const refSat = refMax > 0 ? (refMax - refMin) / refMax : 0;

                    const dChroma = (rNorm - rRef) ** 2 + (gNorm - gRef) ** 2 + (bNorm - bRef) ** 2;
                    const dSat = (sat - refSat) ** 2;
                    const dRgb = ((R - ref.r) / 255) ** 2 + ((G - ref.g) / 255) ** 2 + ((B - ref.b) / 255) ** 2;

                    let dist = dChroma * 5.0 + dSat * 2.5 + dRgb * 1.0;

                    if (i === 0 && sat < 0.25) dist *= 0.6;
                    if (i === 1 && rNorm > 0.38 && R > G) dist *= 0.7;
                    if (i === 2 && gNorm > 0.36 && G > R) dist *= 0.7;
                    if (i === 3 && bNorm > 0.36 && B > R) dist *= 0.7;

                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx  = i;
                    }
                }
                return bestIdx;
            }

            if (sat < 0.25) return 0;
            if (R >= G && R >= B) return 1;
            if (G >= R && G >= B) return 2;
            return 3;
        }

        resetClock() {
            this.lastClockState  = 'B';
            this._debounce       = [];
            this._symbolCooldown = 0;
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
