'use strict';
(function () {
    const SYN = [1, 1, 1, 0, 0, 1, 0];
    const END = [0, 1, 1, 1];
    const FRAME_BITS = 42;
    const PADDED_BITS = 48;
    const NUM_SYMBOLS = 6;
    const COLOR_NAMES = ['WHITE', 'RED', 'GREEN', 'BLUE'];
    const COLOR_HEX = ['#FFFFFF', '#FF0000', '#00FF00', '#0000FF'];

    function buildFrame(messageBits, errorMsgBit = null, seq = 0) {
        const L = messageBits.length;
        if (L > 20) throw new Error('Message exceeds 20 bits');

        const lenBits = [];
        for (let i = 4; i >= 0; i--) lenBits.push((L >> i) & 1);

        const payload = [...messageBits, ...new Array(20 - L).fill(0)];
        let codeword = Hamming.encode([...lenBits, ...payload]);
        codeword = Hamming.injectError(codeword, errorMsgBit);

        const frame = [...SYN, (seq & 1), ...codeword, ...END, ...new Array(PADDED_BITS - 42).fill(0),];
        return frame;
    }

    function bitsToSymbols(bits48) {
        let allSymbols = [];
        let symbol = [];

        for (let i = 0; i < NUM_SYMBOLS * 8; i += 2) {
            symbol.push((bits48[i] << 1) | bits48[i + 1]);

            if (i % 8 === 6) {
                allSymbols.push(symbol);
                symbol = [];
            }
        }

        return allSymbols;
    }

    function parseFrame(bitBuf) {
        const syncStr = SYN.join('');
        const endStr = END.join('');
        const need = 42;

        for (let i = 0; i <= bitBuf.length - need; i++) {
            if (bitBuf.slice(i, i + 7).join('') !== syncStr) continue;
            const seq = bitBuf[i + 7];
            const endSlice = bitBuf.slice(i + 38, i + 42);
            if (endSlice.join('') !== endStr) continue;

            const codeword = bitBuf.slice(i + 8, i + 38);
            const r = Hamming.decode(codeword);
            let L = 0;
            for (const b of r.lengthBits) L = (L << 1) | b;
            if (L < 1 || L > 20) continue;
            const eMsgBit = (r.errorDataIdx !== null && r.errorDataIdx >= 5) ? r.errorDataIdx - 5 : null;

            return {
                messageBits: r.payloadBits.slice(0, L),
                L,
                seq,
                errorDataIdx: r.errorDataIdx,
                errorMsgBitIdx: eMsgBit,
                startPos: i,
            };
        }
        return null;
    }

    window.Framing = {
        buildFrame, bitsToSymbols, parseFrame,
        SYNC: SYN, END, FRAME_BITS, PADDED_BITS, NUM_SYMBOLS,
        COLOR_NAMES, COLOR_HEX,
    };
})();
