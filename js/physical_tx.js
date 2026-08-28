'use strict';

(function () {
    const CELL_HEX = ['#FFFFFF', '#FF0000', '#00FF00', '#0000FF']; // these are the colours shown at calibration in order

    class PhysicalTX {
        constructor() {
            this.clockEl = document.getElementById('tx-clock');
            this.cells = [
                document.getElementById('cell-0'),
                document.getElementById('cell-1'),
                document.getElementById('cell-2'),
                document.getElementById('cell-3'),
            ];
            this.clockState = false;
        }

        _draw(cells) {
            this.clockState = !this.clockState;
            if (this.clockEl) {
                this.clockEl.style.backgroundColor = this.clockState ? '#FFFFFF' : '#000000';
            }

            for (let i = 0; i < 4; i++) {
                if (this.cells[i]) {
                    this.cells[i].style.backgroundColor = cells ? CELL_HEX[cells[i]] : '#1a1a2e';
                }
            }
        }

        drawIdle() {
            this.clockState = false;
            if (this.clockEl) {
                this.clockEl.style.backgroundColor = '#000000';
            }
            for (let i = 0; i < 4; i++) {
                if (this.cells[i]) {
                    this.cells[i].style.backgroundColor = '#1a1a2e';
                }
            }
        }

        drawCalibration() {
            this.clockState = false;
            if (this.clockEl) {
                this.clockEl.style.backgroundColor = '#000000';
            }
            for (let i = 0; i < 4; i++) {
                if (this.cells[i]) {
                    this.cells[i].style.backgroundColor = CELL_HEX[i];
                }
            }
        }

        showSymbol(cells) {
            this._draw(cells);
        }

        stop() {
            this.drawIdle();
        }
    }

    window.PhysicalTX = PhysicalTX;
})();
