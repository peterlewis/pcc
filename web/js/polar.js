// Polar-plot canvas renderer for the satellite sky view.
//
// Draws a flattened hemisphere: zenith at centre, horizon at the rim,
// compass ticks + elevation rings in the background, satellites as
// coloured dots coloured by SNR. This is the *live* layer — no trail
// history yet (that's the SkyTrailStore port). Trails and sector heatmap
// are follow-ons.

const NORTH_OFFSET_RAD = -Math.PI / 2; // 0° azimuth = up = -Y

export class PolarPlot {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.satellites = [];
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(canvas);
        this._resize();
    }

    setSatellites(list) {
        this.satellites = list;
        this.draw();
    }

    _resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width  = Math.floor(rect.width * dpr);
        this.canvas.height = Math.floor(rect.height * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.draw();
    }

    /// Project az (deg, 0=N clockwise) and elevation (deg, 0=horizon) into
    /// canvas coords. Elevation maps radially: 90° at centre, 0° at rim.
    _project(azDeg, elDeg, cx, cy, radius) {
        const r = radius * (1 - Math.max(0, Math.min(90, elDeg)) / 90);
        const theta = azDeg * Math.PI / 180 + NORTH_OFFSET_RAD;
        return [cx + r * Math.cos(theta), cy + r * Math.sin(theta)];
    }

    _snrColor(snr) {
        if (snr == null || snr <= 0) return 'rgba(128,128,128,0.4)';
        const t = Math.min(snr / 50, 1);
        let r, g, b;
        if (t < 0.4)      { r = 1; g = t / 0.4; b = 0; }
        else if (t < 0.7) { r = 1 - (t - 0.4) / 0.3; g = 1; b = 0; }
        else              { r = 0; g = 1; b = (t - 0.7) / 0.3; }
        return `rgb(${(r*255)|0},${(g*255)|0},${(b*255)|0})`;
    }

    draw() {
        const { ctx, canvas } = this;
        const w = canvas.width  / (window.devicePixelRatio || 1);
        const h = canvas.height / (window.devicePixelRatio || 1);
        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(w, h) / 2 - 18;

        ctx.clearRect(0, 0, w, h);

        // Background disc
        ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue('--polar-bg') || '#12161e';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();

        // Elevation rings at 30°, 60°, plus the horizon
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        for (const el of [0, 30, 60]) {
            const r = radius * (1 - el / 90);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Compass spokes N/E/S/W
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        for (const az of [0, 90, 180, 270]) {
            const [x, y] = this._project(az, 0, cx, cy, radius);
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(x, y);
            ctx.stroke();
        }

        // Compass labels
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const labels = [
            { az: 0,   text: 'N' },
            { az: 90,  text: 'E' },
            { az: 180, text: 'S' },
            { az: 270, text: 'W' },
        ];
        for (const { az, text } of labels) {
            const theta = az * Math.PI / 180 + NORTH_OFFSET_RAD;
            const lr = radius + 10;
            ctx.fillText(text, cx + lr * Math.cos(theta), cy + lr * Math.sin(theta));
        }

        // Elevation ring labels (30°, 60°)
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        for (const el of [30, 60]) {
            const r = radius * (1 - el / 90);
            ctx.fillText(`${el}°`, cx + 2, cy - r);
        }

        // Satellites
        for (const sat of this.satellites) {
            if (sat.elevation < 0) continue;
            const [x, y] = this._project(sat.azimuth, sat.elevation, cx, cy, radius);
            const rgb = sat.constellation.rgb;

            // Outer ring — constellation colour
            ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.95)`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, 7, 0, Math.PI * 2);
            ctx.stroke();

            // Inner fill — SNR heat
            ctx.fillStyle = this._snrColor(sat.snr);
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();

            // PRN label
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.font = '10px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(sat.id, x + 9, y - 6);
        }
    }
}
