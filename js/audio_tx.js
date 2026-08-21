'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// AUDIO TX  —  Web Audio API tone generation
//
// Frequencies are non-harmonic so that playing one tone cannot produce
// a partial/harmonic that falls in another tone's detection band:
//   READY:  700 Hz, 600 ms  — mid pitch, comfortable "ding"
//   ACK:   1600 Hz, 400 ms  — high pitch, short "success" blip
//   NACK:  2500 Hz, 850 ms  — very high, longer "error" buzz
//
// Non-harmonic check (no octave/fifth relationships):
//   700 harmonics  → 1400, 2100, 2800, ...  (none land on 1600 or 2500) ✓
//   1600 harmonics → 3200, 4800, ...         (none land on 700 or 2500) ✓
//   2500 harmonics → 5000, ...               (none land on 700 or 1600) ✓
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    const TONE_SPECS = Object.freeze({
        READY: { hz:  700, dur: 0.60 },
        ACK:   { hz: 1600, dur: 0.40 },
        NACK:  { hz: 2500, dur: 0.85 },
    });
    const FADE = 0.04;   // s — exponential tail to prevent clicks
    let _ctx   = null;

    function _getCtx() {
        if (!_ctx || _ctx.state === 'closed') {
            _ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (_ctx.state === 'suspended') _ctx.resume();
        return _ctx;
    }

    /** Play a tone and resolve when the oscillator stops.
     *  @param {'READY'|'ACK'|'NACK'} type
     *  @returns {Promise<void>}
     */
    function playTone(type) {
        return new Promise(resolve => {
            const spec = TONE_SPECS[type];
            if (!spec) { resolve(); return; }
            const ctx = _getCtx();
            const t0  = ctx.currentTime;

            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = 'sine';
            osc.frequency.value = spec.hz;
            gain.gain.setValueAtTime(0.80, t0);
            gain.gain.exponentialRampToValueAtTime(0.001, t0 + spec.dur);

            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(t0);
            osc.stop(t0 + spec.dur + FADE);
            osc.onended = resolve;
        });
    }

    // FREQS as { READY: hz, ACK: hz, NACK: hz } — consumed by AudioRX and debug page
    const FREQS = Object.freeze(
        Object.fromEntries(Object.entries(TONE_SPECS).map(([k, v]) => [k, v.hz]))
    );

    window.AudioTX = { playTone, FREQS, TONE_SPECS };
})();
