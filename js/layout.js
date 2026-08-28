'use strict';
const LAYOUT = Object.freeze({
    PAD_F: 0.04,
    CLOCK_F: 0.12,      // 12% of canvas height/width
    CELL_F: 0.35,       // 35% of canvas for each cell (70% total 2x2 grid)
    CLOCK_GAP_F: 0.04,  // Gap between clock and 2x2 grid

    CANON_SIZE: 400,
    CANON_CLOCK: Object.freeze({ x: 200, y: 44, hw: 24 }),
    CANON_CELLS: Object.freeze([
        Object.freeze({ x: 130, y: 220, hw: 70 }),  // TL
        Object.freeze({ x: 270, y: 220, hw: 70 }),  // TR
        Object.freeze({ x: 130, y: 360, hw: 70 }),  // BL
        Object.freeze({ x: 270, y: 360, hw: 70 }),  // BR
    ]),
});

window.LAYOUT = LAYOUT;
