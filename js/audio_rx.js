'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// AUDIO RX  —  Tone detection via Web Audio AnalyserNode FFT
//
// Detection algorithm (two-gate):
//   1. Peak energy inside a ±BAND_HZ window around each target frequency
//      must exceed `threshold` (absolute dBFS gate).
//   2. That peak must also exceed the current noise floor by at least
//      `snrDb` dB (SNR gate). This rejects ambient noise that happens
//      to hit the absolute threshold but is not a clean tone.
//
// fftSize = 16384 → ~2.7 Hz/bin at 44.1 kHz, resolving 700 / 1600 / 2500 Hz
// without ambiguity; the ±60 Hz band = ±22 bins, giving robust detection
// even with a slightly off-pitch speaker.
//
// Cooldown = 800 ms prevents double-fires from echo/reverb.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    const TONES = Object.freeze([
        { name: 'READY', hz:  700 },
        { name: 'ACK',   hz: 1600 },
        { name: 'NACK',  hz: 2500 },
    ]);
    const BAND_HZ = 60;    // ±Hz detection window
    const SNR_DB  = 18;    // dB above noise floor required

    class AudioRX {
        constructor() {
            this._ctx      = null;
            this._analyser = null;
            this._stream   = null;
            this.running   = false;
            /** Absolute dBFS floor — raise to reduce sensitivity, lower to increase. */
            this.threshold = -40;
            /** Minimum dB above noise mean. Raise if false positives occur. */
            this.snrDb     = SNR_DB;
            this.cooldown  = 800;   // ms
            this._lastFire = 0;
            this._timer    = null;
            /** @type {((name: string) => void) | null} */
            this.onTone    = null;
        }

        /** Request microphone access and start polling every 80 ms.
         *  @returns {Promise<boolean>} */
        async start() {
            try {
                this._stream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                this._ctx      = new (window.AudioContext || window.webkitAudioContext)();
                const src      = this._ctx.createMediaStreamSource(this._stream);
                this._analyser = this._ctx.createAnalyser();
                this._analyser.fftSize = 16384;   // high resolution
                this._analyser.smoothingTimeConstant = 0.5;
                src.connect(this._analyser);
                this.running = true;
                this._timer  = setInterval(() => this._poll(), 80);
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

        /** Adjust absolute sensitivity threshold (dBFS).
         *  @param {number} dbfs  e.g. -50 (more sensitive) or -30 (less sensitive) */
        setThreshold(dbfs) { this.threshold = dbfs; }

        _poll() {
            if (!this._analyser) return;
            const binCount = this._analyser.frequencyBinCount;
            const buf      = new Float32Array(binCount);
            this._analyser.getFloatFrequencyData(buf);

            const sr       = this._ctx.sampleRate;
            const fftSz    = this._analyser.fftSize;
            const hzPerBin = sr / fftSz;
            const bandBins = Math.ceil(BAND_HZ / hzPerBin);

            // Noise floor: mean of all bins (dBFS)
            let noiseSum = 0;
            for (let i = 0; i < binCount; i++) noiseSum += buf[i];
            const noiseFloor = noiseSum / binCount;

            for (const { name, hz } of TONES) {
                const c  = Math.round(hz / hzPerBin);
                const lo = Math.max(0, c - bandBins);
                const hi = Math.min(binCount - 1, c + bandBins);

                // Peak energy in the ±BAND_HZ window
                let peak = -300;
                for (let b = lo; b <= hi; b++) {
                    if (buf[b] > peak) peak = buf[b];
                }

                // Gate 1: absolute threshold
                // Gate 2: SNR above noise floor
                if (peak > this.threshold && (peak - noiseFloor) > this.snrDb) {
                    const now = Date.now();
                    if (now - this._lastFire > this.cooldown) {
                        this._lastFire = now;
                        if (this.onTone) this.onTone(name);
                    }
                    return;  // only report the first matching tone per poll
                }
            }
        }
    }

    window.AudioRX = AudioRX;
})();
