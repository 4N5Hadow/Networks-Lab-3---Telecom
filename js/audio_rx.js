'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// AUDIO RX  —  Chord-based tone detection via FFT
//
// Each tone is a TWO-frequency chord. Detection requires BOTH frequencies
// to be above threshold simultaneously, which dramatically reduces false
// positives from ambient noise or harmonics.
//
// Detection parameters:
//   fftSize     = 8192  (~5.4 Hz/bin at 44.1 kHz)
//   bandHz      = 40    (±40 Hz detection window per frequency)
//   threshold   = -45 dBFS absolute
//   snrDb       = 12 dB above noise floor per frequency
//   cooldown    = 600 ms
//   debounce    = 2 consecutive polls (~120ms) must agree before firing
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    // Must match AudioTX.TONE_SPECS. Frequencies were changed from the
    // original 440/554, 1760/2217, 220/277 because those were literally
    // the same two notes 3 octaves apart — speaker harmonic distortion
    // made NACK's 2nd harmonic land on READY, and READY's 4th harmonic
    // land on ACK, causing phantom detections. See audio_tx.js for detail.
    const CHORD_TONES = Object.freeze([
        { name: 'READY', freqs: [520, 660]   },
        { name: 'ACK',   freqs: [2150, 2650] },
        { name: 'NACK',  freqs: [300, 380]   },
    ]);
    const BAND_HZ = 40;
    const DEBOUNCE_POLLS = 2; // require this many consecutive polls agreeing

    class AudioRX {
        constructor() {
            this._ctx      = null;
            this._analyser = null;
            this._stream   = null;
            this.running   = false;
            this.threshold = -45;   // dBFS
            this.snrDb     = 12;    // dB above noise floor
            this.cooldown  = 600;   // ms
            this._lastFire = 0;
            this._timer    = null;
            this._pendingTone  = null;  // tone currently accumulating debounce
            this._pendingCount = 0;
            /** @type {((name: string) => void)|null} */
            this.onTone    = null;
            /** @type {((info: object) => void)|null}
             *  Debug callback, fired every poll with per-tone energy info */
            this.onDebugPoll = null;
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
                this._analyser.smoothingTimeConstant = 0.4;
                src.connect(this._analyser);
                this.running = true;
                this._timer  = setInterval(() => this._poll(), 60);
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
            const bandBins = Math.ceil(BAND_HZ / hzPerBin);

            // Noise floor: average over spectrum
            let noiseSum = 0;
            for (let i = 0; i < binCount; i++) noiseSum += buf[i];
            const noiseFloor = noiseSum / binCount;

            const debugInfo = {};
            let bestName = null, bestMargin = -Infinity;

            // Evaluate ALL tones every poll (instead of stopping at the
            // first pass). If more than one tone's band happens to pass in
            // the same poll — e.g. from a harmonic or transient — we pick
            // the one with the strongest SNR margin rather than whichever
            // happened to be listed first in CHORD_TONES.
            for (const { name, freqs } of CHORD_TONES) {
                let allPass = true;
                let minMargin = Infinity;
                const peaks = [];

                for (const hz of freqs) {
                    const c  = Math.round(hz / hzPerBin);
                    const lo = Math.max(0, c - bandBins);
                    const hi = Math.min(binCount - 1, c + bandBins);

                    let peak = -300;
                    for (let b = lo; b <= hi; b++) {
                        if (buf[b] > peak) peak = buf[b];
                    }
                    peaks.push(peak);

                    const margin = peak - noiseFloor;
                    if (peak < this.threshold || margin < this.snrDb) allPass = false;
                    if (margin < minMargin) minMargin = margin;
                }

                debugInfo[name] = {
                    peaks: peaks.map(p => p.toFixed(1)),
                    noise: noiseFloor.toFixed(1),
                    pass: allPass,
                };

                if (allPass && minMargin > bestMargin) {
                    bestMargin = minMargin;
                    bestName   = name;
                }
            }

            if (this.onDebugPoll) this.onDebugPoll(debugInfo);

            // Temporal debounce: a single noisy poll (transient click,
            // harmonic spike, ambient sound) shouldn't be enough to fire a
            // detection. Require the SAME best tone to win on
            // DEBOUNCE_POLLS consecutive polls (~120ms at the 60ms poll
            // interval) before accepting it. A real tone is held for
            // 350-1000ms so this costs negligible latency.
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
