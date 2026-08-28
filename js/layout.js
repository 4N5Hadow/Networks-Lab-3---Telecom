'use strict';

const LAYOUT = {
    CLOCK_SIZE: 0.12,
    CELL_SIZE: 0.35,
    GAP: 0.04,

    CANON_SIZE: 400,
    CANON_CLOCK: { x: 200, y: 44, hw: 24 },
    CANON_CELLS: [
        { x: 130, y: 220, hw: 70 },
        { x: 270, y: 220, hw: 70 },
        { x: 130, y: 360, hw: 70 },
        { x: 270, y: 360, hw: 70 },
    ],
};

window.LAYOUT = LAYOUT;
