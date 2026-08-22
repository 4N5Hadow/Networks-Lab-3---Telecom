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
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    // Must match AudioTX.TONE_SPECS
    const CHORD_TONES = Object.freeze([
        { name: 'READY', freqs: [440, 554]   },
        { name: 'ACK',   freqs: [1760, 2217] },
        { name: 'NACK',  freqs: [220, 277]   },
    ]);
    const BAND_HZ = 40;

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

            for (const { name, freqs } of CHORD_TONES) {
                let allPass = true;
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

                    if (peak < this.threshold || (peak - noiseFloor) < this.snrDb) {
                        allPass = false;
                    }
                }

                debugInfo[name] = {
                    peaks: peaks.map(p => p.toFixed(1)),
                    noise: noiseFloor.toFixed(1),
                    pass: allPass,
                };

                if (allPass) {
                    const now = Date.now();
                    if (now - this._lastFire > this.cooldown) {
                        this._lastFire = now;
                        if (this.onDebugPoll) this.onDebugPoll(debugInfo);
                        if (this.onTone) this.onTone(name);
                    }
                    return;
                }
            }

            if (this.onDebugPoll) this.onDebugPoll(debugInfo);
        }
    }

    window.AudioRX = AudioRX;
})();
