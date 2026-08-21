'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// HAMMING(30, 25) SINGLE-ERROR-CORRECTING CODE
//
// Positions 1..30 (1-indexed).  Parity positions: 1, 2, 4, 8, 16.
// The 25 non-parity positions hold 5 LENGTH bits then 20 PAYLOAD bits.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    const N = 30, K = 25;
    const PARITY_SET = new Set([1, 2, 4, 8, 16]);

    // DATA_POS[i] = 1-indexed codeword position for data bit i (i in 0..K-1)
    const DATA_POS = [];
    for (let p = 1; p <= N; p++) {
        if (!PARITY_SET.has(p)) DATA_POS.push(p);
    }
    // DATA_POS = [3,5,6,7,9,10,11,12,13,14,15,17,18,19,20,21,22,23,24,25,26,27,28,29,30]

    // CW_TO_DATA[pos1] = data index  (0-indexed, or -1 for parity positions)
    const CW_TO_DATA = new Int8Array(N + 1).fill(-1);
    DATA_POS.forEach((pos, i) => { CW_TO_DATA[pos] = i; });

    /** Encode 25 data bits into a 30-bit Hamming codeword.
     *  @param {number[]} data  – Array of 25 bits (length_bits concat payload_bits)
     *  @returns {number[]}     – Array of 30 bits (0-indexed)
     */
    function encode(data) {
        if (data.length !== K) throw new Error(`Hamming.encode: expected ${K} bits, got ${data.length}`);
        const cw = new Uint8Array(N + 1); // 1-indexed; [0] unused
        for (let i = 0; i < K; i++) cw[DATA_POS[i]] = data[i] & 1;
        for (const p of [1, 2, 4, 8, 16]) {
            let par = 0;
            for (let pos = 1; pos <= N; pos++) {
                if (pos !== p && (pos & p)) par ^= cw[pos];
            }
            cw[p] = par;
        }
        return Array.from(cw.subarray(1)); // length-30, 0-indexed
    }

    /** Decode a (possibly corrupted) 30-bit codeword.
     *  Corrects at most 1 bit error in-place and returns extracted data.
     *  @param {number[]} received – Array of 30 bits (0-indexed)
     *  @returns {{ lengthBits: number[], payloadBits: number[],
     *              errorCwPos: number|null, errorDataIdx: number|null }}
     *    errorCwPos    – 1-indexed codeword position of corrected bit, or null
     *    errorDataIdx  – data-array index (0-24) of corrected bit,
     *                    -1 if parity position was corrected, or null if no error
     */
    function decode(received) {
        if (received.length !== N) throw new Error(`Hamming.decode: expected ${N} bits, got ${received.length}`);
        const cw = [0, ...received]; // re-index to 1..30

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
            errorDataIdx = CW_TO_DATA[syndrome]; // -1 if parity position
        }

        const data = DATA_POS.map(p => cw[p]);
        return {
            lengthBits:   data.slice(0, 5),
            payloadBits:  data.slice(5),     // 20 bits
            errorCwPos,
            errorDataIdx, // 0-4 = length bits, 5-24 = payload bits, -1 = parity
        };
    }

    /** Inject a 1-bit error at the codeword position corresponding to
     *  message bit index msgBitIdx (0-indexed into the original message,
     *  i.e. into the PAYLOAD field of the data block).
     *  Call this AFTER encode(), immediately before transmission.
     *  @param {number[]} codeword      – 30-bit array (0-indexed), modified copy returned
     *  @param {number|null} msgBitIdx  – 0-based index in original message, or null
     *  @returns {number[]}
     */
    function injectError(codeword, msgBitIdx) {
        if (msgBitIdx == null) return [...codeword];
        const dataIdx = 5 + msgBitIdx;            // skip 5 length bits
        if (dataIdx < 0 || dataIdx >= K) throw new Error('injectError: msgBitIdx out of range');
        const cwPos1 = DATA_POS[dataIdx];          // 1-indexed codeword position
        const out = [...codeword];
        out[cwPos1 - 1] ^= 1;                     // flip (0-indexed)
        return out;
    }

    window.Hamming = { encode, decode, injectError, N, K, DATA_POS, CW_TO_DATA };
})();
