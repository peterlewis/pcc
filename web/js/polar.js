// Polar-plot canvas renderer for the satellite sky view.
//
// Layers, drawn bottom-to-top:
//   1. Sector heatmap  — peak SNR per 5°×5° cell (navy → purple → red ramp).
//   2. Horizon mask    — red tint from the lowest-ever el per 5° azimuth
//                         sector, showing persistent obstructions.
//   3. Grid            — elevation rings + compass spokes + N/E/S/W labels.
//   4. Trails          — one polyline per SatPass, age-faded.
//   5. Live satellites — constellation-coloured ring + SNR-heat inner fill
//                         + PRN label.
//
// The heatmap/horizon/trails layers are ported from
// Sources/PCC/Views/SkyView.swift → SkyPlotCanvas (same geometry and colour
// ramps). Live satellites are our own thing (the Mac app renders the current
// moment as "glow + dot" atop the live pass head).

import { PassAgeTier, smoothedAzEl, adaptiveSmoothingWindow } from './satpass.js';

const NORTH_OFFSET_RAD = -Math.PI / 2; // 0° azimuth = up = -Y
const AZ_BINS = 72;
const EL_BINS = 18;

export class PolarPlot {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.satellites = [];
        this.passes = [];
        this.activePRNs = new Set();
        this.horizonMask = new Array(AZ_BINS).fill(null);
        this.sectorHeatmap = Array.from({ length: AZ_BINS }, () => new Array(EL_BINS).fill(null));
        this.showHeatmap = true;
        this.showHorizon = true;
        this.showTrails = true;
        this.showLabels = true;
        this.smoothTrails = true;
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(canvas);
        this._resize();
    }

    // MARK: - Public setters ---------------------------------------------

    setSatellites(list) { this.satellites = list; this.draw(); }
    setPasses({ passes, activePRNs }) {
        this.passes = passes ?? [];
        this.activePRNs = activePRNs ?? new Set();
        this.draw();
    }
    setHorizonMask(mask) { this.horizonMask = mask ?? this.horizonMask; this.draw(); }
    setSectorHeatmap(heat) { this.sectorHeatmap = heat ?? this.sectorHeatmap; this.draw(); }
    setFlags({ showHeatmap, showHorizon, showTrails, showLabels, smoothTrails } = {}) {
        if (showHeatmap !== undefined)  this.showHeatmap = showHeatmap;
        if (showHorizon !== undefined)  this.showHorizon = showHorizon;
        if (showTrails !== undefined)   this.showTrails = showTrails;
        if (showLabels !== undefined)   this.showLabels = showLabels;
        if (smoothTrails !== undefined) this.smoothTrails = smoothTrails;
        this.draw();
    }

    // MARK: - Layout -----------------------------------------------------

    _resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width  = Math.floor(rect.width * dpr);
        this.canvas.height = Math.floor(rect.height * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.draw();
    }

    /// Project az (deg, 0=N clockwise) and elevation (deg) into canvas coords.
    /// Elevation maps radially: 90° at centre, 0° at rim.
    _project(azDeg, elDeg, cx, cy, radius) {
        const r = radius * (1 - Math.max(0, Math.min(90, elDeg)) / 90);
        const theta = azDeg * Math.PI / 180 + NORTH_OFFSET_RAD;
        return [cx + r * Math.cos(theta), cy + r * Math.sin(theta)];
    }

    // MARK: - Colour helpers ---------------------------------------------

    /// SNR → live-dot fill. Smooth red→yellow→green→cyan ramp over 0..50 dBHz.
    _snrColor(snr) {
        if (snr == null || snr <= 0) return 'rgba(128,128,128,0.4)';
        const t = Math.min(snr / 50, 1);
        let r, g, b;
        if (t < 0.4)      { r = 1; g = t / 0.4; b = 0; }
        else if (t < 0.7) { r = 1 - (t - 0.4) / 0.3; g = 1; b = 0; }
        else              { r = 0; g = 1; b = (t - 0.7) / 0.3; }
        return `rgb(${(r*255)|0},${(g*255)|0},${(b*255)|0})`;
    }

    /// SNR → sector heatmap colour. Mirrors SkyPlotCanvas.snrHeatColor:
    /// navy → purple → warm red, with alpha ramping from 0.25 to 0.50 as
    /// SNR rises so weak cells are visible but strong cells stand out.
    _heatColor(snr) {
        const lo = 10, hi = 50;
        const t = Math.min(1, Math.max(0, (snr - lo) / (hi - lo)));
        let r, g, b;
        if (t < 0.5) {
            const u = t / 0.5;
            r = 0.10 + (0.55 - 0.10) * u;
            g = 0.20 + (0.10 - 0.20) * u;
            b = 0.55 + (0.75 - 0.55) * u;
        } else {
            const u = (t - 0.5) / 0.5;
            r = 0.55 + (0.95 - 0.55) * u;
            g = 0.10 + (0.25 - 0.10) * u;
            b = 0.75 + (0.30 - 0.75) * u;
        }
        const a = 0.25 + 0.25 * t;
        return `rgba(${(r*255)|0},${(g*255)|0},${(b*255)|0},${a.toFixed(3)})`;
    }

    // MARK: - Draw root --------------------------------------------------

    draw() {
        const { ctx, canvas } = this;
        const w = canvas.width  / (window.devicePixelRatio || 1);
        const h = canvas.height / (window.devicePixelRatio || 1);
        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(w, h) / 2 - 18;
        // The canvas lives inside a .panel that is display:none until the
        // Satellites tab is activated; on first construction w/h are 0 and
        // radius goes negative — CanvasRenderingContext2D.arc throws on that.
        // Bail out; ResizeObserver + tab switch redraw once we have real dims.
        if (!(radius > 0)) return;

        ctx.clearRect(0, 0, w, h);

        // Background disc
        ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue('--polar-bg') || '#12161e';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();

        if (this.showHeatmap) this._drawSectorHeatmap(cx, cy, radius);
        if (this.showHorizon) this._drawHorizonMask(cx, cy, radius);
        this._drawGrid(cx, cy, radius);
        if (this.showTrails)  this._drawTrails(cx, cy, radius);
        this._drawSatellites(cx, cy, radius);
    }

    // MARK: - Sector heatmap ---------------------------------------------

    /// u-center style painted sky map: each observed 5°×5° cell rendered as
    /// a coloured wedge. Matches SkyPlotCanvas.drawSectorHeatmap.
    _drawSectorHeatmap(cx, cy, maxR) {
        const { ctx, sectorHeatmap } = this;
        let hasAny = false;
        outer: for (let a = 0; a < AZ_BINS; a++) {
            for (let e = 0; e < EL_BINS; e++) {
                if (sectorHeatmap[a][e] != null) { hasAny = true; break outer; }
            }
        }
        if (!hasAny) return;

        const sectorWidthDeg = 360 / AZ_BINS;   // 5°
        const elStepDeg      = 90  / EL_BINS;   // 5°
        const subSteps = 4;                      // chord subdivision per wedge

        for (let azBin = 0; azBin < AZ_BINS; azBin++) {
            for (let elBin = 0; elBin < EL_BINS; elBin++) {
                const snr = sectorHeatmap[azBin][elBin];
                if (snr == null) continue;

                const elLo = elBin * elStepDeg;
                const elHi = elLo + elStepDeg;
                const rOuter = (90 - elLo) / 90 * maxR;
                const rInner = (90 - elHi) / 90 * maxR;

                const azStart = azBin * sectorWidthDeg * Math.PI / 180;
                const azEnd   = (azBin + 1) * sectorWidthDeg * Math.PI / 180;

                ctx.beginPath();
                for (let i = 0; i <= subSteps; i++) {
                    const t = i / subSteps;
                    const a = azStart + (azEnd - azStart) * t + NORTH_OFFSET_RAD;
                    const x = cx + rOuter * Math.cos(a);
                    const y = cy + rOuter * Math.sin(a);
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                for (let i = subSteps; i >= 0; i--) {
                    const t = i / subSteps;
                    const a = azStart + (azEnd - azStart) * t + NORTH_OFFSET_RAD;
                    const x = cx + rInner * Math.cos(a);
                    const y = cy + rInner * Math.sin(a);
                    ctx.lineTo(x, y);
                }
                ctx.closePath();
                ctx.fillStyle = this._heatColor(snr);
                ctx.fill();
            }
        }
    }

    // MARK: - Horizon mask -----------------------------------------------

    /// Red-tinted wedge from each sector's minimum observed elevation to
    /// the rim, showing persistent obstructions. Mirrors
    /// SkyPlotCanvas.drawHorizonMask.
    _drawHorizonMask(cx, cy, maxR) {
        const { ctx, horizonMask } = this;
        let filled = 0;
        for (const v of horizonMask) if (v != null) filled++;
        if (filled < 6) return;

        const sectorWidthDeg = 360 / AZ_BINS;

        ctx.beginPath();
        // Outer circle clockwise
        for (let i = 0; i <= AZ_BINS; i++) {
            const idx = i % AZ_BINS;
            const a = idx * sectorWidthDeg * Math.PI / 180 + NORTH_OFFSET_RAD;
            const x = cx + maxR * Math.cos(a);
            const y = cy + maxR * Math.sin(a);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        // Inner perimeter counter-clockwise at mask elevation (0 if none)
        for (let i = AZ_BINS - 1; i >= 0; i--) {
            const elev = horizonMask[i] ?? 0;
            const r = (90 - elev) / 90 * maxR;
            const a = i * sectorWidthDeg * Math.PI / 180 + NORTH_OFFSET_RAD;
            ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,0,0,0.05)';
        ctx.fill();

        // Crisp mask outline through sectors with data (el > 2°)
        ctx.beginPath();
        ctx.lineWidth = 0.75;
        ctx.strokeStyle = 'rgba(255,0,0,0.28)';
        let lineStarted = false;
        for (let i = 0; i <= AZ_BINS; i++) {
            const idx = i % AZ_BINS;
            const elev = horizonMask[idx];
            if (!(elev != null && elev > 2)) { lineStarted = false; continue; }
            const r = (90 - elev) / 90 * maxR;
            const a = idx * sectorWidthDeg * Math.PI / 180 + NORTH_OFFSET_RAD;
            const x = cx + r * Math.cos(a);
            const y = cy + r * Math.sin(a);
            if (!lineStarted) { ctx.moveTo(x, y); lineStarted = true; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // MARK: - Grid -------------------------------------------------------

    _drawGrid(cx, cy, radius) {
        const { ctx } = this;
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        for (const el of [0, 30, 60]) {
            const r = radius * (1 - el / 90);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        for (const az of [0, 90, 180, 270]) {
            const [x, y] = this._project(az, 0, cx, cy, radius);
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(x, y);
            ctx.stroke();
        }

        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const labels = [{az:0,t:'N'},{az:90,t:'E'},{az:180,t:'S'},{az:270,t:'W'}];
        for (const { az, t } of labels) {
            const theta = az * Math.PI / 180 + NORTH_OFFSET_RAD;
            const lr = radius + 10;
            ctx.fillText(t, cx + lr * Math.cos(theta), cy + lr * Math.sin(theta));
        }

        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        for (const el of [30, 60]) {
            const r = radius * (1 - el / 90);
            ctx.fillText(`${el}°`, cx + 2, cy - r);
        }
    }

    // MARK: - Trails -----------------------------------------------------

    /// Draw one polyline per SatPass, oldest first so fresh passes layer on
    /// top. Alpha + stroke follow PassAgeTier.opacity/strokeWidth. Matches
    /// SkyPlotCanvas.drawTrails.
    _drawTrails(cx, cy, radius) {
        const { ctx } = this;
        const now = Date.now() / 1000;
        // Sort oldest-first
        const ordered = [...this.passes].sort((a, b) => {
            const ea = a.observations.length
                ? a.startTime.getTime() + a.observations[a.observations.length - 1].t * 1000
                : a.startTime.getTime();
            const eb = b.observations.length
                ? b.startTime.getTime() + b.observations[b.observations.length - 1].t * 1000
                : b.startTime.getTime();
            return ea - eb;
        });

        for (const pass of ordered) {
            const obs = pass.observations;
            if (!obs || obs.length < 2) continue;
            const isLive = this.activePRNs.has(pass.prn);
            const endMs = pass.startTime.getTime() + obs[obs.length - 1].t * 1000;
            const endAgeSec = Math.max(0, now - endMs / 1000);
            const alpha = PassAgeTier.opacity({ endAgeSec, isLive });
            const stroke = PassAgeTier.strokeWidth({ endAgeSec, isLive });
            const [r, g, b] = pass.constellation.rgb;

            // Optionally smooth with the same two-pass moving-average the
            // Mac app uses — removes the 1°-stepped NMEA staircase without
            // eating real orbital curvature.
            let samples;
            if (this.smoothTrails && obs.length >= 3) {
                const raw = obs.map(o => [o.az, o.el]);
                const win = adaptiveSmoothingWindow(raw.length);
                samples = smoothedAzEl(smoothedAzEl(raw, win), win);
            } else {
                samples = obs.map(o => [o.az, o.el]);
            }

            ctx.beginPath();
            for (let i = 0; i < samples.length; i++) {
                const [x, y] = this._project(samples[i][0], samples[i][1], cx, cy, radius);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
            ctx.lineWidth = stroke;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();

            // Live comet-head glow
            if (isLive) {
                const last = samples[samples.length - 1];
                const [x, y] = this._project(last[0], last[1], cx, cy, radius);
                const grad = ctx.createRadialGradient(x, y, 0, x, y, 10);
                grad.addColorStop(0, `rgba(${r},${g},${b},0.55)`);
                grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(x, y, 10, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    // MARK: - Live satellites --------------------------------------------

    _drawSatellites(cx, cy, radius) {
        const { ctx } = this;
        for (const sat of this.satellites) {
            if (sat.elevation < 0) continue;
            const [x, y] = this._project(sat.azimuth, sat.elevation, cx, cy, radius);
            const rgb = sat.constellation.rgb;

            ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.95)`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, 7, 0, Math.PI * 2);
            ctx.stroke();

            ctx.fillStyle = this._snrColor(sat.snr);
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();

            if (this.showLabels) {
                ctx.fillStyle = 'rgba(255,255,255,0.85)';
                ctx.font = '10px system-ui, sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText(sat.id, x + 9, y - 6);
            }
        }
    }
}
