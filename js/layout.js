'use strict';
const LAYOUT = Object.freeze({
    PAD_F:      0.03,
    MARKER_F:   0.08,
    CLOCK_F:    0.06,
    CELL_F:     0.22,    // 22% of canvas — significantly larger for reliable reads
    CLOCK_GAP:  6,

    CANON_SIZE: 400,
    CANON_CLOCK: Object.freeze({ x: 200, y: 40, hw: 10 }),
    CANON_CELLS: Object.freeze([
        Object.freeze({ x: 149, y: 149, hw: 30 }),  // TL
        Object.freeze({ x: 251, y: 149, hw: 30 }),  // TR
        Object.freeze({ x: 149, y: 251, hw: 30 }),  // BL
        Object.freeze({ x: 251, y: 251, hw: 30 }),  // BR
    ]),
});

window.LAYOUT = LAYOUT;
