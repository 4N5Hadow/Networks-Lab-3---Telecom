'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT CONSTANTS  — Shared by sender canvas and receiver sampler
//
// The sender canvas is a square of side S.
// Layout (fraction of S):
//
//   PAD (3% each side) → active area = 94% of S
//   Inside active area:
//     4 corner markers: 8% of S each (solid black squares)
//     Clock cell: 6% of S, centred top, between TL and TR markers
//     Data grid: 2×2 cells, each 18% of S — centred in active area
//       → grid occupies 36% × 36% of S (much larger than before)
//
// Canonical coordinate system (after warpPerspective):
//   The perspective transform maps marker CENTROIDS to the corners of
//   a CANON_SIZE × CANON_SIZE square. Because marker centroids are at
//   (pad + mS/2) from the canvas edge, the canonical space origin
//   corresponds to TL marker centroid, not the canvas corner.
//
//   In canonical space, the "marker span" (centroid-to-centroid distance)
//   equals CANON_SIZE on each axis.
//
//   Canonical positions:
//     clock:  x=CANON_SIZE/2, y = clockCentreY_relative_to_TL_centroid
//     cells:  computed from grid centre relative to marker centroids
// ─────────────────────────────────────────────────────────────────────────────
const LAYOUT = Object.freeze({
    // ── Canvas drawing fractions (of square canvas side S) ────────────────────
    PAD_F:      0.03,    // border padding
    MARKER_F:   0.08,    // finder marker side
    CLOCK_F:    0.06,    // clock cell side
    CELL_F:     0.18,    // data cell side (was 0.135 — now 33% bigger)
    CLOCK_GAP:  6,       // px gap between marker bottom edge and clock top edge

    // ── OpenCV canonical warp constants ──────────────────────────────────────
    //
    // After warp, marker centroids map to (0,0), (CS,0), (0,CS), (CS,CS).
    // All positions below are in this canonical space.
    //
    // Derivation:
    //   pad  = PAD_F * S = 0.03S
    //   mS   = MARKER_F * S = 0.08S
    //   act  = (1 - 2*PAD_F) * S = 0.94S
    //
    //   TL marker centroid (canvas): (pad + mS/2, pad + mS/2) = (0.07S, 0.07S)
    //   TR marker centroid (canvas): (pad + act - mS/2, pad + mS/2) = (0.93S, 0.07S)
    //   Marker span = 0.93S - 0.07S = 0.86S
    //
    //   In canonical space, 0.86S maps to CANON_SIZE.
    //   Scale factor: k = CANON_SIZE / (0.86 * S)
    //
    //   Clock centre (canvas): x = S/2, y = pad + mS + CLOCK_GAP + ckS/2
    //     relative to TL centroid: dx = S/2 - 0.07S = 0.43S, dy depends on S
    //     For S=400: y_canvas = 12 + 32 + 6 + 12 = 62, TL_centroid_y = 28
    //       dy = 62 - 28 = 34, canonical_y = 34 * (400 / 344) ≈ 40
    //       dx = 200 - 28 = 172, canonical_x = 172 * (400/344) ≈ 200
    //     → clock at (200, 40) with hw ≈ 10
    //
    //   Grid centre (canvas): (S/2, S/2) = (0.5S, 0.5S)
    //     relative to TL centroid: (0.43S, 0.43S)
    //     canonical: 0.43/0.86 * CS = 0.5 * CS = 200
    //     → grid centre at (200, 200)
    //   Cell size in canonical: CELL_F / 0.86 * CS = 0.18/0.86 * 400 ≈ 84 px
    //     → half cell ≈ 42, cell centres at 200 ± 42 = {158, 242}
    //     → sample hw = 60% of half-cell = 25 px
    //
    CANON_SIZE: 400,

    CANON_CLOCK: Object.freeze({ x: 200, y: 40, hw: 10 }),

    CANON_CELLS: Object.freeze([
        Object.freeze({ x: 158, y: 158, hw: 25 }),  // TL
        Object.freeze({ x: 242, y: 158, hw: 25 }),  // TR
        Object.freeze({ x: 158, y: 242, hw: 25 }),  // BL
        Object.freeze({ x: 242, y: 242, hw: 25 }),  // BR
    ]),
});

window.LAYOUT = LAYOUT;
