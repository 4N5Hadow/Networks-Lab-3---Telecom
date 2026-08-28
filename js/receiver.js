'use strict';

document.addEventListener('DOMContentLoaded', () => {
    let rState = 'IDLE';
    let rBitBuf = [];
    let rSymCount = 0;
    let rLastDecodedSeq = null;

    function setRxState(st) {
        rState = st;
        const isListen = st === 'LISTEN';
        document.getElementById('color-input').disabled = !isListen;
        document.getElementById('submit_btn').disabled = !isListen;
    }

    function initReceiver() {
        document.getElementById('calibrate_btn').onclick = startCalibration;
        document.getElementById('nack_btn_manual').onclick = () => {
            sendFinalNack();
        };
        document.getElementById('reset_btn').onclick = resetReceiver;
        document.getElementById('submit_btn').onclick = submitSymbol;
        document.getElementById('ack_btn').onclick = () => {
            AudioTX.playTone('ACK');
        };
        document.getElementById('color-input').onkeydown = (e) => {
            if (e.key === 'Enter') submitSymbol();
        };

        setRxState('IDLE');
    }

    function startCalibration() {
        document.getElementById('calibrate_btn').disabled = true;
        setRxState('CALIBRATING');

        AudioTX.playTone('READY').then(() => {
            startListening();
        });
    }

    function startListening() {
        setRxState('LISTEN');
        rBitBuf = [];
        rSymCount = 0;
        document.getElementById('rx-result-area').classList.add('hidden');
        document.getElementById('color-input').value = '';
        document.getElementById('color-input').focus();
        document.getElementById('ack_btn').disabled = true;
    }

    function submitSymbol() {
        if (rState !== 'LISTEN') return;

        const input = document.getElementById('color-input').value.trim().toUpperCase();
        if (input.length !== 4) {
            return;
        }

        const map = { 'W': 0, 'R': 1, 'G': 2, 'B': 3 };
        const cells = [];
        for (let i = 0; i < 4; i++) {
            const char = input[i];
            if (!(char in map)) {
                return;
            }
            cells.push(map[char]);
        }

        // Clear input for next symbol
        document.getElementById('color-input').value = '';
        document.getElementById('color-input').focus();
        document.getElementById('ack_btn').disabled = true;

        onNewSymbol(cells);
    }

    function onNewSymbol(cells) {
        rSymCount++;

        for (const c of cells) {
            rBitBuf.push((c >> 1) & 1);
            rBitBuf.push(c & 1);
        }

        if (rBitBuf.length >= Framing.PADDED_BITS) {
            const result = Framing.parseFrame(rBitBuf);
            if (result && result.L > 0 && result.L <= 20 && result.messageBits.length === result.L) {
                handleDecodeSuccess(result);
            } else {
                sendFinalNack();
            }
        } else {
            AudioTX.playTone('ACK').then(() => {
                document.getElementById('ack_btn').disabled = false;
            });
        }
    }

    function handleDecodeSuccess(result) {
        if (result.seq === rLastDecodedSeq) {
            AudioTX.playTone('ACK').then(() => {
                document.getElementById('ack_btn').disabled = false;
            });
        } else {
            rLastDecodedSeq = result.seq;
            setRxState('DONE');
            showResult(result);

            AudioTX.playTone('ACK').then(() => {
                document.getElementById('calibrate_btn').disabled = false;
                document.getElementById('ack_btn').disabled = false;
            });
        }
    }

    function showResult(result) {
        const area = document.getElementById('rx-result-area');
        const msgEl = document.getElementById('rx-message');
        const errEl = document.getElementById('rx-err-info');
        const metaEl = document.getElementById('rx-meta');
        area.classList.remove('hidden');

        const bits = result.messageBits, errIdx = result.errorMsgBitIdx;
        if (errIdx !== null && errIdx < bits.length) {
            let html = '';
            bits.forEach((b, i) => {
                html += i === errIdx
                    ? `<span class="err-bit">${b}</span>`
                    : `${b}`;
            });
            msgEl.innerHTML = html;
            errEl.textContent = 'Error at bit ' + errIdx + ' (corrected)';
            errEl.className = 'rx-err-info error';
        } else {
            msgEl.textContent = bits.join('');
            errEl.textContent = 'No errors detected';
            errEl.className = 'rx-err-info ok';
        }
        metaEl.textContent = 'Length: ' + bits.length + ' bits';
    }

    function sendFinalNack() {
        setRxState('IDLE');
        document.getElementById('ack_btn').disabled = true;
        AudioTX.playTone('NACK').then(() => {
            rBitBuf = [];
            rSymCount = 0;
            document.getElementById('calibrate_btn').disabled = false;
        });
    }

    function resetReceiver() {
        rLastDecodedSeq = null;
        rBitBuf = [];
        rSymCount = 0;
        setRxState('IDLE');
        document.getElementById('rx-result-area').classList.add('hidden');
        document.getElementById('calibrate_btn').disabled = false;
        document.getElementById('ack_btn').disabled = true;
        document.getElementById('color-input').value = '';
    }

    initReceiver();
});
