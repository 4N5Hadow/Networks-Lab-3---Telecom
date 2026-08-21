'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT CONSTANTS  (shared by sender canvas renderer and receiver sampler)
//
// Two coordinate systems:
//   A) Canvas-fraction  (PAD_F, MARKER_F, etc.) — for drawing
//   B) Bilinear / CANON  — for receiver sampling after perspective warp
//
// CANON_SIZE = 400 px (square canonical view after warpPerspective)
// In the canonical view, the perspective transform maps:
//   camera TL-marker-centroid → (0,   0)
//   camera TR-marker-centroid → (400, 0)
//   camera BL-marker-centroid → (0,   400)
//   camera BR-marker-centroid → (400, 400)
//
// LAYOUT positions (u, v) multiplied by CANON_SIZE give canonical pixel coords.
// ─────────────────────────────────────────────────────────────────────────────
const LAYOUT = Object.freeze({
    // ── Canvas drawing fractions (of square canvas side S) ────────────────────
    PAD_F:      0.05,   // border padding
    MARKER_F:   0.108,  // finder marker side  (= 0.9 × 0.12)
    CLOCK_F:    0.081,  // clock cell side     (= 0.9 × 0.09)
    CELL_F:     0.135,  // data cell side      (= 0.9 × 0.15)
    CLOCK_GAP:  8,      // px gap between marker bottom and clock top

    // ── Bilinear normalised positions ─────────────────────────────────────────
    // Reference quad: TL→(0,0)  TR→(1,0)  BL→(0,1)  BR→(1,1)
    // (Derived: u_cell = (active/2 − cellS/2 − markerS/2) / markerSpan ≈ 0.414)
    CLOCK_U: 0.500,
    CLOCK_V: 0.133,
    CELLS: Object.freeze([
        Object.freeze({ u: 0.414, v: 0.414 }),  // TL
        Object.freeze({ u: 0.586, v: 0.414 }),  // TR
        Object.freeze({ u: 0.414, v: 0.586 }),  // BL
        Object.freeze({ u: 0.586, v: 0.586 }),  // BR
    ]),

    // ── OpenCV canonical warp constants ──────────────────────────────────────
    CANON_SIZE: 400,   // pixels (square output of warpPerspective)

    // Clock cell in canonical pixel space
    //   centre = (CLOCK_U × 400, CLOCK_V × 400) = (200, 53)
    //   hw: inner 60 % of clock cell = CLOCK_F × CANON_SIZE / (2 × markerSpan/markerSpan) × 0.6
    //     ≈ 0.081 × 400 / 0.792 × 0.3 ≈ 12 px
    CANON_CLOCK: Object.freeze({ x: 200, y: 53, hw: 12 }),

    // Data cells in canonical pixel space  (LAYOUT u,v × 400)
    //   hw: inner 60 % of cell ≈ 0.135 × 400 / 0.792 × 0.3 ≈ 20 px
    CANON_CELLS: Object.freeze([
        Object.freeze({ x: 166, y: 166, hw: 20 }),  // TL
        Object.freeze({ x: 234, y: 166, hw: 20 }),  // TR
        Object.freeze({ x: 166, y: 234, hw: 20 }),  // BL
        Object.freeze({ x: 234, y: 234, hw: 20 }),  // BR
    ]),
});

window.LAYOUT = LAYOUT;
