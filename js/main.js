'use strict';

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
        btn.textContent = 'Requesting...';
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
                hint.textContent = 'Permission denied - enable in browser settings.';
                hint.style.color = 'var(--error)';
            }
        }
    };

    initCvStatus();

    // Sender
    let TX = null, SARX = null;
    let sState       = 'IDLE';
    let sMsgBits     = [];
    let sErrBit      = null;
    let sRetransmit  = false;
    let sSeq         = 0;
    let sSymbols     = [];
    let sSymIdx      = 0;
    let sSymTimer    = null;
    let sDecodeTimer = null;
    let sRttEstimate = 1500;
    let sSymShowTime = 0;

    function getSenderTimeout() {
        return Math.max(5000, Math.min(15000, 10 * sRttEstimate));
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
                ? 'Microphone ready - listening for tones.'
                : 'Microphone unavailable. Acoustic feedback disabled.', ok ? '' : 'warn');
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
        log('sender-log', 'Sender initialized. Ready to transmit.');
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
            IDLE:         ['IDLE',        'idle'],
            CALIBRATE:    ['CALIBRATE',   'calib'],
            ENCODE:       ['ENCODING',    'active'],
            TRANSMIT:     ['TRANSMITTING','active'],
            SYM_GAP:      ['GAP',         'active'],
            AWAIT_DECODE: ['AWAIT DECODE','calib'],
            DONE:         ['DONE',        'success'],
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
        sRttEstimate = 1500;

        if (sErrBit !== null && (sErrBit < 0 || sErrBit >= sMsgBits.length)) {
            alert(`Error bit index ${sErrBit} out of range (0-${sMsgBits.length - 1})`);
            return;
        }

        log('sender-log', `Loaded message: ${bitsStr} (Length: ${sMsgBits.length}, simulated error: ${sErrBit ?? 'none'})`);
        showCalibFrame();
    }

    function showCalibFrame() {
        setSenderState('CALIBRATE');
        TX.drawCalibration();
        log('sender-log', 'Calibration pattern displayed. Waiting for receiver READY tone...');
    }

    function onSenderTone(tone) {
        log('sender-log', `Detected tone: ${tone}`);

        switch (sState) {
            case 'CALIBRATE':
                if (tone === 'READY') {
                    log('sender-log', 'READY tone detected. Starting transmission...', 'success');
                    doEncode();
                }
                break;

            case 'TRANSMIT':
                if (tone === 'ACK') {
                    clearTimeout(sSymTimer);

                    const measuredRtt = Date.now() - sSymShowTime;
                    if (measuredRtt > 0 && measuredRtt < 15000) {
                        sRttEstimate = 0.7 * sRttEstimate + 0.3 * measuredRtt;
                    }

                    sSymIdx++;
                    if (sSymIdx >= sSymbols.length) {
                        setSenderState('AWAIT_DECODE');
                        TX.drawIdle();
                        const timeout = getSenderTimeout();
                        log('sender-log', `All symbols transmitted. Waiting for final decode verdict (timeout: ${Math.round(timeout/1000)}s)...`, 'success');
                        
                        sDecodeTimer = setTimeout(() => {
                            if (sState === 'AWAIT_DECODE') {
                                log('sender-log', 'Final decode timeout. Restarting from calibration...', 'warn');
                                doFullRestart();
                            }
                        }, timeout);
                    } else {
                        log('sender-log', `Symbol ${sSymIdx} acknowledged (RTT: ${measuredRtt}ms).`, 'success');
                        setSenderState('SYM_GAP');
                        setTimeout(doTransmitNextSymbol, 500);
                    }
                }
                break;

            case 'SYM_GAP':
                break;

            case 'AWAIT_DECODE':
                clearTimeout(sDecodeTimer);
                if (tone === 'ACK') {
                    setSenderState('DONE');
                    TX.drawIdle();
                    sSeq ^= 1;
                    log('sender-log', 'Final ACK received - transmission complete and verified!', 'success');
                    setTimeout(() => {
                        if (sState === 'DONE') setSenderState('IDLE');
                    }, 3000);
                } else if (tone === 'NACK') {
                    log('sender-log', 'NACK received - receiver requested retransmission.', 'warn');
                    doFullRestart();
                }
                break;
        }
    }

    function doEncode() {
        setSenderState('ENCODE');
        const errBit  = sRetransmit ? null : sErrBit;
        const bits48  = Framing.buildFrame(sMsgBits, errBit, sSeq);
        sSymbols      = Framing.bitsToSymbols(bits48);
        sSymIdx       = 0;
        log('sender-log', `Encoded frame into ${sSymbols.length} symbols (SEQ: ${sSeq}, error bit: ${errBit ?? 'none'})`);

        TX.drawIdle();
        setTimeout(doTransmitNextSymbol, 300);
    }

    function doTransmitNextSymbol() {
        if (sSymIdx >= sSymbols.length) {
            setSenderState('AWAIT_DECODE');
            TX.drawIdle();
            return;
        }

        setSenderState('TRANSMIT');
        TX.showSymbol(sSymbols[sSymIdx]);
        sSymShowTime = Date.now();

        const timeout = getSenderTimeout();
        log('sender-log', `Displaying symbol ${sSymIdx + 1}/${sSymbols.length} [${sSymbols[sSymIdx].join(',')}]`);

        sSymTimer = setTimeout(() => {
            if (sState === 'TRANSMIT') {
                log('sender-log', `Symbol ${sSymIdx + 1} timeout (${Math.round(timeout / 1000)}s). Restarting...`, 'warn');
                doFullRestart();
            }
        }, timeout);
    }

    function doFullRestart() {
        clearTimeout(sSymTimer);
        clearTimeout(sDecodeTimer);
        sRetransmit = true;
        log('sender-log', 'Retransmitting frame without simulated errors...', 'warn');
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
        sRttEstimate = 1500;
        log('sender-log', 'Sender reset.');
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

    // Receiver
    let RX = null, rState = 'IDLE', rBitBuf = [], rSymCount = 0;
    let _overlayCtx = null;

    let rAckRetransmitTimer = null;
    let rListenTimer        = null;
    let rLastSeenClockState = null;
    let rScreenFound        = false;
    let rRttEstimate        = 1500;
    let rReadyTime          = 0;
    let rLastDecodedSeq     = null;

    function initReceiver() {
        RX = null; rState = 'IDLE'; rBitBuf = []; rSymCount = 0;
        _overlayCtx = document.getElementById('rx-overlay').getContext('2d');

        document.getElementById('btn-start-camera').onclick   = startCamera;
        document.getElementById('btn-calibrate').onclick      = startCalibration;
        document.getElementById('btn-reset-receiver').onclick = resetReceiver;
        document.getElementById('receiver-back').onclick      = () => { cleanupReceiver(); show('screen-role'); };

        setRxState('IDLE');
        log('receiver-log', 'Receiver initialized. Start camera to begin.');
    }

    function setRxState(st) {
        rState = st;
        const labels = {
            IDLE:        ['IDLE',        'idle'],
            'CAMERA ON': ['CAMERA ON',   'active'],
            CALIBRATING: ['CALIBRATING', 'calib'],
            LISTEN:      ['LISTENING',   'active'],
            DECODING:    ['DECODING',    'calib'],
            DONE:        ['DONE',        'success'],
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
            log('receiver-log', 'Camera started. Frame the sender screen and press Calibrate.');
        } else {
            log('receiver-log', 'Unable to access camera.', 'error');
            document.getElementById('btn-start-camera').disabled = false;
        }
    }

    function startCalibration() {
        if (!RX) return;
        if (!window._cvReady) {
            log('receiver-log', 'OpenCV runtime not ready yet.', 'warn');
            return;
        }
        document.getElementById('btn-calibrate').disabled = true;
        setRxState('CALIBRATING');
        log('receiver-log', 'Sampling calibration reference colors (20 frames)...');
        RX.startCalibration(() => {
            log('receiver-log', 'Calibration complete.', 'success');
            log('receiver-log', `Clock threshold luma: ${RX.clockMidLuma.toFixed(1)}`);
            if (RX.refColors) {
                RX.refColors.forEach((c, i) => {
                    log('receiver-log', `Ref [${Framing.COLOR_NAMES[i]}]: R=${c.r.toFixed(0)} G=${c.g.toFixed(0)} B=${c.b.toFixed(0)}`);
                });
            }
            log('receiver-log', 'Transmitting READY tone...');
            rReadyTime = Date.now();
            AudioTX.playTone('READY').then(() => {
                log('receiver-log', 'READY tone sent. Listening for incoming symbols...');
                startListening();
            });
        });
    }

    function startListening() {
        setRxState('LISTEN');
        rBitBuf = []; rSymCount = 0;
        rLastSeenClockState = null;
        if (RX) RX.resetClock();
        document.getElementById('rx-result-area').classList.add('hidden');
        startListenTimer();
    }

    function stopListenTimer() {
        if (rListenTimer !== null) {
            clearTimeout(rListenTimer);
            rListenTimer = null;
        }
    }

    function startListenTimer() {
        stopListenTimer();
        const timeout = Math.max(5000, Math.min(15000, 10 * rRttEstimate));
        rListenTimer = setTimeout(() => {
            if (rState === 'LISTEN') {
                log('receiver-log', `Listen timeout (${Math.round(timeout / 1000)}s). Sending NACK...`, 'warn');
                sendFinalNack();
            }
        }, timeout);
    }

    function stopAckRetransmitTimer() {
        if (rAckRetransmitTimer !== null) {
            clearInterval(rAckRetransmitTimer);
            rAckRetransmitTimer = null;
        }
    }

    function startAckRetransmitTimer() {
        stopAckRetransmitTimer();
        const interval = Math.max(1500, Math.min(6000, 2 * rRttEstimate));

        rAckRetransmitTimer = setInterval(() => {
            if (rState !== 'LISTEN') {
                stopAckRetransmitTimer();
                return;
            }
            if (!rScreenFound) {
                log('receiver-log', 'ACK retransmit deferred: screen tracking lost.', 'warn');
                return;
            }

            log('receiver-log', 'Sender clock unchanged. Retransmitting ACK...', 'warn');
            AudioTX.playTone('ACK').then(() => {
                log('receiver-log', 'ACK retransmitted.');
            });
        }, interval);
    }

    function onNewSymbol(cells) {
        if (rState !== 'LISTEN') return;

        stopAckRetransmitTimer();
        startListenTimer();

        rSymCount++;

        if (rSymCount === 1 && rReadyTime > 0) {
            const firstRtt = Date.now() - rReadyTime;
            if (firstRtt > 0 && firstRtt < 15000) {
                rRttEstimate = firstRtt;
                log('receiver-log', `Measured RTT: ${Math.round(rRttEstimate)}ms`);
            }
        }

        for (const c of cells) {
            rBitBuf.push((c >> 1) & 1);
            rBitBuf.push(c & 1);
        }

        log('receiver-log', `Symbol ${rSymCount}/6 received: [${cells.map(c => Framing.COLOR_NAMES[c]).join(', ')}]`);

        document.getElementById('dbg-symbols').textContent = rSymCount;
        document.getElementById('dbg-bits').textContent =
            (rBitBuf.length > 40 ? '...' : '') + rBitBuf.slice(-40).join('');

        AudioTX.playTone('ACK').then(() => {
            log('receiver-log', `ACK sent for symbol ${rSymCount}.`);
        });

        startAckRetransmitTimer();

        if (rBitBuf.length >= Framing.PADDED_BITS) {
            stopAckRetransmitTimer();
            stopListenTimer();

            const result = Framing.parseFrame(rBitBuf);
            if (result && result.L > 0 && result.L <= 20 && result.messageBits.length === result.L) {
                handleDecodeSuccess(result);
            } else {
                log('receiver-log', 'Frame validation failed (delimiter/parity error). Sending NACK.', 'error');
                sendFinalNack();
            }
        }
    }

    function handleDecodeSuccess(result) {
        stopAckRetransmitTimer();
        stopListenTimer();

        if (result.seq === rLastDecodedSeq) {
            log('receiver-log', `Duplicate frame detected (SEQ: ${result.seq}). Re-sending final ACK.`, 'warn');
        } else {
            rLastDecodedSeq = result.seq;
            setRxState('DONE');
            log('receiver-log', `Frame decoded: SEQ=${result.seq}, Length=${result.L}, Data=${result.messageBits.join('')}`, 'success');

            if (result.errorMsgBitIdx !== null) {
                log('receiver-log', `Simulated medium error corrected at payload bit index ${result.errorMsgBitIdx}.`, 'warn');
            } else if (result.errorDataIdx !== null) {
                log('receiver-log', 'Parity bit error corrected.', 'warn');
            } else {
                log('receiver-log', 'Zero transmission errors detected.');
            }

            showResult(result);
        }

        setTimeout(() => {
            AudioTX.playTone('ACK').then(() => {
                log('receiver-log', 'Final ACK sent. Ready for next transmission.');
                rBitBuf = []; rSymCount = 0;
                if (RX) RX.resetClock();
                setRxState('LISTEN');
                startListenTimer();
            });
        }, 500);
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
            errEl.textContent = `Bit ${errIdx} (0-indexed) was corrupted on medium and corrected in-place.`;
            errEl.className   = 'rx-err-info error';
        } else {
            msgEl.textContent = bits.join('');
            errEl.textContent  = 'No error detected (clean transmission).';
            errEl.className    = 'rx-err-info ok';
        }
        metaEl.textContent = `Length: ${bits.length} bit${bits.length !== 1 ? 's' : ''} | Symbols: ${rSymCount}`;
    }

    function sendFinalNack() {
        stopAckRetransmitTimer();
        stopListenTimer();
        setRxState('DECODING');
        AudioTX.playTone('NACK').then(() => {
            log('receiver-log', 'NACK sent. Waiting for sender restart...', 'warn');
            rBitBuf = []; rSymCount = 0;
            rLastSeenClockState = null;
            if (RX) RX.resetClock();
            document.getElementById('btn-calibrate').disabled = false;
            setRxState('IDLE');
        });
    }

    function updateDebugPanel(info) {
        rScreenFound = info.screenFound;
        document.getElementById('dbg-markers').textContent =
            rScreenFound ? '4/4 detected' : `searching... (${info.candidateCount || 0} candidates)`;

        if (info.clockState !== undefined) {
            const pending  = info.newSymbol ? ' [NEW SYM]' : (info.cooldown > 0 ? ` [cd:${info.cooldown}]` : '');
            document.getElementById('dbg-clock').textContent =
                `${info.clockState} (luma: ${info.luma}, mid: ${info.midLuma})${pending}`;
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
        stopListenTimer();
        rLastDecodedSeq = null;
        rBitBuf = []; rSymCount = 0;
        rLastSeenClockState = null;
        rRttEstimate = 1500;
        setRxState('IDLE');
        document.getElementById('rx-result-area').classList.add('hidden');
        document.getElementById('receiver-log').innerHTML = '';
        ['dbg-markers', 'dbg-clock', 'dbg-cells', 'dbg-rgb', 'dbg-symbols', 'dbg-bits']
            .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '-'; });
        if (_overlayCtx) {
            const o = document.getElementById('rx-overlay');
            _overlayCtx.clearRect(0, 0, o.width, o.height);
        }
        if (RX) {
            RX.reset();
            document.getElementById('btn-calibrate').disabled = false;
        }
        log('receiver-log', 'Receiver reset. Press Calibrate to restart.');
    }

    function cleanupReceiver() {
        stopAckRetransmitTimer();
        stopListenTimer();
        if (RX) RX.stop();
    }

    // Diagnostics
    let debugAudioRX = null, debugRX = null, _dbgWarpCtx = null, _dbgWarpTimer = null;

    function initDebugLab() {
        document.getElementById('btn-dbg-ready').onclick = () => {
            AudioTX.playTone('READY');
            log('debug-log', 'Emitting READY (1150+1450 Hz, 400 ms)');
        };
        document.getElementById('btn-dbg-ack').onclick = () => {
            AudioTX.playTone('ACK');
            log('debug-log', 'Emitting ACK (1750+2150 Hz, 300 ms)');
        };
        document.getElementById('btn-dbg-nack').onclick = () => {
            AudioTX.playTone('NACK');
            log('debug-log', 'Emitting NACK (2550+2950 Hz, 450 ms)');
        };

        const btnStart = document.getElementById('btn-dbg-listen-start');
        const btnStop  = document.getElementById('btn-dbg-listen-stop');

        btnStart.onclick = async () => {
            debugAudioRX = new AudioRX();
            debugAudioRX.onTone = (name) => {
                document.getElementById('dbg-tone-name').textContent = name;
                log('debug-log', `Detected tone: ${name}`, 'success');
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
                log('debug-log', 'Acoustic detector started.');
            } else {
                log('debug-log', 'Failed to start acoustic detector.', 'error');
            }
        };

        btnStop.onclick = () => {
            if (debugAudioRX) { debugAudioRX.stop(); debugAudioRX = null; }
            btnStart.disabled = false;
            btnStop.disabled  = true;
            log('debug-log', 'Acoustic detector stopped.');
        };

        const btnCamStart = document.getElementById('btn-dbg-cam-start');
        const btnCamStop  = document.getElementById('btn-dbg-cam-stop');
        const btnDbgCalib = document.getElementById('btn-dbg-calib');
        _dbgWarpCtx = document.getElementById('dbg-warp-canvas').getContext('2d');
        const dbgBinaryCtx = document.getElementById('dbg-binary-canvas').getContext('2d');

        btnCamStart.onclick = async () => {
            const video = document.getElementById('dbg-video');
            debugRX = new PhysicalRX(video);
            debugRX.onDebug = updateDebugVision;
            const ok = await debugRX.start();
            if (ok) {
                btnCamStart.disabled = true;
                btnCamStop.disabled  = false;
                if (btnDbgCalib) btnDbgCalib.disabled = false;
                log('debug-log', 'Camera diagnostics started.');

                _dbgWarpTimer = setInterval(() => {
                    if (!debugRX) return;
                    const wc = debugRX.getWarpedCanvas();
                    if (wc && _dbgWarpCtx) {
                        const dc = document.getElementById('dbg-warp-canvas');
                        _dbgWarpCtx.drawImage(wc, 0, 0, dc.width, dc.height);
                    }
                    const bc = debugRX.getBinaryCanvas();
                    if (bc && dbgBinaryCtx) {
                        const bEl = document.getElementById('dbg-binary-canvas');
                        dbgBinaryCtx.drawImage(bc, 0, 0, bEl.width, bEl.height);
                    }
                }, 60);
            } else {
                log('debug-log', 'Camera startup failed.', 'error');
            }
        };

        if (btnDbgCalib) {
            btnDbgCalib.onclick = () => {
                if (!debugRX) return;
                btnDbgCalib.disabled = true;
                log('debug-log', 'Sampling 20 calibration frames...');
                debugRX.startCalibration(() => {
                    btnDbgCalib.disabled = false;
                    log('debug-log', 'Calibration sampling complete.', 'success');
                    log('debug-log', `Clock threshold luma: ${debugRX.clockMidLuma.toFixed(1)}`);
                    if (debugRX.refColors) {
                        debugRX.refColors.forEach((c, i) => {
                            log('debug-log', `Ref [${Framing.COLOR_NAMES[i]}]: R=${c.r.toFixed(0)} G=${c.g.toFixed(0)} B=${c.b.toFixed(0)}`);
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
            log('debug-log', 'Camera diagnostics stopped.');
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
                    ctx.fillStyle = idx === 0 ? '#f472b6' : '#22d3a5';
                    ctx.fill();
                });
            }
        }

        el('dbg-v-markers').textContent = info.screenFound ? 'Locked (4/4)' : 'Searching...';
        el('dbg-v-candidates').textContent = `${info.candidateCount || 0} candidates | ${info.fps || 0} fps`;

        if (info.clockState !== undefined) {
            const pending = info.newSymbol ? ' [NEW SYM]' : (info.cooldown > 0 ? ` [cd:${info.cooldown}]` : '');
            el('dbg-v-clock').textContent = `${info.clockState === 'B' ? 'BLACK' : 'WHITE'} (luma: ${info.luma}, mid: ${info.midLuma})${pending}`;
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
