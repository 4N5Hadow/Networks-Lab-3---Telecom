'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// PHYSICAL TX  —  Canvas-based sender display
//
// Renders to a square <canvas>:
//   • 4 solid-black finder markers at the active-area corners   (always visible)
//   • 1 clock cell at top-center, toggling BLACK ↔ WHITE        (self-clocking)
//   • 2×2 data grid of coloured cells in the centre
//
// Layout fractions are taken from window.LAYOUT (layout.js must load first).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    const LO = window.LAYOUT;
    // cell color index → CSS hex string
    const CELL_HEX = ['#FFFFFF', '#FF0000', '#00FF00', '#0000FF'];

    class PhysicalTX {
        /** @param {HTMLCanvasElement} canvas */
        constructor(canvas) {
            this.cvs       = canvas;
            this.ctx       = canvas.getContext('2d');
            this.clockState = false;   // false = BLACK, true = WHITE
            this._symbols   = [];
            this._curSym    = 0;
            this.dwellMs    = 300;
            this._running   = false;
            this._timer     = null;
            /** Called with no args once all symbols have been displayed. */
            this.onDone     = null;
        }

        // ── Layout helpers ─────────────────────────────────────────────────────

        /** Returns pixel measurements for the current canvas size. */
        _dim() {
            const S   = this.cvs.width;   // canvas must be square
            const pad  = LO.PAD_F   * S;
            const act  = (1 - 2 * LO.PAD_F) * S;   // active area side
            const mS   = LO.MARKER_F * S;
            const ckS  = LO.CLOCK_F  * S;
            const cS   = LO.CELL_F   * S;
            return { S, pad, act, mS, ckS, cS };
        }

        // ── Drawing ────────────────────────────────────────────────────────────

        /**
         * Render one frame.
         * @param {number[]|null} cells  – [TL, TR, BL, BR] color indices 0-3, or null for idle
         */
        _draw(cells) {
            const ctx = this.ctx;
            const { S, pad, act, mS, ckS, cS } = this._dim();

            // Background — LIGHT GREY so black markers contrast clearly for camera detection
            ctx.fillStyle = '#d8d8d8';
            ctx.fillRect(0, 0, S, S);

            // ── Finder markers (always solid black) ──────────────────────────
            ctx.fillStyle = '#000000';
            ctx.fillRect(pad,           pad,           mS, mS);   // TL
            ctx.fillRect(pad+act-mS,    pad,           mS, mS);   // TR
            ctx.fillRect(pad,           pad+act-mS,    mS, mS);   // BL
            ctx.fillRect(pad+act-mS,    pad+act-mS,    mS, mS);   // BR

            // ── Clock cell ───────────────────────────────────────────────────
            const ckX = pad + act/2 - ckS/2;
            const ckY = pad + mS + LO.CLOCK_GAP;
            ctx.fillStyle = this.clockState ? '#FFFFFF' : '#000000';
            ctx.fillRect(ckX, ckY, ckS, ckS);

            // ── Data grid (2×2, centred in active area) ──────────────────────
            const gX = pad + act/2 - cS;    // left edge of TL cell
            const gY = pad + act/2 - cS;    // top  edge of TL cell

            if (cells) {
                for (let i = 0; i < 4; i++) {
                    ctx.fillStyle = CELL_HEX[cells[i]] || '#FFFFFF';
                    ctx.fillRect(gX + (i % 2) * cS, gY + Math.floor(i / 2) * cS, cS, cS);
                }
            } else {
                // idle placeholder
                ctx.fillStyle = '#1a1a2e';
                ctx.fillRect(gX, gY, cS * 2, cS * 2);
            }
        }

        /** Draw the idle state (no data, clock = black). */
        drawIdle() {
            this.clockState = false;
            this._draw(null);
        }

        /**
         * Draw the calibration frame:
         * clock = BLACK, cells = [WHITE, RED, GREEN, BLUE] (TL→TR→BL→BR).
         * Receiver samples this to set colour references.
         */
        drawCalibration() {
            this.clockState = false;
            this._draw([0, 1, 2, 3]);
        }

        // ── Transmission ───────────────────────────────────────────────────────

        /**
         * Start streaming symbols.
         * @param {number[][]} symbols  – Array of 6 symbol arrays, each [TL,TR,BL,BR]
         * @param {number}     dwellMs – How long to hold each symbol (ms)
         * @param {function}   onDone  – Callback when last symbol finishes
         */
        startTransmission(symbols, dwellMs, onDone) {
            this.stop();
            this._symbols  = symbols;
            this.dwellMs   = dwellMs || 300;
            this._curSym   = 0;
            this._running  = true;
            this.onDone    = onDone;
            this._advance();
        }

        _advance() {
            if (!this._running) return;
            if (this._curSym >= this._symbols.length) {
                this._running = false;
                this.drawIdle();
                if (this.onDone) this.onDone();
                return;
            }
            this.clockState = !this.clockState;          // toggle clock
            this._draw(this._symbols[this._curSym]);
            this._curSym++;
            this._timer = setTimeout(() => this._advance(), this.dwellMs);
        }

        /** Abort any in-progress transmission and return to idle. */
        stop() {
            this._running = false;
            if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        }

        /** Resize the canvas to a square of side `size` px and redraw idle. */
        resize(size) {
            this.cvs.width = this.cvs.height = size;
            this.drawIdle();
        }
    }

    window.PhysicalTX = PhysicalTX;
})();
