'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// MAIN — State machines, UI wiring, debug console
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
    //  HOME — OpenCV + Permissions
    // ═══════════════════════════════════════════════════════════════════════════
    let _permGranted = false;
    let _cvOk        = false;

    function checkUnlock() {
        const ready = _permGranted && _cvOk;
        document.getElementById('btn-role-sender').disabled   = !ready;
        document.getElementById('btn-role-receiver').disabled = !ready;
        if (ready) {
            document.getElementById('perm-gate').classList.add('hidden');
        }
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
                cs.getTracks().forEach(t => t.stop());
                camOk = true;
            } catch (_) {}
            try {
                const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
                ms.getTracks().forEach(t => t.stop());
                micOk = true;
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
    //  SENDER
    // ═══════════════════════════════════════════════════════════════════════════
    let TX = null, SARX = null;
    let sState = 'IDLE', sMsgBits = [], sErrBit = null, sRetransmit = false, sAckTimer = null;

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
                ? 'Microphone ready — listening for ACK/NACK'
                : 'Mic unavailable. ACK/NACK detection disabled.', ok ? '' : 'warn');
        });

        document.getElementById('msg-bits').oninput   = () => { sanitizeBits(); validateSender(); };
        document.getElementById('error-bit').oninput  = validateSender;
        document.getElementById('dwell-time').oninput = function () {
            document.getElementById('dwell-val').textContent = this.value;
        };
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
            IDLE:      ['IDLE',       'idle'],
            CALIBRATE: ['CALIBRATE',  'calib'],
            ENCODE:    ['ENCODE',     'active'],
            TRANSMIT:  ['TRANSMIT',   'active'],
            AWAIT_ACK: ['AWAIT ACK',  'calib'],
            DONE:      ['DONE',       'success'],
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
        log('sender-log', 'Calibration frame displayed. Waiting for READY tone from receiver…');
    }

    function onSenderTone(tone) {
        log('sender-log', `Received tone: ${tone}`);
        if (tone === 'READY' && sState === 'CALIBRATE') {
            doEncode();
        } else if (sState === 'AWAIT_ACK') {
            clearTimeout(sAckTimer);
            if (tone === 'ACK') {
                setSenderState('DONE');
                TX.drawIdle();
                log('sender-log', 'ACK received — transmission complete.', 'success');
                setTimeout(() => setSenderState('IDLE'), 2000);
            } else if (tone === 'NACK') {
                log('sender-log', 'NACK received — retransmitting…', 'warn');
                doRetransmit();
            }
        }
    }

    function doEncode() {
        setSenderState('ENCODE');
        const errBit = sRetransmit ? null : sErrBit;
        const bits48  = Framing.buildFrame(sMsgBits, errBit);
        const symbols = Framing.bitsToSymbols(bits48);
        log('sender-log', `Encoded ${Framing.NUM_SYMBOLS} symbols (error@bit ${errBit ?? 'none'})`);
        doTransmit(symbols);
    }

    function doTransmit(symbols) {
        const dwell = parseInt(document.getElementById('dwell-time').value, 10) || 300;
        setSenderState('TRANSMIT');
        log('sender-log', `Transmitting ${symbols.length} symbols @ ${dwell} ms each…`);
        TX.startTransmission(symbols, dwell, () => {
            log('sender-log', 'Transmission done. Awaiting ACK/NACK (5 s timeout)…');
            setSenderState('AWAIT_ACK');
            TX.drawIdle();
            sAckTimer = setTimeout(() => {
                if (sState === 'AWAIT_ACK') {
                    log('sender-log', 'ACK timeout — retransmitting…', 'warn');
                    doRetransmit();
                }
            }, 5000);
        });
    }

    function doRetransmit() { sRetransmit = true; showCalibFrame(); }

    function resetSender() {
        clearTimeout(sAckTimer);
        setSenderState('IDLE');
        if (TX) TX.stop();
        document.getElementById('sender-log').innerHTML = '';
        sRetransmit = false;
        log('sender-log', 'Reset.');
        validateSender();
    }

    function cleanupSender() {
        clearTimeout(sAckTimer);
        if (TX) TX.stop();
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
    //  RECEIVER
    // ═══════════════════════════════════════════════════════════════════════════
    let RX = null, rState = 'IDLE', rBitBuf = [], rSymCount = 0, rListenTimer = null, _overlayCtx = null;

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
            NACK:        ['NACK SENT',    'warn'],
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
            AudioTX.playTone('READY').then(() => {
                log('receiver-log', 'READY tone sent. Listening for data…');
                startListening();
            });
        });
    }

    function startListening() {
        setRxState('LISTEN');
        rBitBuf = []; rSymCount = 0;
        RX.resetClock();
        document.getElementById('rx-result-area').classList.add('hidden');
        rListenTimer = setTimeout(() => {
            if (rState === 'LISTEN') {
                log('receiver-log', 'Listen timeout — sending NACK.', 'warn');
                sendNack();
            }
        }, 20000);
    }

    function onNewSymbol(cells) {
        if (rState !== 'LISTEN') return;
        rSymCount++;

        for (const c of cells) {
            rBitBuf.push((c >> 1) & 1);
            rBitBuf.push(c & 1);
        }

        document.getElementById('dbg-symbols').textContent = rSymCount;
        document.getElementById('dbg-bits').textContent =
            (rBitBuf.length > 40 ? '…' : '') + rBitBuf.slice(-40).join('');

        const result = Framing.parseFrame(rBitBuf);
        if (result) {
            clearTimeout(rListenTimer);
            setRxState('DONE');
            log('receiver-log', `Frame decoded. L=${result.L}  msg=${result.messageBits.join('')}`, 'success');
            if (result.errorMsgBitIdx !== null) {
                log('receiver-log', `Error corrected at message bit ${result.errorMsgBitIdx}`, 'warn');
            } else if (result.errorDataIdx !== null) {
                log('receiver-log', 'Parity-bit error corrected (message intact).', 'warn');
            } else {
                log('receiver-log', 'No bit errors detected.');
            }
            showResult(result);
            AudioTX.playTone('ACK').then(() => log('receiver-log', 'ACK sent.'));
        }
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
        metaEl.textContent = `Length: ${bits.length} bit${bits.length !== 1 ? 's' : ''}`;
    }

    function sendNack() {
        setRxState('NACK');
        AudioTX.playTone('NACK').then(() => {
            log('receiver-log', 'NACK sent. Waiting for retransmit…');
            rBitBuf = []; rSymCount = 0;
            if (RX) RX.resetClock();
            setRxState('LISTEN');
            rListenTimer = setTimeout(() => {
                if (rState === 'LISTEN') sendNack();
            }, 20000);
        });
    }

    function updateDebugPanel(info) {
        const found = info.screenFound;
        document.getElementById('dbg-markers').textContent =
            found ? '4/4 detected' : `searching… (${info.candidateCount || 0} candidates)`;

        if (info.clockState !== undefined) {
            document.getElementById('dbg-clock').textContent =
                `${info.clockState}  luma=${info.luma}  mid=${info.midLuma}`;
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
        clearTimeout(rListenTimer);
        rBitBuf = []; rSymCount = 0;
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
            RX.calibrated = false;
            RX.resetClock();
            document.getElementById('btn-calibrate').disabled = false;
        }
        log('receiver-log', 'Reset. Press Calibrate to restart.');
    }

    function cleanupReceiver() {
        clearTimeout(rListenTimer);
        if (RX) RX.stop();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  DEBUG CONSOLE
    // ═══════════════════════════════════════════════════════════════════════════
    let debugAudioRX = null;
    let debugRX      = null;
    let _dbgWarpCtx  = null;
    let _dbgWarpTimer = null;

    function initDebugLab() {
        // Audio tone buttons
        document.getElementById('btn-dbg-ready').onclick = () => {
            AudioTX.playTone('READY');
            log('debug-log', 'Playing READY tone (440+554 Hz, 800 ms)');
        };
        document.getElementById('btn-dbg-ack').onclick = () => {
            AudioTX.playTone('ACK');
            log('debug-log', 'Playing ACK tone (1760+2217 Hz, 350 ms)');
        };
        document.getElementById('btn-dbg-nack').onclick = () => {
            AudioTX.playTone('NACK');
            log('debug-log', 'Playing NACK tone (220+277 Hz, 1000 ms)');
        };

        // Tone detector
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
                    lines.push(`${name.padEnd(6)} peaks=[${data.peaks.join(', ')}] dB  noise=${data.noise} dB  ${passStr}`);
                }
                el.textContent = lines.join('\n');
            };
            const ok = await debugAudioRX.start();
            if (ok) {
                btnStart.disabled = true;
                btnStop.disabled  = false;
                log('debug-log', 'Mic tone detector started.');
            } else {
                log('debug-log', 'Microphone start failed.', 'error');
            }
        };

        btnStop.onclick = () => {
            if (debugAudioRX) { debugAudioRX.stop(); debugAudioRX = null; }
            btnStart.disabled = false;
            btnStop.disabled  = true;
            log('debug-log', 'Detector stopped.');
        };

        // Vision pipeline debug
        const btnCamStart = document.getElementById('btn-dbg-cam-start');
        const btnCamStop  = document.getElementById('btn-dbg-cam-stop');
        _dbgWarpCtx = document.getElementById('dbg-warp-canvas').getContext('2d');

        btnCamStart.onclick = async () => {
            const video = document.getElementById('dbg-video');
            debugRX = new PhysicalRX(video);
            debugRX.onDebug = updateDebugVision;
            const ok = await debugRX.start();
            if (ok) {
                btnCamStart.disabled = true;
                btnCamStop.disabled  = false;
                log('debug-log', 'Debug camera feed started.');
                // Periodically copy warped canvas to debug view
                _dbgWarpTimer = setInterval(() => {
                    const wc = debugRX.getWarpedCanvas();
                    if (wc && _dbgWarpCtx) {
                        const dc = document.getElementById('dbg-warp-canvas');
                        _dbgWarpCtx.drawImage(wc, 0, 0, dc.width, dc.height);
                    }
                }, 100);
            } else {
                log('debug-log', 'Camera start failed.', 'error');
            }
        };

        btnCamStop.onclick = () => {
            if (debugRX) { debugRX.stop(); debugRX = null; }
            if (_dbgWarpTimer) { clearInterval(_dbgWarpTimer); _dbgWarpTimer = null; }
            btnCamStart.disabled = false;
            btnCamStop.disabled  = true;
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
        const found = info.screenFound;
        const el = (id) => document.getElementById(id);

        el('dbg-v-markers').textContent = found ? '4/4' : `0/4`;
        el('dbg-v-candidates').textContent = info.candidateCount || '—';

        if (info.clockState !== undefined) {
            el('dbg-v-clock').textContent = `${info.clockState}  luma=${info.luma}  mid=${info.midLuma}`;
        }
        if (info.cellColors !== undefined) {
            el('dbg-v-cells').textContent = info.cellColors.join(' ');
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
