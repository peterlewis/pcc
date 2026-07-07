// Port of Sources/PCC/SatPass.swift.
//
// This file mirrors the Swift original 1:1 — keep the two up to date
// together. See MAC_PARITY.md at the repo root for the mirror policy.
//
// Contains:
//  - SatObservation / SatPass data shape
//  - subSatellitePoint — spherical-Earth projection of az/el to a ground track
//  - Centered moving-average az/el smoothing with adaptive window
//  - PassAgeTier: opacity + stroke + maxPoints curves keyed off pass age
//  - TimeWindow: user-selectable render-window cutoffs
//  - RetentionWindow: persistence-retention windows
//
// None of these touch DOM or storage — they're pure data / math. The store
// layer (skytrailstore.js) and the renderers (polar.js / globe.js) consume
// them.

import { CONSTELLATIONS } from './nmea.js?v=2';

// MARK: - Observation record -----------------------------------------------

/// One recorded observation of a satellite. Shape mirrors Swift's
/// `SatObservation`; we use plain objects rather than typed arrays because
/// IndexedDB encodes them cheaply and the extra bytes vs the Swift 6-byte
/// packed form are irrelevant on disk.
export function makeObservation({ az, el, snr, t }) {
    return {
        az: az | 0,      // int16 0–359
        el: el | 0,      // int8  0–90
        snr: snr | 0,    // int8  0–99
        t: t | 0,        // uint16 seconds since pass start
    };
}

// MARK: - Pass-level helpers -----------------------------------------------

/// Peak elevation reached during this pass.
export function passPeakElevation(pass) {
    let max = 0;
    for (const o of pass.observations) if (o.el > max) max = o.el;
    return max;
}

/// Peak SNR observed during this pass.
export function passPeakSNR(pass) {
    let max = 0;
    for (const o of pass.observations) if (o.snr > max) max = o.snr;
    return max;
}

/// Pass duration in seconds — equal to the last observation's `t` offset.
export function passDuration(pass) {
    const obs = pass.observations;
    return obs.length ? obs[obs.length - 1].t : 0;
}

/// Pass endTime as a JS Date (startTime + last observation's t).
export function passEndTime(pass) {
    return new Date(pass.startTime.getTime() + passDuration(pass) * 1000);
}

// MARK: - Smoothing --------------------------------------------------------

/// Adaptive smoothing window. Two passes of this width ≈ a Gaussian with
/// σ ~ window/√3. Small samples: keep 3-tap honest. Long passes: step up
/// but cap at 11-tap so we don't eat real orbital curvature.
/// Mirrors SatPass.adaptiveSmoothingWindow.
export function adaptiveSmoothingWindow(count) {
    if (count < 20)  return 3;
    if (count < 80)  return 5;
    if (count < 160) return 7;
    if (count < 260) return 9;
    return 11;
}

/// Centered moving-average smoothing of (az, el) pairs in double precision.
/// Azimuth is unwrapped across the 0°/360° seam so 359°→1° doesn't average
/// to 180°. Returns one output per input (no drop). Safe to chain twice
/// for a near-Gaussian result. Mirrors SatPass.smoothedAzEl.
export function smoothedAzEl(pts, window) {
    const n = pts.length;
    if (n === 0) return [];
    if (!(window >= 3) || n < 3) return pts.slice();

    const unwrapped = new Float64Array(n);
    unwrapped[0] = pts[0][0];
    let prev = pts[0][0];
    for (let i = 1; i < n; i++) {
        let d = pts[i][0] - prev;
        while (d > 180)  d -= 360;
        while (d <= -180) d += 360;
        prev += d;
        unwrapped[i] = prev;
    }

    const half = window >> 1;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - half);
        const hi = Math.min(n - 1, i + half);
        const denom = hi - lo + 1;
        let azSum = 0, elSum = 0;
        for (let j = lo; j <= hi; j++) {
            azSum += unwrapped[j];
            elSum += pts[j][1];
        }
        let az = (azSum / denom) % 360;
        if (az < 0) az += 360;
        out[i] = [az, elSum / denom];
    }
    return out;
}

/// Evenly-spaced decimation preserving first and last sample. Mirrors
/// SatPass.decimate.
export function decimate(pts, maxPoints) {
    if (pts.length <= maxPoints || maxPoints <= 1) return pts.slice();
    const step = (pts.length - 1) / (maxPoints - 1);
    const out = new Array(maxPoints);
    for (let i = 0; i < maxPoints; i++) {
        out[i] = pts[Math.min(pts.length - 1, Math.floor(i * step))];
    }
    return out;
}

// MARK: - Geometry ---------------------------------------------------------

const EARTH_RADIUS_KM = 6371.0;

