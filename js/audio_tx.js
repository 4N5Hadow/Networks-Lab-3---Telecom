'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// AUDIO TX  —  Web Audio API dual-tone chord generator
//
// Frequencies are matched to AudioRX:
//   READY:  1150 + 1450 Hz, 450 ms
//   ACK:    1750 + 2150 Hz, 350 ms
//   NACK:   2550 + 2950 Hz, 450 ms
//
// These frequencies sit above human voice fundamentals and room rumble
// without harmonic collisions, and provide crisp dual-tone acoustic signaling.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    const TONE_SPECS = Object.freeze({
        READY: { freqs: [1150, 1450], dur: 0.45 },
        ACK:   { freqs: [1750, 2150], dur: 0.35 },
        NACK:  { freqs: [2550, 2950], dur: 0.45 },
    });
    let _ctx = null;

    function _getCtx() {
        if (!_ctx || _ctx.state === 'closed') {
            _ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        return _ctx;
    }

    /** Play a chord tone.  @returns {Promise<void>} */
    async function playTone(type) {
        const spec = TONE_SPECS[type];
        if (!spec) return;
        const ctx = _getCtx();
        if (ctx.state === 'suspended') {
            try { await ctx.resume(); } catch (_) {}
        }

        return new Promise(resolve => {
            const t0 = ctx.currentTime;
            const ATTACK  = 0.015;                          // 15ms fade-in
            const RELEASE = Math.min(0.04, spec.dur * 0.15); // 40ms fade-out
            let ended = 0;

            for (const hz of spec.freqs) {
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = hz;

                // Smooth linear attack and release to eliminate broadband switching clicks
                gain.gain.setValueAtTime(0.0001, t0);
                gain.gain.linearRampToValueAtTime(0.50, t0 + ATTACK);
                gain.gain.setValueAtTime(0.50, t0 + spec.dur - RELEASE);
                gain.gain.linearRampToValueAtTime(0.0001, t0 + spec.dur);

                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(t0);
                osc.stop(t0 + spec.dur + 0.05);
                osc.onended = () => {
                    ended++;
                    if (ended >= spec.freqs.length) resolve();
                };
            }
        });
    }

    window.AudioTX = { playTone, TONE_SPECS };
})();
