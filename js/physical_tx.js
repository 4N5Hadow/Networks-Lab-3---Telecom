'use strict';
(function () {
    const LO = window.LAYOUT;
    const CELL_HEX = ['#FFFFFF', '#FF0000', '#00FF00', '#0000FF'];

    class PhysicalTX {
        constructor(canvas) {
            this.cvs        = canvas;
            this.ctx        = canvas.getContext('2d');
            this.clockState = false;
            this._symbols   = [];
            this._curSym    = 0;
            this.dwellMs    = 300;
            this._running   = false;
            this._timer     = null;
            this.onDone     = null;
        }

        _dim() {
            const S   = this.cvs.width;
            const pad = LO.PAD_F * S;
            const act = (1 - 2 * LO.PAD_F) * S;
            const mS  = LO.MARKER_F * S;
            const ckS = LO.CLOCK_F * S;
            const cS  = LO.CELL_F * S;
            return { S, pad, act, mS, ckS, cS };
        }

        _draw(cells) {
            const ctx = this.ctx;
            const { S, pad, act, mS, ckS, cS } = this._dim();

            ctx.fillStyle = '#808080';
            ctx.fillRect(0, 0, S, S);

            ctx.fillStyle = '#FF00FF';
            ctx.fillRect(pad,            pad,            mS, mS);
            ctx.fillRect(pad + act - mS, pad,            mS, mS);
            ctx.fillRect(pad,            pad + act - mS, mS, mS);
            ctx.fillRect(pad + act - mS, pad + act - mS, mS, mS);

            const ckX = pad + act / 2 - ckS / 2;
            const ckY = pad + mS + LO.CLOCK_GAP;
            ctx.fillStyle = this.clockState ? '#FFFFFF' : '#000000';
            ctx.fillRect(ckX, ckY, ckS, ckS);
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 2;
            ctx.strokeRect(ckX, ckY, ckS, ckS);

            const gX = pad + act / 2 - cS;
            const gY = pad + act / 2 - cS;

            if (cells) {
                for (let i = 0; i < 4; i++) {
                    const cx = gX + (i % 2) * cS;
                    const cy = gY + Math.floor(i / 2) * cS;
                    ctx.fillStyle = CELL_HEX[cells[i]] || '#FFFFFF';
                    ctx.fillRect(cx, cy, cS, cS);
                    ctx.strokeStyle = '#000000';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(cx, cy, cS, cS);
                }
            } else {
                ctx.fillStyle = '#1a1a2e';
                ctx.fillRect(gX, gY, cS * 2, cS * 2);
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = 2;
                ctx.strokeRect(gX, gY, cS * 2, cS * 2);
            }
        }

        drawIdle() {
            this.clockState = false;
            this._draw(null);
        }

        drawCalibration() {
            this.clockState = false;
            this._draw([0, 1, 2, 3]);
        }

        showSymbol(cells) {
            this.clockState = !this.clockState;
            this._draw(cells);
        }

        startTransmission(symbols, dwellMs, onDone) {
            this.stop();
            this._symbols = symbols;
            this.dwellMs  = dwellMs || 300;
            this._curSym  = 0;
            this._running = true;
            this.onDone   = onDone;
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
            this.clockState = !this.clockState;
            this._draw(this._symbols[this._curSym]);
            this._curSym++;
            this._timer = setTimeout(() => this._advance(), this.dwellMs);
        }

        stop() {
            this._running = false;
            if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        }

        resize(size) {
            this.cvs.width = this.cvs.height = size;
            this.drawIdle();
        }
    }

    window.PhysicalTX = PhysicalTX;
})();