/// Observer-relative (az, el) → sub-satellite lat/lon using the constellation's
/// orbital altitude and spherical geometry. Returns null for el ≤ 0 or
/// degenerate inputs. Mirrors SatPass.subSatellitePointD.
export function subSatellitePoint({ azDeg, elDeg, constellation, observerLat, observerLon }) {
    if (!(elDeg > 0) || elDeg > 90) return null;
    const altitudeKm = constellation.altitudeKm ?? 20200; // defensive default (GPS)

    const toRad = Math.PI / 180;
    const elRad = elDeg * toRad;
    const azRad = azDeg * toRad;
    const latO  = observerLat * toRad;
    const lonO  = observerLon * toRad;

    // γ = acos(R·cos(el) / (R+h)) − el   — central angle at Earth's centre
    // between observer and sub-sat point. Using cos(el), not sin(el) —
    // the latter projects the sub-sat point behind the observer at high
    // elevations and amplifies el jitter on the ground track.
    const R  = EARTH_RADIUS_KM;
    const Rh = R + altitudeKm;
    const cosArg = Math.cos(elRad) * R / Rh;
    if (!(cosArg >= -1 && cosArg <= 1)) return null;
    const gamma = Math.acos(cosArg) - elRad;

    const sinLatS = Math.sin(latO) * Math.cos(gamma)
                  + Math.cos(latO) * Math.sin(gamma) * Math.cos(azRad);
    const latS = Math.asin(Math.max(-1, Math.min(1, sinLatS)));
    const lonS = lonO + Math.atan2(
        Math.sin(azRad) * Math.sin(gamma) * Math.cos(latO),
        Math.cos(gamma) - Math.sin(latO) * sinLatS
    );

    const lat = latS * 180 / Math.PI;
    const lon = lonS * 180 / Math.PI;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon: wrapLon(lon) };
}

/// Keep longitudes in [-180, 180] after arithmetic on them.
function wrapLon(lon) {
    let l = ((lon + 540) % 360) - 180;
    // Avoid -180 vs 180 inconsistency where it's inconsequential.
    if (l === -180) l = 180;
    return l;
}

// MARK: - Ground track points ----------------------------------------------

/// Smoothed + decimated ground-track for a pass. Each point carries its
/// (smoothed) elevation so 3D renderers can lift the point off the sphere
/// with the same formula as the live dot. Mirrors SatPass.groundTrackPoints.
///
/// `smoothingWindow`:
///   - 0  → adaptive (default)
///   - 1  → disabled (raw observations only)
///   - N≥3 → fixed width two-pass
export function groundTrackPoints({
    pass, observerLat, observerLon,
    maxPoints = Number.POSITIVE_INFINITY, smoothingWindow = 0,
}) {
    const base = pass.observations.map(o => [o.az, o.el]);
    const window = smoothingWindow > 0 ? smoothingWindow : adaptiveSmoothingWindow(base.length);
    const pass1  = smoothedAzEl(base, window);
    const pass2  = smoothedAzEl(pass1, window);
    const samples = decimate(pass2, Math.min(maxPoints, pass2.length));

    const out = [];
    for (const [az, el] of samples) {
        const coord = subSatellitePoint({
            azDeg: az, elDeg: el,
            constellation: pass.constellation,
            observerLat, observerLon,
        });
        if (coord) out.push({ lat: coord.lat, lon: coord.lon, elevation: el });
    }
    return out;
}

// MARK: - Age-based render tier -------------------------------------------

/// A pass's age determines how prominently it's rendered. The *tier* is
/// still a discrete bucket because it drives `maxPoints` (a perf knob),
/// where a handful of buckets is easier to reason about than a continuous
/// function. Opacity and stroke width are continuous curves keyed off raw
/// age — the previous per-tier constants produced visible step changes at
/// the 1h/24h/7d cliffs which looked like glitches. The curves below are
/// stretched-exponentials in √(age) with a non-zero floor, giving a rapid
/// near-term fade and a long gentle tail so week-old passes still read.
/// Mirrors `enum PassAgeTier` in SatPass.swift.
export const PassAgeTier = {
    live: 'live', recent: 'recent', today: 'today', week: 'week', archive: 'archive',

    /// Bucket a pass by its end-age in *seconds* (not ms).
    tier({ endAgeSec, isLive }) {
        if (isLive) return PassAgeTier.live;
        if (endAgeSec < 3600)    return PassAgeTier.recent;
        if (endAgeSec < 86400)   return PassAgeTier.today;
        if (endAgeSec < 604800)  return PassAgeTier.week;
        return PassAgeTier.archive;
    },

    /// Cap on observations rendered per pass — lower for old passes so
    /// frame time stays bounded as history accumulates.
    maxPoints(tier) {
        switch (tier) {
            case PassAgeTier.live:    return 400;
            case PassAgeTier.recent:  return 150;
            case PassAgeTier.today:   return 75;
            case PassAgeTier.week:    return 40;
            case PassAgeTier.archive: return 25;
            default: return 25;
        }
    },

    /// Smooth opacity fade. See SatPass.swift for waypoints.
    opacity({ endAgeSec, isLive }) {
        if (isLive) return 0.45;
        const ageH = Math.max(0, endAgeSec) / 3600;
        return 0.03 + 0.32 * Math.exp(-Math.sqrt(ageH / 16));
    },

    /// Smooth stroke-width taper. See SatPass.swift for waypoints.
    strokeWidth({ endAgeSec, isLive }) {
        if (isLive) return 2.2;
        const ageH = Math.max(0, endAgeSec) / 3600;
        return 0.8 + 1.4 * Math.exp(-Math.sqrt(ageH / 30));
    },
};

