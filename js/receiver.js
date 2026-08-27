'use strict';

/**
 * receiver.js
 * 
 * Vanilla JS implementation of the Receiver side of the TeleCom system.
 * This pattern avoids frameworks and uses basic DOM manipulation,
 * similar to official WebRTC and OpenCV.js samples.
 */
document.addEventListener('DOMContentLoaded', () => {
    let RX = null;
    let rState = 'IDLE';
    let rBitBuf = [];
    let rSymCount = 0;
    let _overlayCtx = null;
    let rAckRetransmitTimer = null;
    let rListenTimer = null;
    let rLastSeenClockState = null;
    let rScreenFound = false;
    let rRttEstimate = 1500;
    let rReadyTime = 0;
    let rLastDecodedSeq = null;

    function log(msg, type = '') {
        const el = document.getElementById('receiver-log');
        if (!el) return;
        const line = document.createElement('div');
        line.className = 'log-line' + (type ? ' ' + type : '');
        const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        line.textContent = `[${ts}] ${msg}`;
        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
        while (el.children.length > 80) el.removeChild(el.firstChild);
    }

    function setBadge(text, type) {
        const el = document.getElementById('receiver-status-badge');
        if (!el) return;
        el.textContent = text;
        el.className   = 'badge ' + (type || 'idle');
    }

    function setRxState(st) {
        rState = st;
        const labels = {
            IDLE:        ['IDLE',        'idle'],
            'CAMERA ON': ['CAMERA ON',   'active'],
            CALIBRATING: ['CALIBRATING', 'calib'],
            LISTEN:      ['LISTENING',   'active'],
            DONE:        ['DONE',        'success'],
        };
        const [text, type] = labels[st] || [st, 'idle'];
        setBadge(text, type);
    }

    function initReceiver() {
        _overlayCtx = document.getElementById('rx-overlay').getContext('2d');
        document.getElementById('btn-start-camera').onclick   = startCamera;
        document.getElementById('btn-calibrate').onclick      = startCalibration;
        document.getElementById('btn-reset-receiver').onclick = resetReceiver;

        setRxState('IDLE');
        log('Receiver initialized. Start camera to begin.');
    }

    async function startCamera() {
        document.getElementById('btn-start-camera').disabled = true;
        const video = document.getElementById('rx-video');
        RX = new PhysicalRX(video);
        RX.onDebug     = updateOverlay; // Stripped down debug
        RX.onNewSymbol = onNewSymbol;

        const ok = await RX.start();
        if (ok) {
            document.getElementById('btn-calibrate').disabled = false;
            setRxState('CAMERA ON');
            log('Camera started. Frame the sender screen and press Calibrate.');
        } else {
            log('Unable to access camera.', 'error');
            document.getElementById('btn-start-camera').disabled = false;
        }
    }

    function startCalibration() {
        if (!RX) return;
        if (!window._cvReady) {
            log('OpenCV runtime not ready yet.', 'warn');
            return;
        }
        document.getElementById('btn-calibrate').disabled = true;
        setRxState('CALIBRATING');
        log('Sampling calibration reference colors (20 frames)...');
        RX.startCalibration(() => {
            log('Calibration complete.', 'success');
            log('Transmitting READY tone...');
            rReadyTime = Date.now();
            AudioTX.playTone('READY').then(() => {
                log('READY tone sent. Listening for incoming symbols...');
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
                log(`Listen timeout (${Math.round(timeout / 1000)}s). Sending NACK...`, 'warn');
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
            if (!rScreenFound) return;

            log('Sender clock unchanged. Retransmitting ACK...', 'warn');
            AudioTX.playTone('ACK');
        }, interval);
    }

    function onNewSymbol(cells) {
        if (rState !== 'LISTEN') return;
        rSymCount++;

        if (rSymCount === 1 && rReadyTime > 0) {
            const firstRtt = Date.now() - rReadyTime;
            if (firstRtt > 0 && firstRtt < 15000) {
                rRttEstimate = firstRtt;
                log(`Measured RTT: ${Math.round(rRttEstimate)}ms`);
            }
        }

        for (const c of cells) {
            rBitBuf.push((c >> 1) & 1);
            rBitBuf.push(c & 1);
        }

        log(`Symbol ${rSymCount}/6 received: [${cells.map(c => Framing.COLOR_NAMES[c]).join(', ')}]`);

        if (rBitBuf.length >= Framing.PADDED_BITS) {
            stopAckRetransmitTimer();
            stopListenTimer();

            const result = Framing.parseFrame(rBitBuf);
            if (result && result.L > 0 && result.L <= 20 && result.messageBits.length === result.L) {
                handleDecodeSuccess(result);
            } else {
                log('Frame validation failed. Sending NACK.', 'error');
                sendFinalNack();
            }
        } else {
            stopListenTimer();
            startListenTimer();
            AudioTX.playTone('ACK');
            startAckRetransmitTimer();
        }
    }

    function handleDecodeSuccess(result) {
        stopAckRetransmitTimer();
        stopListenTimer();

        if (result.seq === rLastDecodedSeq) {
            log(`Duplicate frame detected (SEQ: ${result.seq}). Sending ACK.`, 'warn');
            AudioTX.playTone('ACK');
        } else {
            rLastDecodedSeq = result.seq;
            setRxState('DONE');
            log(`Frame decoded: SEQ=${result.seq}, Length=${result.L}, Data=${result.messageBits.join('')}`, 'success');
            showResult(result);

            AudioTX.playTone('ACK').then(() => {
                log('Final ACK sent. Ready for next transmission.', 'success');
                document.getElementById('btn-calibrate').disabled = false;
            });
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
            errEl.textContent = `Bit ${errIdx} (0-indexed) was corrupted on medium and corrected in-place.`;
            errEl.className   = 'rx-err-info error';
        } else {
            msgEl.textContent = bits.join('');
            errEl.textContent  = 'No error detected (clean transmission).';
            errEl.className    = 'rx-err-info ok';
        }
        metaEl.textContent = `Length: ${bits.length} bits | Symbols: ${rSymCount}`;
    }

    function sendFinalNack() {
        stopAckRetransmitTimer();
        stopListenTimer();
        setRxState('CAMERA ON');
        AudioTX.playTone('NACK').then(() => {
            log('NACK sent. Waiting for sender restart...', 'warn');
            rBitBuf = []; rSymCount = 0;
            rLastSeenClockState = null;
            if (RX) RX.resetClock();
            document.getElementById('btn-calibrate').disabled = false;
        });
    }

    function updateOverlay(info) {
        rScreenFound = info.screenFound;
        if (info.clockState !== undefined) {
            rLastSeenClockState = info.clockState;
        }

        const overlay = document.getElementById('rx-overlay');
        const video   = document.getElementById('rx-video');
        overlay.width  = overlay.offsetWidth  || video.offsetWidth;
        overlay.height = overlay.offsetHeight || video.offsetHeight;
        const ctx = _overlayCtx;
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        const quad = info.quad;
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
        if (_overlayCtx) {
            const o = document.getElementById('rx-overlay');
            _overlayCtx.clearRect(0, 0, o.width, o.height);
        }
        if (RX) {
            RX.reset();
            document.getElementById('btn-calibrate').disabled = false;
        }
        log('Receiver reset. Press Calibrate to restart.');
    }

    initReceiver();
});
