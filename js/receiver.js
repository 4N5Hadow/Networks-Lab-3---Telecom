'use strict';

/**
 * receiver.js
 * 
 * Vanilla JS implementation of the Receiver side of the TeleCom system.
 * This version uses MANUAL input for colors (W, R, G, B) rather than camera detection.
 */
document.addEventListener('DOMContentLoaded', () => {
    let rState = 'IDLE';
    let rBitBuf = [];
    let rSymCount = 0;
    let rAckRetransmitTimer = null;
    let rListenTimer = null;
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
            CALIBRATING: ['CALIBRATING', 'calib'],
            LISTEN:      ['LISTENING',   'active'],
            DONE:        ['DONE',        'success'],
        };
        const [text, type] = labels[st] || [st, 'idle'];
        setBadge(text, type);

        const isListen = st === 'LISTEN';
        document.getElementById('color-input').disabled = !isListen;
        document.getElementById('btn-submit-symbol').disabled = !isListen;
    }

    function initReceiver() {
        document.getElementById('btn-calibrate').onclick      = startCalibration;
        document.getElementById('btn-reset-receiver').onclick = resetReceiver;
        document.getElementById('btn-submit-symbol').onclick  = submitSymbol;
        document.getElementById('color-input').onkeydown      = (e) => {
            if (e.key === 'Enter') submitSymbol();
        };

        setRxState('IDLE');
        log('Receiver initialized. Press "Start Calibration & Listening" when ready.');
    }

    function startCalibration() {
        document.getElementById('btn-calibrate').disabled = true;
        setRxState('CALIBRATING');
        
        log('Transmitting READY tone...');
        AudioTX.playTone('READY').then(() => {
            log('READY tone sent. Ready to receive symbols (W/R/G/B).');
            startListening();
        });
    }

    function startListening() {
        setRxState('LISTEN');
        rBitBuf = []; rSymCount = 0;
        document.getElementById('rx-result-area').classList.add('hidden');
        document.getElementById('color-input').value = '';
        document.getElementById('color-input').focus();
    }

    function startListenTimer() {
        stopListenTimer();
        const timeout = Math.max(5000, Math.min(120000, 10 * rRttEstimate));
        rListenTimer = setTimeout(() => {
            if (rState === 'LISTEN') {
                log(`Listen timeout (${Math.round(timeout / 1000)}s). Sending NACK...`, 'warn');
                sendFinalNack();
            }
        }, timeout);
    }

    function stopListenTimer() {
        if (rListenTimer !== null) {
            clearTimeout(rListenTimer);
            rListenTimer = null;
        }
    }

    function stopAckRetransmitTimer() {
        if (rAckRetransmitTimer !== null) {
            clearInterval(rAckRetransmitTimer);
            rAckRetransmitTimer = null;
        }
    }

    function submitSymbol() {
        if (rState !== 'LISTEN') return;

        const input = document.getElementById('color-input').value.trim().toUpperCase();
        if (input.length !== 4) {
            log(`Invalid input: "${input}". Must be exactly 4 characters (e.g. RGBW).`, 'warn');
            return;
        }

        const map = { 'W': 0, 'R': 1, 'G': 2, 'B': 3 };
        const cells = [];
        for (let i = 0; i < 4; i++) {
            const char = input[i];
            if (!(char in map)) {
                log(`Invalid character: "${char}". Use W, R, G, B.`, 'warn');
                return;
            }
            cells.push(map[char]);
        }

        // Clear input for next symbol
        document.getElementById('color-input').value = '';
        document.getElementById('color-input').focus();

        onNewSymbol(cells);
    }

    function onNewSymbol(cells) {
        rSymCount++;

        for (const c of cells) {
            rBitBuf.push((c >> 1) & 1);
            rBitBuf.push(c & 1);
        }

        log(`Symbol ${rSymCount}/6 received manually: [${cells.map(c => Framing.COLOR_NAMES[c]).join(', ')}]`);

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
            AudioTX.playTone('ACK');
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
        setRxState('IDLE');
        AudioTX.playTone('NACK').then(() => {
            log('NACK sent. Waiting for sender restart...', 'warn');
            rBitBuf = []; rSymCount = 0;
            document.getElementById('btn-calibrate').disabled = false;
        });
    }

    function resetReceiver() {
        stopAckRetransmitTimer();
        stopListenTimer();
        rLastDecodedSeq = null;
        rBitBuf = []; rSymCount = 0;
        setRxState('IDLE');
        document.getElementById('rx-result-area').classList.add('hidden');
        document.getElementById('receiver-log').innerHTML = '';
        document.getElementById('btn-calibrate').disabled = false;
        document.getElementById('color-input').value = '';
        log('Receiver reset. Press "Start Calibration & Listening" to restart.');
    }

    initReceiver();
});
