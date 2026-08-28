'use strict';

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
    const TIMEOUT_MS = 10000;

    function showTxView() {
        const configView = document.getElementById('sender-config-view');
        const txView = document.getElementById('sender-tx-display-view');
        if (configView) configView.classList.add('hidden');
        if (txView) txView.classList.remove('hidden');
    }

    function hideTxView() {
        const txView = document.getElementById('sender-tx-display-view');
        const configView = document.getElementById('sender-config-view');
        if (txView) txView.classList.add('hidden');
        if (configView) configView.classList.remove('hidden');
    }

    async function initSender() {
        TX = new PhysicalTX();
        SARX = new AudioRX();
        TX.drawIdle();

        SARX.onTone = onSenderTone;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());
            await SARX.start();
        } catch (_) {}

        document.getElementById('msg-bits').oninput = () => { sanitizeBits(); validateSender(); };
        document.getElementById('error-bit').oninput = validateSender;
        document.getElementById('btn-show-calib').onclick = onSenderStart;
        document.getElementById('btn-reset-sender').onclick = resetSender;

        const exitBtn = document.getElementById('btn-exit-tx');
        if (exitBtn) exitBtn.onclick = exitTxView;

        setSenderState('IDLE');
        validateSender();
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
        validateSender();
    }

    function onSenderStart() {
        const bitsStr = document.getElementById('msg-bits').value;
        const errVal = document.getElementById('error-bit').value.trim();
        sMsgBits = bitsStr.split('').map(Number);
        sErrBit = errVal !== '' ? parseInt(errVal, 10) : null;
        sRetransmit = false;

        if (sErrBit !== null && (sErrBit < 0 || sErrBit >= sMsgBits.length)) {
            alert('Error bit index ' + sErrBit + ' out of range (0-' + (sMsgBits.length - 1) + ')');
            return;
        }

        showCalibFrame();
    }

    function showCalibFrame() {
        setSenderState('CALIBRATE');
        showTxView();
        TX.drawCalibration();
    }

    function onSenderTone(tone) {
        if (tone === 'NACK') {
            clearTimeout(sSymTimer);
            doFullRestart();
            return;
        }

        switch (sState) {
            case 'CALIBRATE':
                if (tone === 'READY') {
                    doEncode();
                }
                break;

            case 'TRANSMIT':
                if (tone === 'ACK') {
                    clearTimeout(sSymTimer);

                    sSymIdx++;
                    if (sSymIdx >= sSymbols.length) {
                        setSenderState('DONE');
                        TX.drawIdle();
                        sSeq ^= 1;
                        setTimeout(() => {
                            if (sState === 'DONE') {
                                setSenderState('IDLE');
                                hideTxView();
                            }
                        }, 3500);
                    } else {
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
        TX.drawIdle();
        setTimeout(doTransmitNextSymbol, 300);
    }

    function doTransmitNextSymbol() {
        if (sSymIdx >= sSymbols.length) return;

        setSenderState('TRANSMIT');
        TX.showSymbol(sSymbols[sSymIdx]);

        sSymTimer = setTimeout(() => {
            if (sState === 'TRANSMIT') {
                doFullRestart();
            }
        }, TIMEOUT_MS);
    }

    function doFullRestart() {
        clearTimeout(sSymTimer);
        sRetransmit = true;
        sSymIdx = 0;
        showCalibFrame();
    }

    function exitTxView() {
        clearTimeout(sSymTimer);
        if (TX) TX.stop();
        setSenderState('IDLE');
        if (TX) TX.drawIdle();
        hideTxView();
        validateSender();
    }

    function resetSender() {
        clearTimeout(sSymTimer);
        if (TX) TX.stop();
        setSenderState('IDLE');
        if (TX) TX.drawIdle();
        hideTxView();
        sRetransmit = false;
        validateSender();
    }

    initSender();
});
