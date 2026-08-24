'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// AUDIO RX  —  Ultra-robust Dual-Tone Chord Detection via FFT
//
// Noise-rejection strategy:
//   1. Local Spectral Prominence: Measures the contrast between the target
//      frequency peak and its immediate adjacent guard bands (±45..150 Hz).
//      Broadband noise (speech, typing, coughing, room noise) elevates the
//      entire band together, yielding near-zero prominence (< 5 dB).
//      Pure sine tones produce a sharp, high prominence (>= 12 dB).
//   2. Dual-Tone Co-occurrence: BOTH frequencies in the chord must simultaneously
//      exceed the absolute threshold and local prominence.
//   3. Twist / Balance Check: Both tone components must have comparable energy
//      (|P1 - P2| <= 9 dB).
//   4. Multi-poll Debouncing: Requires 4 consecutive agreeing polls (~160ms) of
//      sustained tone before firing, filtering out transient clicks and speech.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    const CHORD_TONES = Object.freeze([
        { name: 'READY', freqs: [1150, 1450] },
        { name: 'ACK',   freqs: [1750, 2150] },
        { name: 'NACK',  freqs: [2550, 2950] },
    ]);

    const TARGET_BAND_HZ = 25;   // ±25 Hz around target frequency
    const GUARD_MIN_HZ   = 45;   // guard band starts 45 Hz away from target
    const GUARD_MAX_HZ   = 150;  // guard band extends to 150 Hz away
    const DEBOUNCE_POLLS = 4;    // 4 consecutive polls (~160ms) required

    class AudioRX {
        constructor() {
            this._ctx      = null;
            this._analyser = null;
            this._stream   = null;
            this.running   = false;

            // Tuning parameters
            this.threshold       = -46;  // dBFS absolute minimum peak power
            this.minProminenceDb = 12;   // dB above immediate local guard bands
            this.maxTwistDb      = 9;    // max allowable power difference between chord freqs
            this.cooldown        = 500;  // ms between valid tone triggers

            this._lastFire     = 0;
            this._timer        = null;
            this._pendingTone  = null;
            this._pendingCount = 0;

            /** @type {((name: string) => void)|null} */
            this.onTone        = null;
            /** @type {((info: object) => void)|null} */
            this.onDebugPoll   = null;
        }

        async start() {
            try {
                let stream = null;
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false,
                        },
                        video: false,
                    });
                } catch (_) {
                    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                }
                this._stream   = stream;
                this._ctx      = new (window.AudioContext || window.webkitAudioContext)();
                if (this._ctx.state === 'suspended') {
                    try { await this._ctx.resume(); } catch (_) {}
                }
                const src      = this._ctx.createMediaStreamSource(this._stream);
                this._analyser = this._ctx.createAnalyser();
                this._analyser.fftSize = 8192;
                this._analyser.smoothingTimeConstant = 0.35;
                src.connect(this._analyser);
                this.running = true;
                this._timer  = setInterval(() => this._poll(), 40);
                return true;
            } catch (e) {
                console.warn('[AudioRX] start failed:', e.message);
                return false;
            }
        }

        stop() {
            this.running = false;
            if (this._timer)  { clearInterval(this._timer); this._timer = null; }
            if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); }
            if (this._ctx)    { this._ctx.close().catch(() => {}); }
        }

        _poll() {
            if (!this._analyser || !this._ctx) return;
            const binCount = this._analyser.frequencyBinCount;
            const buf      = new Float32Array(binCount);
            this._analyser.getFloatFrequencyData(buf);

            const sr       = this._ctx.sampleRate;
            const fftSz    = this._analyser.fftSize;
            const hzPerBin = sr / fftSz;

            const targetBins = Math.max(1, Math.ceil(TARGET_BAND_HZ / hzPerBin));
            const guardMinB  = Math.max(1, Math.ceil(GUARD_MIN_HZ / hzPerBin));
            const guardMaxB  = Math.max(2, Math.ceil(GUARD_MAX_HZ / hzPerBin));

            const debugInfo = {};
            let bestName = null, bestScore = -Infinity;

            for (const { name, freqs } of CHORD_TONES) {
                let allPass = true;
                const peaks = [];
                const prominences = [];

                for (const hz of freqs) {
                    const c = Math.round(hz / hzPerBin);

                    // Peak inside target window
                    const tLo = Math.max(0, c - targetBins);
                    const tHi = Math.min(binCount - 1, c + targetBins);
                    let peak = -300;
                    for (let b = tLo; b <= tHi; b++) {
                        if (buf[b] > peak) peak = buf[b];
                    }
                    peaks.push(peak);

                    // Local noise floor from adjacent guard bands (excluding target window)
                    let guardSum = 0, guardCount = 0;
                    // Lower guard band
                    const gLo1 = Math.max(0, c - guardMaxB);
                    const gHi1 = Math.max(0, c - guardMinB);
                    for (let b = gLo1; b <= gHi1; b++) { guardSum += buf[b]; guardCount++; }

                    // Upper guard band
                    const gLo2 = Math.min(binCount - 1, c + guardMinB);
                    const gHi2 = Math.min(binCount - 1, c + guardMaxB);
                    for (let b = gLo2; b <= gHi2; b++) { guardSum += buf[b]; guardCount++; }

                    const localNoise = guardCount > 0 ? (guardSum / guardCount) : -100;
                    const prominence = peak - localNoise;
                    prominences.push(prominence);

                    // Check criteria per frequency
                    if (peak < this.threshold || prominence < this.minProminenceDb) {
                        allPass = false;
                    }
                }

                // Check twist / power balance between the two chord frequencies
                const twist = Math.abs(peaks[0] - peaks[1]);
                if (twist > this.maxTwistDb) {
                    allPass = false;
                }

                const minProm = Math.min(...prominences);
                const avgPeak = (peaks[0] + peaks[1]) / 2;
                const score   = minProm + (avgPeak / 10);

                debugInfo[name] = {
                    peaks:       peaks.map(p => p.toFixed(1)),
                    prominences: prominences.map(pr => pr.toFixed(1)),
                    twist:       twist.toFixed(1),
                    pass:        allPass,
                };

                if (allPass && score > bestScore) {
                    bestScore = score;
                    bestName  = name;
                }
            }

            if (this.onDebugPoll) this.onDebugPoll(debugInfo);

            // Multi-poll temporal debouncing
            if (bestName && bestName === this._pendingTone) {
                this._pendingCount++;
            } else {
                this._pendingTone  = bestName;
                this._pendingCount = bestName ? 1 : 0;
            }

            if (bestName && this._pendingCount >= DEBOUNCE_POLLS) {
                const now = Date.now();
                if (now - this._lastFire > this.cooldown) {
                    this._lastFire     = now;
                    this._pendingTone  = null;
                    this._pendingCount = 0;
                    if (this.onTone) this.onTone(bestName);
                }
            }
        }
    }

    window.AudioRX = AudioRX;
})();
