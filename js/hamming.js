'use strict';
(function () {
    const N = 30, K = 25;
    const PARITY_SET = new Set([1, 2, 4, 8, 16]);

    const DATA_POS = [];
    for (let p = 1; p <= N; p++) {
        if (!PARITY_SET.has(p)) DATA_POS.push(p);
    }

    const CW_TO_DATA = new Int8Array(N + 1).fill(-1);
    DATA_POS.forEach((pos, i) => { CW_TO_DATA[pos] = i; });

    function encode(data) {
        if (data.length !== K) throw new Error(`Hamming.encode: expected ${K} bits, got ${data.length}`);
        const cw = new Uint8Array(N + 1);
        for (let i = 0; i < K; i++) cw[DATA_POS[i]] = data[i] & 1;
        for (const p of [1, 2, 4, 8, 16]) {
            let par = 0;
            for (let pos = 1; pos <= N; pos++) {
                if (pos !== p && (pos & p)) par ^= cw[pos];
            }
            cw[p] = par;
        }
        return Array.from(cw.subarray(1));
    }

    function decode(received) {
        if (received.length !== N) throw new Error(`Hamming.decode: expected ${N} bits, got ${received.length}`);
        const cw = [0, ...received];

        let syndrome = 0;
        for (const p of [1, 2, 4, 8, 16]) {
            let par = 0;
            for (let pos = 1; pos <= N; pos++) {
                if (pos & p) par ^= cw[pos];
            }
            if (par) syndrome += p;
        }

        let errorCwPos = null, errorDataIdx = null;
        if (syndrome > 0 && syndrome <= N) {
            cw[syndrome] ^= 1;
            errorCwPos   = syndrome;
            errorDataIdx = CW_TO_DATA[syndrome];
        }

        const data = DATA_POS.map(p => cw[p]);
        return {
            lengthBits:   data.slice(0, 5),
            payloadBits:  data.slice(5),
            errorCwPos,
            errorDataIdx,
        };
    }

    function injectError(codeword, msgBitIdx) {
        if (msgBitIdx == null) return [...codeword];
        const dataIdx = 5 + msgBitIdx;
        if (dataIdx < 0 || dataIdx >= K) throw new Error('injectError: msgBitIdx out of range');
        const cwPos1 = DATA_POS[dataIdx];
        const out = [...codeword];
        out[cwPos1 - 1] ^= 1;
        return out;
    }

    window.Hamming = { encode, decode, injectError, N, K, DATA_POS, CW_TO_DATA };
})();
