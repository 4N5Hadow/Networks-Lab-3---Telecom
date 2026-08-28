'use strict';

(function () {
    const N = 30, K = 25;
    const PARITY_POS = [1, 2, 4, 8, 16];

    const DATA_POS = [];
    for (let i = 1; i <= N; i++) {
        if (!PARITY_POS.includes(i)) {
            DATA_POS.push(i);
        }
    }

    const CW_TO_DATA = [];
    for (let i = 0; i <= N; i++) {
        CW_TO_DATA.push(-1);
    }
    for (let i = 0; i < DATA_POS.length; i++) {
        let pos = DATA_POS[i];
        CW_TO_DATA[pos] = i;
    }

    function encode(data) {
        if (data.length !== K) {
            throw new Error('Hamming.encode: expected ' + K + ' bits, got ' + data.length);
        }

        let cw = []; // 0 added at index 0 for 1-based indexing for Hamming
        for (let i = 0; i <= N; i++) {
            cw.push(0);
        }

        for (let i = 0; i < K; i++) {
            cw[DATA_POS[i]] = data[i];
        }

        for (let i = 0; i < PARITY_POS.length; i++) {
            let p = PARITY_POS[i];
            let par = 0;
            for (let pos = 1; pos <= N; pos++) {
                if (pos !== p && (pos & p)) {
                    par ^= cw[pos];
                }
            }
            cw[p] = par;
        }

        return cw.slice(1);
    }

    function decode(received) {
        if (received.length !== N) {
            throw new Error('Hamming.decode: expected ' + N + ' bits, got ' + received.length);
        }

        let cw = [0].concat(received); // 0 added at index 0 for 1-based indexing for Hamming

        let syndrome = 0;
        for (let i = 0; i < PARITY_POS.length; i++) {
            let p = PARITY_POS[i];
            let par = 0;
            for (let pos = 1; pos <= N; pos++) {
                if (pos & p) {
                    par ^= cw[pos];
                }
            }
            if (par !== 0) {
                syndrome += p;
            }
        }

        let errorCwPos = null, errorDataIdx = null;
        if (syndrome > 0 && syndrome <= N) {
            cw[syndrome] ^= 1;
            errorCwPos   = syndrome;
            errorDataIdx = CW_TO_DATA[syndrome];
        }

        const data = DATA_POS.map(p => cw[p]);
        return {
            lengthBits: data.slice(0, 5),
            payloadBits: data.slice(5),
            errorCwPos: errorCwPos,
            errorDataIdx: errorDataIdx,
        };
    }

    function injectError(codeword, msgBitIdx) {
        if (msgBitIdx == null) {
            return codeword.slice();
        }
        let dataIdx = 5 + msgBitIdx;
        if (dataIdx < 0 || dataIdx >= K) {
            throw new Error('injectError: msgBitIdx out of range');
        }
        let cwPos1 = DATA_POS[dataIdx];
        let out = codeword.slice();
        out[cwPos1 - 1] ^= 1;
        return out;
    }

    window.Hamming = { encode, decode, injectError, N, K, DATA_POS, CW_TO_DATA };
})();
