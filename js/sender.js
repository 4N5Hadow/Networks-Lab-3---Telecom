'use strict';

/**
 * sender.js
 * 
 * Vanilla JS implementation of the Sender side of the TeleCom system.
 * This pattern avoids frameworks and uses basic DOM manipulation.
 */
document.addEventListener('DOMContentLoaded', () => {
    let TX = null, SARX = null;
    let sState = 'IDLE';
    let sMsgBits = [];
    let sErrBit = null;
    let sRetransmit = false;
    let sSeq = 0;
    let sSymbols = [];
    let sSymIdx = 0;
    let sSymTimer = null;
    let sRttEstimate = 1500;
    let sSymShowTime = 0;

    function log(msg, type = '') {
        const el = document.getElementById('sender-log');
        if (!el) return;
        const line = document.createElement('div');
        line.className = 'log-line' + (type ? ' ' + type : '');
        const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        line.textContent = `[${ts}] ${msg}`;
        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
        while (el.children.length > 80) el.removeChild(el.firstChild);
    }

    function setstatus(text, type) {
        const el = document.getElementById('sender-status-status');
        if (!el) return;
        el.textContent = text;
        el.className = 'status ' + (type || 'idle');
    }

    function getSenderTimeout() {
        return Math.max(5000, Math.min(120000, 10 * sRttEstimate));
    }

    function showTxView() {
        const configView = document.getElementById('sender-config-view');
        const txView = document.getElementById('sender-tx-display-view');
        if (configView) configView.classList.add('hidden');
        if (txView) txView.classList.remove('hidden');
        resizeCanvas();
    }

    function hideTxView() {
        const txView = document.getElementById('sender-tx-display-view');
        const configView = document.getElementById('sender-config-view');
        if (txView) txView.classList.add('hidden');
        if (configView) configView.classList.remove('hidden');
    }

    function resizeCanvas() {
        const canvas = document.getElementById('tx-canvas');
        if (!canvas || !TX) return;
        const S = Math.min(window.innerWidth, window.innerHeight) * 0.94;
        canvas.width = canvas.height = Math.floor(S);
        if (sState === 'CALIBRATE') {
            TX.drawCalibration();
        } else if (sState === 'TRANSMIT' && sSymbols && sSymbols[sSymIdx]) {
            TX.showSymbol(sSymbols[sSymIdx]);
        } else {
            TX.drawIdle();
        }
    }

    async function initSender() {
        const canvas = document.getElementById('tx-canvas');
        const S = Math.min(window.innerWidth, window.innerHeight) * 0.94;
        canvas.width = canvas.height = Math.floor(S);

        TX = new PhysicalTX(canvas);
        SARX = new AudioRX();
        TX.drawIdle();

        SARX.onTone = onSenderTone;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());

            const ok = await SARX.start();
            log(ok ? 'Microphone ready - listening for tones.' : 'Microphone unavailable.', ok ? '' : 'warn');
        } catch (e) {
            log('Microphone access denied.', 'error');
        }

        document.getElementById('msg-bits').oninput = () => { sanitizeBits(); validateSender(); };
        document.getElementById('error-bit').oninput = validateSender;
        document.getElementById('btn-show-calib').onclick = onSenderStart;
        document.getElementById('btn-reset-sender').onclick = resetSender;

        const exitBtn = document.getElementById('btn-exit-tx');
        if (exitBtn) exitBtn.onclick = exitTxView;

        setSenderState('IDLE');
        validateSender();
        log('Sender initialized. Ready to transmit.');
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
            IDLE: ['IDLE', 'idle'],
            CALIBRATE: ['CALIBRATE', 'calib'],
            ENCODE: ['ENCODING', 'active'],
            TRANSMIT: ['TRANSMITTING', 'active'],
            SYM_GAP: ['GAP', 'active'],
            DONE: ['DONE', 'success'],
        };
        const [text, type] = labels[st] || [st, 'idle'];
        setstatus(text, type);
        validateSender();
    }

    function onSenderStart() {
        const bitsStr = document.getElementById('msg-bits').value;
        const errVal = document.getElementById('error-bit').value.trim();
        sMsgBits = bitsStr.split('').map(Number);
        sErrBit = errVal !== '' ? parseInt(errVal, 10) : null;
        sRetransmit = false;
        sRttEstimate = 1500;

        if (sErrBit !== null && (sErrBit < 0 || sErrBit >= sMsgBits.length)) {
            alert(`Error bit index ${sErrBit} out of range (0-${sMsgBits.length - 1})`);
            return;
        }

        log(`Loaded message: ${bitsStr} (Length: ${sMsgBits.length}, simulated error: ${sErrBit ?? 'none'})`);
        showCalibFrame();
    }

    function showCalibFrame() {
        setSenderState('CALIBRATE');
        showTxView();
        TX.drawCalibration();
        log('Calibration pattern displayed. Waiting for receiver READY tone...');
    }

    function onSenderTone(tone) {
        log(`Detected tone: ${tone}`);

        if (tone === 'NACK') {
            clearTimeout(sSymTimer);
            log('NACK received from receiver! Restarting from starting calibration state...', 'warn');
            doFullRestart();
            return;
        }

        switch (sState) {
            case 'CALIBRATE':
                if (tone === 'READY') {
                    log('READY tone detected. Starting transmission...', 'success');
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
                        setSenderState('DONE');
                        TX.drawIdle();
                        sSeq ^= 1;
                        log('Final symbol acknowledged & frame verified! Transmission complete.', 'success');
                        setTimeout(() => {
                            if (sState === 'DONE') {
                                setSenderState('IDLE');
                                hideTxView();
                            }
                        }, 3500);
                    } else {
                        log(`Symbol ${sSymIdx} acknowledged (RTT: ${measuredRtt}ms).`, 'success');
                        setSenderState('SYM_GAP');
                        setTimeout(doTransmitNextSymbol, 500);
                    }
                }
                break;
        }
    }

    function doEncode() {
        setSenderState('ENCODE');
        const bits48 = Framing.buildFrame(sMsgBits, sErrBit, sSeq);
        sSymbols = Framing.bitsToSymbols(bits48);
        sSymIdx = 0;
        log(`Encoded frame into ${sSymbols.length} symbols`);
        TX.drawIdle();
        setTimeout(doTransmitNextSymbol, 300);
    }

    function doTransmitNextSymbol() {
        if (sSymIdx >= sSymbols.length) return;

        setSenderState('TRANSMIT');
        TX.showSymbol(sSymbols[sSymIdx]);
        sSymShowTime = Date.now();

        const timeout = getSenderTimeout();
        log(`Displaying symbol ${sSymIdx + 1}/${sSymbols.length}`);

        sSymTimer = setTimeout(() => {
            if (sState === 'TRANSMIT') {
                log(`Symbol ${sSymIdx + 1} timeout. Restarting from starting calibration state...`, 'warn');
                doFullRestart();
            }
        }, timeout);
    }

    function doFullRestart() {
        clearTimeout(sSymTimer);
        sRetransmit = true;
        sSymIdx = 0;
        log('Retransmitting frame from calibration start...', 'warn');
        showCalibFrame();
    }

    function exitTxView() {
        clearTimeout(sSymTimer);
        if (TX) TX.stop();
        setSenderState('IDLE');
        if (TX) TX.drawIdle();
        hideTxView();
        log('Exited transmission screen back to setup.');
        validateSender();
    }

    function resetSender() {
        clearTimeout(sSymTimer);
        if (TX) TX.stop();
        setSenderState('IDLE');
        if (TX) TX.drawIdle();
        hideTxView();
        document.getElementById('sender-log').innerHTML = '';
        sRetransmit = false;
        sRttEstimate = 1500;
        validateSender();
        log('Sender reset.');
    }

    window.addEventListener('resize', () => {
        resizeCanvas();
    });

    initSender();
});