// MARK: - Time window filter ----------------------------------------------

/// User-selectable render window for the sky views. Mirrors `enum TimeWindow`.
export const TimeWindow = {
    live: 'live', m5: 'm5', m15: 'm15',
    h1: 'h1', h2: 'h2', h6: 'h6',
    d1: 'd1', d7: 'd7', d30: 'd30',
    all: 'all',

    all_cases: ['live', 'm5', 'm15', 'h1', 'h2', 'h6', 'd1', 'd7', 'd30', 'all'],

    /// Seconds ago cutoff; null means no filter (all time).
    cutoffSec(window) {
        switch (window) {
            case 'live': return 180;   // 3 min grace
            case 'm5':   return 300;
            case 'm15':  return 900;
            case 'h1':   return 3600;
            case 'h2':   return 7200;
            case 'h6':   return 21600;
            case 'd1':   return 86400;
            case 'd7':   return 604800;
            case 'd30':  return 2592000;
            case 'all':  return null;
            default:     return null;
        }
    },

    /// Short label for pickers.
    label(window) {
        switch (window) {
            case 'live': return 'Live';
            case 'm5':   return '5m';
            case 'm15':  return '15m';
            case 'h1':   return '1h';
            case 'h2':   return '2h';
            case 'h6':   return '6h';
            case 'd1':   return '24h';
            case 'd7':   return '7d';
            case 'd30':  return '30d';
            case 'all':  return 'All';
            default:     return String(window);
        }
    },
};

// MARK: - Retention window -------------------------------------------------

/// How long completed passes are kept. Separate from TimeWindow (which
/// decides what's rendered). Mirrors `enum RetentionWindow`.
export const RetentionWindow = {
    h1: 'h1', h6: 'h6', d1: 'd1', d7: 'd7', d30: 'd30', d90: 'd90', y1: 'y1', unlimited: 'unlimited',

    all_cases: ['h1', 'h6', 'd1', 'd7', 'd30', 'd90', 'y1', 'unlimited'],

    /// Seconds; null means keep forever.
    seconds(window) {
        switch (window) {
            case 'h1':  return 3600;
            case 'h6':  return 21600;
            case 'd1':  return 86400;
            case 'd7':  return 604800;
            case 'd30': return 2592000;
            case 'd90': return 7776000;
            case 'y1':  return 31536000;
            case 'unlimited': return null;
            default: return null;
        }
    },

    label(window) {
        switch (window) {
            case 'h1':  return '1 hour';
            case 'h6':  return '6 hours';
            case 'd1':  return '24 hours';
            case 'd7':  return '7 days';
            case 'd30': return '30 days';
            case 'd90': return '90 days';
            case 'y1':  return '1 year';
            case 'unlimited': return 'Unlimited';
            default: return String(window);
        }
    },

    /// Short tag matching the Swift rawValue (for display / persistence).
    tag(window) {
        switch (window) {
            case 'h1':  return '1h';
            case 'h6':  return '6h';
            case 'd1':  return '24h';
            case 'd7':  return '7d';
            case 'd30': return '30d';
            case 'd90': return '90d';
            case 'y1':  return '1y';
            case 'unlimited': return '∞';
            default: return String(window);
        }
    },
};

// MARK: - Constellation helpers -------------------------------------------

/// Ensure CONSTELLATIONS has altitudeKm + hex set for globe/heatmap use.
/// nmea.js owns the dict; this augments it in place the first time the
/// module loads so callers don't have to import two sources. Idempotent.
(function augmentConstellations() {
    const altitudes = { gps: 20200, glonass: 19100, galileo: 23222, beidou: 21528 };
    for (const key of Object.keys(CONSTELLATIONS)) {
        const c = CONSTELLATIONS[key];
        if (!c.altitudeKm) c.altitudeKm = altitudes[key] ?? 20200;
        if (!c.hex) {
            const [r, g, b] = c.rgb;
            c.hex = '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
        }
        if (!c.rgba) {
            c.rgba = (alpha) => `rgba(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]},${alpha})`;
        }
    }
})();
