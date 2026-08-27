'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// MAIN — Strict Stop-and-Wait ARQ protocol
//
// Protocol:
//   1. Sender shows calibration frame → Receiver calibrates → sends READY
//   2. For each symbol (0..5):
//      - Sender: toggle clock, display symbol, wait for ACK (strict)
//      - Receiver: detects clock change → reads symbol → plays ACK immediately
//      - Sender hears ACK → 800ms gap → next symbol
//      - Sender timeout (10×RTT) → assume connection broken → restart from SYN
//      - If receiver's ACK is lost, receiver retransmits ACK every 2×RTT
//   3. After all 6 symbols shown:
//      - Sender waits for final ACK/NACK
//      - Receiver decodes → if bit count matches → ACK → DONE
//      - If bit count wrong or parse fails → NACK → full restart from SYN
// ─────────────────────────────────────────────────────────────────────────────
(function () {

    function show(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(id).classList.add('active');
    }

    function log(panelId, msg, type = '') {
        const el = document.getElementById(panelId);
        if (!el) return;
        const line = document.createElement('div');
        line.className = 'log-line' + (type ? ' ' + type : '');
        const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        line.textContent = `[${ts}] ${msg}`;
        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
        while (el.children.length > 80) el.removeChild(el.firstChild);
    }

    function setBadge(id, text, type) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = text;
        el.className   = 'status-badge ' + (type || 'idle');
    }

    function setDot(dotId, stateId, ok, label) {
        const dot = document.getElementById(dotId);
        const st  = document.getElementById(stateId);
        if (dot) dot.className = 'sys-dot ' + (ok === null ? 'loading' : ok ? 'ok' : 'fail');
        if (st)  st.textContent = label;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  HOME
    // ═══════════════════════════════════════════════════════════════════════════
    let _permGranted = false, _cvOk = false;

    function checkUnlock() {
        const ready = _permGranted && _cvOk;
        document.getElementById('btn-role-sender').disabled   = !ready;
        document.getElementById('btn-role-receiver').disabled = !ready;
        if (ready) document.getElementById('perm-gate').classList.add('hidden');
    }

    function initCvStatus() {
        setDot('cv-dot', 'cv-state', null, 'loading');
        if (window._cvReady) {
            _cvOk = true;
            setDot('cv-dot', 'cv-state', true, 'ready');
            checkUnlock();
        }
        document.addEventListener('opencv-ready', () => {
            _cvOk = true;
            setDot('cv-dot', 'cv-state', true, 'ready');
            checkUnlock();
        });
        const poll = setInterval(() => {
            if (window._cvReady) {
                clearInterval(poll);
                if (!_cvOk) {
                    _cvOk = true;
                    setDot('cv-dot', 'cv-state', true, 'ready');
                    checkUnlock();
                }
            }
        }, 500);
    }

    document.getElementById('btn-grant-perms').onclick = async () => {
        const btn  = document.getElementById('btn-grant-perms');
        const hint = document.getElementById('perm-hint');
        btn.disabled = true;
        btn.textContent = 'Requesting…';
        hint.textContent = '';

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            stream.getTracks().forEach(t => t.stop());
            setDot('cam-dot', 'cam-state', true, 'granted');
            setDot('mic-dot', 'mic-state', true, 'granted');
            _permGranted = true;
            hint.textContent = 'Permissions granted';
            hint.style.color = 'var(--success)';
            checkUnlock();
        } catch (e) {
            let camOk = false, micOk = false;
            try {
                const cs = await navigator.mediaDevices.getUserMedia({ video: true });
                cs.getTracks().forEach(t => t.stop()); camOk = true;
            } catch (_) {}
            try {
                const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
                ms.getTracks().forEach(t => t.stop()); micOk = true;
            } catch (_) {}
            setDot('cam-dot', 'cam-state', camOk, camOk ? 'granted' : 'denied');
            setDot('mic-dot', 'mic-state', micOk, micOk ? 'granted' : 'denied');
            if (camOk && micOk) {
                _permGranted = true;
                hint.textContent = 'Permissions granted';
                hint.style.color = 'var(--success)';
                checkUnlock();
            } else {
                btn.disabled = false;
                btn.textContent = 'Grant Camera & Microphone Access';
                hint.textContent = 'Permission denied — enable in browser settings.';
                hint.style.color = 'var(--error)';
            }
        }
    };

    initCvStatus();

    // ═══════════════════════════════════════════════════════════════════════════
    //  SENDER  (Strict Stop-and-Wait — never advances without ACK)
    //
    //  Protocol:
    //    1. Show calibration frame → wait for READY tone
    //    2. For each symbol:
    //       - Toggle clock, display symbol
    //       - Wait for ACK (strict — no advance without it)
    //       - If no ACK for 10×RTT → connection broken → restart from SYN
    //    3. After all symbols sent → wait for final ACK/NACK
    //       - ACK → DONE
    //       - NACK → restart from SYN (receiver detected bit count mismatch)
    //       - Timeout (10×RTT) → restart from SYN
    // ═══════════════════════════════════════════════════════════════════════════
    let TX = null, SARX = null;
    let sState       = 'IDLE';
    let sMsgBits     = [];
    let sErrBit      = null;
    let sRetransmit  = false;
    let sSymbols     = [];       // the 6 encoded symbols
    let sSymIdx      = 0;        // current symbol index being shown
    let sSymTimer    = null;     // per-symbol timeout (10×RTT)
    let sDecodeTimer = null;     // final ACK/NACK timeout

    // RTT estimation
    let sRttEstimate = 2000;     // initial conservative estimate (2 seconds)
    let sSymShowTime = 0;        // timestamp when current symbol was displayed

    // Returns the timeout duration: 10 × RTT, clamped to [5s, 30s]
    function getSenderTimeout() {
        return Math.max(5000, Math.min(30000, 10 * sRttEstimate));
    }

    function initSender() {
        const canvas = document.getElementById('tx-canvas');
        const S = Math.min(window.innerWidth, window.innerHeight) * 0.88;
        canvas.width = canvas.height = Math.floor(S);

        TX   = new PhysicalTX(canvas);
        SARX = new AudioRX();
        TX.drawIdle();

        SARX.onTone = onSenderTone;
        SARX.start().then(ok => {
            log('sender-log', ok
                ? 'Microphone ready — listening for tones.'
                : 'Mic unavailable. ACK/NACK detection disabled.', ok ? '' : 'warn');
        });

        document.getElementById('msg-bits').oninput   = () => { sanitizeBits(); validateSender(); };
        document.getElementById('error-bit').oninput  = validateSender;
        document.getElementById('btn-show-calib').onclick   = onSenderStart;
        document.getElementById('btn-reset-sender').onclick = resetSender;
        document.getElementById('sender-back').onclick      = () => { cleanupSender(); show('screen-role'); };

        document.getElementById('btn-fullscreen').onclick = () => {
            const w = document.getElementById('tx-canvas-wrapper');
            if (!document.fullscreenElement) w.requestFullscreen?.().catch(() => {});
            else document.exitFullscreen?.();
        };

        setSenderState('IDLE');
        validateSender();
        log('sender-log', 'Sender ready. Use fullscreen for best detection.');
    }

    function sanitizeBits() {
        const el = document.getElementById('msg-bits');
        el.value = el.value.replace(/[^01]/g, '').slice(0, 20);
    }

    function validateSender() {
        const bits = document.getElementById('msg-bits').value;
        document.getElementById('btn-show-calib').disabled = !(bits.length > 0 && bits.length <= 20 && sState === 'IDLE');
    }

    function setSenderState(st) {
        sState = st;
        const labels = {
            IDLE:         ['IDLE',              'idle'],
            CALIBRATE:    ['CALIBRATE',         'calib'],
            ENCODE:       ['ENCODE',            'active'],
            TRANSMIT:     ['SENDING SYM',       'active'],
            SYM_GAP:      ['GAP',               'active'],
            AWAIT_DECODE: ['AWAIT DECODE',      'calib'],
            DONE:         ['DONE',              'success'],
        };
        const [text, type] = labels[st] || [st, 'idle'];
        setBadge('sender-status-badge', text, type);
        validateSender();
    }

    function onSenderStart() {
        const bitsStr = document.getElementById('msg-bits').value;
        const errVal  = document.getElementById('error-bit').value.trim();
        sMsgBits    = bitsStr.split('').map(Number);
        sErrBit     = errVal !== '' ? parseInt(errVal, 10) : null;
        sRetransmit = false;
        sRttEstimate = 2000; // reset RTT estimate for new transmission

        if (sErrBit !== null && (sErrBit < 0 || sErrBit >= sMsgBits.length)) {
            alert(`Error bit index ${sErrBit} is out of range (0–${sMsgBits.length - 1})`);
            return;
        }

        log('sender-log', `Message: ${bitsStr}  L=${sMsgBits.length}  error-bit: ${sErrBit ?? 'none'}`);
        showCalibFrame();
    }

    function showCalibFrame() {
        setSenderState('CALIBRATE');
        TX.drawCalibration();
        log('sender-log', 'Calibration frame (SYN) displayed. Waiting for READY tone…');
    }

    // Called when sender hears a tone from the receiver
    function onSenderTone(tone) {
        log('sender-log', `Received tone: ${tone}`);

        switch (sState) {
            case 'CALIBRATE':
                if (tone === 'READY') doEncode();
                break;

            case 'TRANSMIT':
                if (tone === 'ACK') {
                    clearTimeout(sSymTimer);

                    // Update RTT estimate from measured round-trip
                    const measuredRtt = Date.now() - sSymShowTime;
                    if (measuredRtt > 0 && measuredRtt < 30000) {
                        sRttEstimate = 0.7 * sRttEstimate + 0.3 * measuredRtt;
                    }

                    log('sender-log', `  Symbol ${sSymIdx + 1} ACK'd. (RTT=${measuredRtt}ms, est=${Math.round(sRttEstimate)}ms)`, 'success');
                    sSymIdx++;

                    // Enter SYM_GAP: short deaf period so the same ACK tone
                    // isn't detected twice by the mic
                    setSenderState('SYM_GAP');
                    setTimeout(doTransmitNextSymbol, 800);
                }
                break;

            case 'SYM_GAP':
                // DEAF — ignore all tones during the inter-symbol gap.
                // This prevents the previous ACK from being picked up again.
                break;

            case 'AWAIT_DECODE':
                clearTimeout(sDecodeTimer);
                if (tone === 'ACK') {
                    // Receiver decoded successfully
                    setSenderState('DONE');
                    TX.drawIdle();
                    log('sender-log', 'Final ACK — transmission complete!', 'success');
                    setTimeout(() => setSenderState('IDLE'), 3000);
                } else if (tone === 'NACK') {
                    // Receiver says bit count was wrong → full restart
                    log('sender-log', 'NACK — receiver detected mismatch. Full restart from SYN…', 'warn');
                    doFullRestart();
                }
                break;
        }
    }

    function doEncode() {
        setSenderState('ENCODE');
        // On retransmission, don't inject the error again (spec says retransmission has no errors)
        const errBit  = sRetransmit ? null : sErrBit;
        const bits48  = Framing.buildFrame(sMsgBits, errBit);
        sSymbols      = Framing.bitsToSymbols(bits48);
        sSymIdx       = 0;
        log('sender-log', `Encoded ${sSymbols.length} symbols (error@bit ${errBit ?? 'none'})`);
        doTransmitNextSymbol();
    }

    function doTransmitNextSymbol() {
        if (sSymIdx >= sSymbols.length) {
            // All symbols shown → wait for final ACK or NACK from receiver
            setSenderState('AWAIT_DECODE');
            TX.drawIdle();
            const timeout = getSenderTimeout();
            log('sender-log', `All symbols sent. Awaiting final ACK/NACK (timeout=${Math.round(timeout / 1000)}s)…`);
            sDecodeTimer = setTimeout(() => {
                if (sState === 'AWAIT_DECODE') {
                    log('sender-log', 'Final decode timeout — connection broken. Restarting from SYN…', 'warn');
                    doFullRestart();
                }
            }, timeout);
            return;
        }

        setSenderState('TRANSMIT');
        TX.showSymbol(sSymbols[sSymIdx]);
        sSymShowTime = Date.now(); // record when we showed this symbol (for RTT calc)

        const timeout = getSenderTimeout();
        log('sender-log', `Showing symbol ${sSymIdx + 1}/${sSymbols.length}  [${sSymbols[sSymIdx].join(',')}]  timeout=${Math.round(timeout / 1000)}s`);

        // STRICT: if no ACK within 10×RTT, assume connection is broken → restart from SYN
        sSymTimer = setTimeout(() => {
            if (sState === 'TRANSMIT') {
                log('sender-log', `  Symbol ${sSymIdx + 1} — no ACK for ${Math.round(timeout / 1000)}s. Connection broken. Restarting from SYN…`, 'warn');
                doFullRestart();
            }
        }, timeout);
    }

    // Full restart: go back to calibration frame (SYN).
    // This is called when:
    //   - sender times out waiting for an ACK (connection broken)
    //   - receiver sends NACK (bit count mismatch at end)
    function doFullRestart() {
        clearTimeout(sSymTimer);
        clearTimeout(sDecodeTimer);
        sRetransmit = true;
        log('sender-log', '--- FULL RESTART ---', 'warn');
        showCalibFrame();
    }

    function resetSender() {
        clearTimeout(sSymTimer);
        clearTimeout(sDecodeTimer);
        setSenderState('IDLE');
        if (TX) TX.stop();
        TX && TX.drawIdle();
        document.getElementById('sender-log').innerHTML = '';
        sRetransmit  = false;
        sRttEstimate = 2000;
        log('sender-log', 'Reset.');
        validateSender();
    }

    function cleanupSender() {
        clearTimeout(sSymTimer);
        clearTimeout(sDecodeTimer);
        if (TX)   TX.stop();
        if (SARX) SARX.stop();
    }

    document.addEventListener('fullscreenchange', () => {
        if (TX && document.querySelector('#screen-sender.active')) {
            const canvas = document.getElementById('tx-canvas');
            const isFs   = !!document.fullscreenElement;
            const S = isFs
                ? Math.min(window.screen.width, window.screen.height)
                : Math.min(window.innerWidth, window.innerHeight) * 0.88;
            canvas.width = canvas.height = Math.floor(S);
            if (sState === 'CALIBRATE') TX.drawCalibration();
            else TX.drawIdle();
        }
    });

    window.addEventListener('resize', () => {
        if (TX && document.querySelector('#screen-sender.active') && !document.fullscreenElement) {
            const canvas = document.getElementById('tx-canvas');
            const S = Math.min(window.innerWidth, window.innerHeight) * 0.88;
            canvas.width = canvas.height = Math.floor(S);
            if (sState === 'CALIBRATE') TX.drawCalibration();
            else TX.drawIdle();
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  RECEIVER  (Immediate ACK + ACK retransmit + end-of-message NACK)
    //
    //  Protocol:
    //    1. Calibrate → send READY tone → start listening
    //    2. On each clock change (new symbol):
    //       - Read cell colours, accumulate bits
    //       - Send ACK immediately
    //       - Start ACK-retransmit timer: if sender's clock hasn't changed
    //         after 2×RTT, assume our ACK was lost → retransmit ACK
    //    3. After all 6 symbols received (48 bits):
    //       - Parse the frame
    //       - If parse succeeds AND bit count matches → send final ACK → DONE
    //       - If parse fails OR bit count wrong → send NACK → triggers sender
    //         to restart from SYN. Receiver resets and waits for new calibration.
    //    4. No NACK is sent during symbol-by-symbol transmission.
    // ═══════════════════════════════════════════════════════════════════════════
    let RX = null, rState = 'IDLE', rBitBuf = [], rSymCount = 0;
    let _overlayCtx = null;

    // ACK retransmit timer: fires every 2×RTT to re-send ACK if sender hasn't
    // moved to the next symbol (detected by checking clock state hasn't changed)
    let rAckRetransmitTimer = null;
    let rLastSeenClockState = null;   // 'B' or 'W' — the clock state we last ACK'd
    let rRttEstimate        = 2000;   // receiver's RTT estimate (default 2s)
    let rReadyTime          = 0;      // when READY tone was sent (for initial RTT estimate)

    function initReceiver() {
        RX = null; rState = 'IDLE'; rBitBuf = []; rSymCount = 0;
        _overlayCtx = document.getElementById('rx-overlay').getContext('2d');

        document.getElementById('btn-start-camera').onclick   = startCamera;
        document.getElementById('btn-calibrate').onclick      = startCalibration;
        document.getElementById('btn-reset-receiver').onclick = resetReceiver;
        document.getElementById('receiver-back').onclick      = () => { cleanupReceiver(); show('screen-role'); };

        setRxState('IDLE');
        log('receiver-log', 'Receiver ready. Start camera to begin.');
    }

    function setRxState(st) {
        rState = st;
        const labels = {
            IDLE:        ['IDLE',         'idle'],
            'CAMERA ON': ['CAMERA ON',    'active'],
            CALIBRATING: ['CALIBRATING',  'calib'],
            LISTEN:      ['LISTENING',    'active'],
            DONE:        ['DONE',         'success'],
        };
        const [text, type] = labels[st] || [st, 'idle'];
        setBadge('receiver-status-badge', text, type);
    }

    async function startCamera() {
        document.getElementById('btn-start-camera').disabled = true;
        const video = document.getElementById('rx-video');
        RX = new PhysicalRX(video);
        RX.onDebug     = updateDebugPanel;
        RX.onNewSymbol = onNewSymbol;

        const ok = await RX.start();
        if (ok) {
            document.getElementById('btn-calibrate').disabled = false;
            document.getElementById('camera-hint').style.display = 'none';
            setRxState('CAMERA ON');
            log('receiver-log', 'Camera started. Aim at sender screen, then press Calibrate.');
        } else {
            log('receiver-log', 'Camera access denied.', 'error');
            document.getElementById('btn-start-camera').disabled = false;
        }
    }

    function startCalibration() {
        if (!RX) return;
        if (!window._cvReady) {
            log('receiver-log', 'OpenCV not ready yet.', 'warn');
            return;
        }
        document.getElementById('btn-calibrate').disabled = true;
        setRxState('CALIBRATING');
        log('receiver-log', 'Sampling calibration colours (30 frames)…');
        RX.startCalibration(() => {
            log('receiver-log', 'Calibration complete.', 'success');
            log('receiver-log', `  Clock midpoint luma: ${RX.clockMidLuma.toFixed(1)}`);
            if (RX.refColors) {
                RX.refColors.forEach((c, i) => {
                    log('receiver-log', `  Ref[${Framing.COLOR_NAMES[i]}]: R=${c.r.toFixed(0)} G=${c.g.toFixed(0)} B=${c.b.toFixed(0)}`);
                });
            }
            log('receiver-log', 'Sending READY tone…');
            rReadyTime = Date.now();
            AudioTX.playTone('READY').then(() => {
                log('receiver-log', 'READY tone sent. Listening for symbols…');
                startListening();
            });
        });
    }

    function startListening() {
        setRxState('LISTEN');
        rBitBuf = []; rSymCount = 0;
        rLastSeenClockState = null;
        RX.resetClock();
        document.getElementById('rx-result-area').classList.add('hidden');
        // No overall timeout — the ACK retransmit mechanism handles reliability.
        // If the sender is truly gone, sender's own 10×RTT timeout handles it.
    }

    // Stop the ACK retransmit timer
    function stopAckRetransmitTimer() {
        if (rAckRetransmitTimer !== null) {
            clearInterval(rAckRetransmitTimer);
            rAckRetransmitTimer = null;
        }
    }

    // Start the ACK retransmit timer.
    // Every 2×RTT, check if the sender's clock is still the same as when we
    // last ACK'd. If yes → our ACK was probably lost → retransmit.
    function startAckRetransmitTimer() {
        stopAckRetransmitTimer();

        const interval = Math.max(2000, Math.min(15000, 2 * rRttEstimate));
        log('receiver-log', `  ACK retransmit timer started (interval=${Math.round(interval)}ms)`);

        rAckRetransmitTimer = setInterval(() => {
            // Only retransmit if we're still in LISTEN state
            if (rState !== 'LISTEN') {
                stopAckRetransmitTimer();
                return;
            }

            // Check: has the sender's clock changed since our last ACK?
            // We track this via rLastSeenClockState, which is updated in
            // updateDebugPanel from the live camera feed.
            // If clock state is STILL the same → sender didn't get our ACK → resend
            // (We can't directly read RX.lastClockState here, but the onNewSymbol
            //  callback fires when clock changes, which clears this timer. So if
            //  this timer fires, it means clock hasn't changed.)
            log('receiver-log', `  ACK retransmit: sender clock unchanged. Re-sending ACK…`, 'warn');
            AudioTX.playTone('ACK').then(() => {
                log('receiver-log', `  ACK re-sent.`);
            });
        }, interval);
    }

    function onNewSymbol(cells) {
        if (rState !== 'LISTEN') return;

        // Stop any running ACK retransmit timer from the previous symbol
        stopAckRetransmitTimer();

        rSymCount++;

        // Update RTT estimate: for the first symbol, estimate from READY→first-symbol time
        if (rSymCount === 1 && rReadyTime > 0) {
            const firstRtt = Date.now() - rReadyTime;
            if (firstRtt > 0 && firstRtt < 30000) {
                rRttEstimate = firstRtt;
                log('receiver-log', `  Initial RTT estimate: ${Math.round(rRttEstimate)}ms`);
            }
        }

        // Accumulate bits: 4 cells × 2 bits each = 8 bits per symbol
        for (const c of cells) {
            rBitBuf.push((c >> 1) & 1);
            rBitBuf.push(c & 1);
        }

        log('receiver-log', `Symbol ${rSymCount} received: [${cells.map(c => Framing.COLOR_NAMES[c]).join(', ')}]`);

        document.getElementById('dbg-symbols').textContent = rSymCount;
        document.getElementById('dbg-bits').textContent =
            (rBitBuf.length > 40 ? '…' : '') + rBitBuf.slice(-40).join('');

        // Send immediate ACK so sender knows to advance
        AudioTX.playTone('ACK').then(() => {
            log('receiver-log', `  ACK sent for symbol ${rSymCount}.`);
        });

        // Start ACK retransmit timer: if sender doesn't change clock (i.e. didn't
        // get our ACK), we'll re-send ACK every 2×RTT
        startAckRetransmitTimer();

        // After accumulating all expected bits (6 symbols × 8 bits = 48 bits),
        // try to decode the frame
        if (rBitBuf.length >= Framing.FRAME_BITS) {
            stopAckRetransmitTimer();

            const result = Framing.parseFrame(rBitBuf);
            if (result && result.L > 0 && result.L <= 20) {
                // Decoded successfully AND the length field is valid
                // Check: do we have exactly as many message bits as the length field says?
                if (result.messageBits.length === result.L) {
                    handleDecodeSuccess(result);
                } else {
                    // Bit count mismatch — something went wrong
                    log('receiver-log', `Bit count mismatch: expected L=${result.L}, got ${result.messageBits.length}. Sending NACK.`, 'warn');
                    sendFinalNack();
                }
            } else {
                // Could not parse frame at all (SYNC/END markers not found,
                // or invalid length). Total bits received don't make sense.
                log('receiver-log', `Frame parse failed after ${rBitBuf.length} bits. Sending NACK.`, 'warn');
                sendFinalNack();
            }
        }
    }

    function handleDecodeSuccess(result) {
        stopAckRetransmitTimer();
        setRxState('DONE');
        log('receiver-log', `Frame decoded! L=${result.L}  msg=${result.messageBits.join('')}`, 'success');

        if (result.errorMsgBitIdx !== null) {
            log('receiver-log', `Error corrected at message bit ${result.errorMsgBitIdx}`, 'warn');
        } else if (result.errorDataIdx !== null) {
            log('receiver-log', 'Parity-bit error corrected (message intact).', 'warn');
        } else {
            log('receiver-log', 'No bit errors detected.');
        }

        showResult(result);

        // Send final ACK to confirm decode success
        // Small delay to avoid collision with the per-symbol ACK
        setTimeout(() => {
            AudioTX.playTone('ACK').then(() => {
                log('receiver-log', 'Final ACK sent — transmission complete.');
            });
        }, 1500);
    }

    function showResult(result) {
        const area   = document.getElementById('rx-result-area');
        const msgEl  = document.getElementById('rx-message');
        const errEl  = document.getElementById('rx-err-info');
        const metaEl = document.getElementById('rx-meta');
        area.classList.remove('hidden');

        const bits = result.messageBits, errIdx = result.errorMsgBitIdx;
        if (errIdx !== null && errIdx < bits.length) {
            let html = '';
            bits.forEach((b, i) => {
                html += i === errIdx
                    ? `<span class="err-bit" title="bit ${i} corrected">${b}</span>`
                    : `${b}`;
            });
            msgEl.innerHTML = html;
            errEl.textContent = `Bit ${errIdx} (0-indexed) was in error and has been corrected.`;
            errEl.className   = 'rx-err-info error';
        } else {
            msgEl.textContent = bits.join('');
            errEl.textContent  = 'No error detected.';
            errEl.className    = 'rx-err-info ok';
        }
        metaEl.textContent = `Length: ${bits.length} bit${bits.length !== 1 ? 's' : ''}  |  Symbols: ${rSymCount}`;
    }

    // Send NACK: receiver detected that the total bits don't match expected.
    // This triggers the sender to restart from SYN.
    // Receiver resets and goes back to IDLE (waiting for a new calibration cycle).
    function sendFinalNack() {
        stopAckRetransmitTimer();
        setRxState('IDLE');
        AudioTX.playTone('NACK').then(() => {
            log('receiver-log', 'NACK sent. Sender will restart from SYN.', 'warn');
            log('receiver-log', 'Waiting for sender to show calibration frame again…');
            // Reset bit buffer, but stay with camera active
            rBitBuf = []; rSymCount = 0;
            rLastSeenClockState = null;
            if (RX) RX.resetClock();
            // Receiver goes back to needing calibration since sender is restarting
            document.getElementById('btn-calibrate').disabled = false;
        });
    }

    function updateDebugPanel(info) {
        const found = info.screenFound;
        document.getElementById('dbg-markers').textContent =
            found ? '4/4 detected' : `searching… (${info.candidateCount || 0} candidates)`;

        if (info.clockState !== undefined) {
            const pending  = info.newSymbol ? ' ★ SYMBOL' : (info.cooldown > 0 ? ` [cd:${info.cooldown}]` : '');
            document.getElementById('dbg-clock').textContent =
                `${info.clockState}  luma=${info.luma}  mid=${info.midLuma}${pending}`;

            // Track current clock state for ACK retransmit logic
            rLastSeenClockState = info.clockState;
        }
        if (info.cellColors !== undefined) {
            document.getElementById('dbg-cells').textContent = info.cellColors.join(' ');
        }
        if (info.cellRgb !== undefined) {
            const el = document.getElementById('dbg-rgb');
            if (el) el.textContent = info.cellRgb.join(' ');
        }

        if (_overlayCtx) drawQuadOverlay(info.quad || null);
    }

    function drawQuadOverlay(quad) {
        const overlay = document.getElementById('rx-overlay');
        const video   = document.getElementById('rx-video');
        overlay.width  = overlay.offsetWidth  || video.offsetWidth;
        overlay.height = overlay.offsetHeight || video.offsetHeight;
        const ctx = _overlayCtx;
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        if (!quad || !video.videoWidth) return;

        const sx = overlay.width  / video.videoWidth;
        const sy = overlay.height / video.videoHeight;
        const pts = [quad.TL, quad.TR, quad.BR, quad.BL].map(p => ({
            x: p.x * sx, y: p.y * sy
        }));

        ctx.fillStyle = 'rgba(34,211,165,0.10)';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = '#22d3a5';
        ctx.lineWidth   = 2;
        ctx.stroke();

        pts.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#22d3a5';
            ctx.fill();
        });
    }

    function resetReceiver() {
        stopAckRetransmitTimer();
        rBitBuf = []; rSymCount = 0;
        rLastSeenClockState = null;
        rRttEstimate = 2000;
        setRxState('IDLE');
        document.getElementById('rx-result-area').classList.add('hidden');
        document.getElementById('receiver-log').innerHTML = '';
        ['dbg-markers', 'dbg-clock', 'dbg-cells', 'dbg-rgb', 'dbg-symbols', 'dbg-bits']
            .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
        if (_overlayCtx) {
            const o = document.getElementById('rx-overlay');
            _overlayCtx.clearRect(0, 0, o.width, o.height);
        }
        if (RX) {
            RX.reset();
            document.getElementById('btn-calibrate').disabled = false;
        }
        log('receiver-log', 'Reset. Press Calibrate to restart.');
    }

    function cleanupReceiver() {
        stopAckRetransmitTimer();
        if (RX) RX.stop();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  DEBUG CONSOLE
    // ═══════════════════════════════════════════════════════════════════════════
    let debugAudioRX = null, debugRX = null, _dbgWarpCtx = null, _dbgWarpTimer = null;

    function initDebugLab() {
        document.getElementById('btn-dbg-ready').onclick = () => {
            AudioTX.playTone('READY');
            log('debug-log', 'Playing READY (1150+1450 Hz, 450 ms)');
        };
        document.getElementById('btn-dbg-ack').onclick = () => {
            AudioTX.playTone('ACK');
            log('debug-log', 'Playing ACK (1750+2150 Hz, 350 ms)');
        };
        document.getElementById('btn-dbg-nack').onclick = () => {
            AudioTX.playTone('NACK');
            log('debug-log', 'Playing NACK (2550+2950 Hz, 450 ms)');
        };

        const btnStart = document.getElementById('btn-dbg-listen-start');
        const btnStop  = document.getElementById('btn-dbg-listen-stop');

        btnStart.onclick = async () => {
            debugAudioRX = new AudioRX();
            debugAudioRX.onTone = (name) => {
                document.getElementById('dbg-tone-name').textContent = name;
                log('debug-log', `Detected: ${name}`, 'success');
            };
            debugAudioRX.onDebugPoll = (info) => {
                const el = document.getElementById('dbg-fft-info');
                if (!el) return;
                const lines = [];
                for (const [name, data] of Object.entries(info)) {
                    const passStr = data.pass ? 'PASS' : '----';
                    lines.push(`${name.padEnd(6)} peaks=[${data.peaks.join(', ')}] dB  prom=[${data.prominences.join(', ')}] dB  twist=${data.twist} dB  ${passStr}`);
                }
                el.textContent = lines.join('\n');
            };
            const ok = await debugAudioRX.start();
            if (ok) {
                btnStart.disabled = true;
                btnStop.disabled  = false;
                log('debug-log', 'Mic detector started.');
            } else {
                log('debug-log', 'Mic start failed.', 'error');
            }
        };

        btnStop.onclick = () => {
            if (debugAudioRX) { debugAudioRX.stop(); debugAudioRX = null; }
            btnStart.disabled = false;
            btnStop.disabled  = true;
            log('debug-log', 'Detector stopped.');
        };

        // Vision debug
        const btnCamStart = document.getElementById('btn-dbg-cam-start');
        const btnCamStop  = document.getElementById('btn-dbg-cam-stop');
        const btnDbgCalib = document.getElementById('btn-dbg-calib');
        _dbgWarpCtx = document.getElementById('dbg-warp-canvas').getContext('2d');
        const dbgBinaryCtx = document.getElementById('dbg-binary-canvas').getContext('2d');
        const dbgOverlayCtx = document.getElementById('dbg-overlay').getContext('2d');

        btnCamStart.onclick = async () => {
            const video = document.getElementById('dbg-video');
            debugRX = new PhysicalRX(video);
            debugRX.onDebug = updateDebugVision;
            const ok = await debugRX.start();
            if (ok) {
                btnCamStart.disabled = true;
                btnCamStop.disabled  = false;
                if (btnDbgCalib) btnDbgCalib.disabled = false;
                log('debug-log', 'Debug camera started.');

                _dbgWarpTimer = setInterval(() => {
                    if (!debugRX) return;
                    // Render Warped View
                    const wc = debugRX.getWarpedCanvas();
                    if (wc && _dbgWarpCtx) {
                        const dc = document.getElementById('dbg-warp-canvas');
                        _dbgWarpCtx.drawImage(wc, 0, 0, dc.width, dc.height);
                    }
                    // Render Binary Mask
                    const bc = debugRX.getBinaryCanvas();
                    if (bc && dbgBinaryCtx) {
                        const bEl = document.getElementById('dbg-binary-canvas');
                        dbgBinaryCtx.drawImage(bc, 0, 0, bEl.width, bEl.height);
                    }
                }, 60);
            } else {
                log('debug-log', 'Camera start failed.', 'error');
            }
        };

        if (btnDbgCalib) {
            btnDbgCalib.onclick = () => {
                if (!debugRX) return;
                btnDbgCalib.disabled = true;
                log('debug-log', 'Sampling 25 calibration frames in debug mode…');
                debugRX.startCalibration(() => {
                    btnDbgCalib.disabled = false;
                    log('debug-log', 'Debug calibration complete!', 'success');
                    log('debug-log', `Clock midpoint luma: ${debugRX.clockMidLuma.toFixed(1)}`);
                    if (debugRX.refColors) {
                        debugRX.refColors.forEach((c, i) => {
                            log('debug-log', `  Ref[${Framing.COLOR_NAMES[i]}]: R=${c.r.toFixed(0)} G=${c.g.toFixed(0)} B=${c.b.toFixed(0)}`);
                        });
                    }
                });
            };
        }

        btnCamStop.onclick = () => {
            if (debugRX) { debugRX.stop(); debugRX = null; }
            if (_dbgWarpTimer) { clearInterval(_dbgWarpTimer); _dbgWarpTimer = null; }
            btnCamStart.disabled = false;
            btnCamStop.disabled  = true;
            if (btnDbgCalib) btnDbgCalib.disabled = true;
            log('debug-log', 'Debug camera stopped.');
        };

        document.getElementById('debug-back').onclick = () => {
            if (debugAudioRX) { debugAudioRX.stop(); debugAudioRX = null; }
            if (debugRX) { debugRX.stop(); debugRX = null; }
            if (_dbgWarpTimer) { clearInterval(_dbgWarpTimer); _dbgWarpTimer = null; }
            show('screen-role');
        };
    }

    function updateDebugVision(info) {
        const el = (id) => document.getElementById(id);
        const video = document.getElementById('dbg-video');
        const overlay = document.getElementById('dbg-overlay');

        if (overlay && video && video.videoWidth) {
            overlay.width  = overlay.offsetWidth  || video.offsetWidth;
            overlay.height = overlay.offsetHeight || video.offsetHeight;
            const ctx = overlay.getContext('2d');
            ctx.clearRect(0, 0, overlay.width, overlay.height);

            if (info.quad) {
                const sx = overlay.width  / video.videoWidth;
                const sy = overlay.height / video.videoHeight;
                const pts = [info.quad.TL, info.quad.TR, info.quad.BR, info.quad.BL].map(p => ({
                    x: p.x * sx, y: p.y * sy
                }));

                ctx.fillStyle = 'rgba(34,211,165,0.12)';
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
                ctx.closePath();
                ctx.fill();

                ctx.strokeStyle = '#22d3a5';
                ctx.lineWidth   = 2;
                ctx.stroke();

                pts.forEach((p, idx) => {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
                    ctx.fillStyle = idx === 0 ? '#f472b6' : '#22d3a5'; // TL in pink
                    ctx.fill();
                });
            }
        }

        el('dbg-v-markers').textContent = info.screenFound ? 'Locked (4/4)' : 'Searching…';
        el('dbg-v-candidates').textContent = `${info.candidateCount || 0} candidates  |  ${info.fps || 0} fps`;

        if (info.clockState !== undefined) {
            const pending = info.newSymbol ? ' ★ SYMBOL' : (info.cooldown > 0 ? ` [cooldown:${info.cooldown}]` : '');
            el('dbg-v-clock').textContent = `${info.clockState === 'B' ? 'BLACK' : 'WHITE'} (luma=${info.luma}, mid=${info.midLuma})${pending}`;
        }

        if (info.cellColors !== undefined) {
            const COLOR_BITS = ['00', '01', '10', '11'];
            const COLOR_HEX  = ['#FFFFFF', '#FF2222', '#22DD22', '#2266FF'];
            const POS_NAMES  = ['TL', 'TR', 'BL', 'BR'];

            let bits8 = '';
            info.cellColors.forEach((cName, i) => {
                const cIdx = ['WHITE', 'RED', 'GREEN', 'BLUE'].indexOf(cName);
                const idx = cIdx >= 0 ? cIdx : 0;
                const bits = COLOR_BITS[idx];
                bits8 += (i > 0 ? ' ' : '') + bits;

                const colEl = document.getElementById(`dbg-swatch-color-${i}`);
                const lblEl = document.getElementById(`dbg-swatch-name-${i}`);
                const bitEl = document.getElementById(`dbg-swatch-bits-${i}`);
                if (colEl) colEl.style.backgroundColor = COLOR_HEX[idx];
                if (lblEl) lblEl.textContent = `${POS_NAMES[i]}: ${cName}`;
                if (bitEl) bitEl.textContent = bits;
            });

            const symEl = document.getElementById('dbg-v-symbol-bits');
            if (symEl) symEl.textContent = bits8;
        }

        if (info.cellRgb !== undefined) {
            el('dbg-v-rgb').textContent = info.cellRgb.join(' ');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  ROLE SELECTION
    // ═══════════════════════════════════════════════════════════════════════════
    document.getElementById('btn-role-sender').onclick = () => {
        show('screen-sender');
        initSender();
    };
    document.getElementById('btn-role-receiver').onclick = () => {
        show('screen-receiver');
        initReceiver();
    };
    document.getElementById('btn-role-debug').onclick = () => {
        show('screen-debug');
        initDebugLab();
    };

})();
