'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// AUDIO TX  —  Web Audio API tone generation
//
// Tones are multi-tone chords for maximum distinguishability:
//   READY:  520 + 660 Hz, 800 ms — warm "ding-dong"
//   ACK:   2150 + 2650 Hz, 350 ms — bright short chirp
//   NACK:   300 + 380 Hz, 1000 ms — low rumble
//
// IMPORTANT — these frequencies were chosen to avoid harmonic overlap.
// The ORIGINAL set (440/554, 1760/2217, 220/277) were literally the same
// two musical notes three octaves apart (A3/C#4, A4/C#5, A6/C#7). Real
// speakers are non-linear and always emit some energy at 2×, 3×, 4× the
// fundamental they're asked to play. Because of the octave relationship,
// NACK's 2nd harmonic (440/554) landed exactly on READY's tone, and
// READY's 4th harmonic (1760/2216) landed almost exactly on ACK's tone.
// That's why tones could appear to be "heard" even when not played. The
// frequencies below are spaced so that no low-order harmonic (up to 4×)
// of one tone's frequencies falls within the detector's ±40 Hz band of
// another tone's frequencies.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    const TONE_SPECS = Object.freeze({
        READY: { freqs: [520, 660],   dur: 0.80 },
        ACK:   { freqs: [2150, 2650], dur: 0.35 },
        NACK:  { freqs: [300, 380],   dur: 1.00 },
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
            const ATTACK  = 0.01;                    // 10ms fade-in
            const RELEASE = Math.min(0.05, spec.dur * 0.2); // fade-out, capped
            let ended = 0;
            for (const hz of spec.freqs) {
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = hz;

                // Ramped attack/release instead of a hard step. A hard
                // on/off step is a broadband click (energy smeared across
                // the whole spectrum) which can spuriously nudge OTHER
                // tones' frequency bands above threshold, especially on
                // cheap/small speakers. A short linear ramp keeps the
                // energy concentrated at the intended frequency.
                gain.gain.setValueAtTime(0.0001, t0);
                gain.gain.linearRampToValueAtTime(0.55, t0 + ATTACK);
                gain.gain.setValueAtTime(0.55, t0 + spec.dur - RELEASE);
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
