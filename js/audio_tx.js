'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// AUDIO TX  —  Web Audio API tone generation
//
// Tones are multi-tone chords for maximum distinguishability:
//   READY:  440 + 554 Hz (A4 + C#5 major third), 800 ms — warm "ding-dong"
//   ACK:   1760 + 2217 Hz (A6 + C#7), 350 ms — bright short chirp
//   NACK:   220 + 277 Hz  (A3 + C#4), 1000 ms — low rumble
//
// Each tone plays two simultaneous sinusoids so they sound like chords,
// making them trivially distinguishable by ear. The detector looks for
// BOTH frequencies co-present to virtually eliminate false positives.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    const TONE_SPECS = Object.freeze({
        READY: { freqs: [440, 554],   dur: 0.80 },
        ACK:   { freqs: [1760, 2217], dur: 0.35 },
        NACK:  { freqs: [220, 277],   dur: 1.00 },
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
            let ended = 0;
            for (const hz of spec.freqs) {
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = hz;
                gain.gain.setValueAtTime(0.55, t0);
                gain.gain.exponentialRampToValueAtTime(0.001, t0 + spec.dur);
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
