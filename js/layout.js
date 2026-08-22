'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT CONSTANTS
//
// Canvas layout (fraction of square side S):
//   PAD  = 3%     (border)
//   MARK = 8%     (finder markers, solid black)
//   CELL = 22%    (data cells — large for reliable colour detection)
//   CLK  = 6%     (clock cell)
//
// Active area = 94% of S.  Marker span (centroid-to-centroid) = 86% of S.
//
// Canonical coordinates (after warpPerspective maps marker centroids to
// corners of a 400×400 square):
//   k = 400 / (0.86 * S)     (scale from canvas to canonical)
//
//   Clock centre (canvas):
//     x = S/2,  y = pad + mS + gap + ckS/2
//     For S=400: x=200, y=12+32+6+12=62,  TL centroid y=28
//     canonical y = (62-28)*k = 34*(400/344) ≈ 40
//     canonical x = (200-28)*k = 172*(400/344) ≈ 200
//
//   Grid centre = canvas centre = (S/2, S/2)
//     relative to TL centroid: (0.43S, 0.43S)
//     canonical: 0.43/0.86 * 400 = 200
//     Cell size canonical: 0.22/0.86 * 400 ≈ 102
//     Half cell ≈ 51.  Centres = 200 ± 51 = {149, 251}
//     Sample hw = 60% of 51 ≈ 30
// ─────────────────────────────────────────────────────────────────────────────
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
