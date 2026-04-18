// Web-side host for the shared 3D globe renderer at web/globe/index.html.
//
// That HTML is shipped identically in the Mac app (Sources/PCC/Resources/Globe/)
// and driven via WKWebView-evaluated `updateElements` / `updatePaths` /
// `setSunDirection` / `updateRings` / `setClockFormat` / `focusOn` calls.
// This module wraps those same globals with an iframe transport so feature
// work on the globe happens in one place — see MAC_PARITY.md.
//
// Upstream input data mirrors what GlobeWebView.buildUpdateJS produces in
// Swift: satellites + celestials as HTML-element data, trails as pathsData,
// observer as ring. The projection math for sats and celestials is here
// (so the Swift and web sides agree vertex-for-vertex) and shared with
// SkyGlobeView via SatPass.swift — satpass.js ports the same geometry.

import {
    groundTrackPoints, PassAgeTier, subSatellitePoint
} from './satpass.js';
import { subSolarPoint } from './astronomy.js';

/// Altitude offset (globe radii) applied to the sub-satellite point so live
/// dots and recorded trails float clearly over the sphere, with higher
/// elevations rendering higher. Matches SkyGlobeView.satAltitude.
function satAltitude(elDeg) {
    const el = Math.max(0, Math.min(90, elDeg));
    return 0.02 + (el / 90) * 0.08;
}

/// Project a celestial body (sun/moon) from observer-local (az, alt) to a
/// lat/lng on the globe above the observer. Matches
/// GlobeWebView.celestialCoordinate — keep this in sync.
function celestialCoordinate(pos, observerLat, observerLon) {
    if (!(pos.altitude > 0)) return null;
    const angularDist = (90 - pos.altitude) / 90 * 25;
    const azRad = pos.azimuth * Math.PI / 180;
    const distRad = angularDist * Math.PI / 180;
    const latRad = observerLat * Math.PI / 180;
    const lonRad = observerLon * Math.PI / 180;
    const lat = Math.asin(
        Math.sin(latRad) * Math.cos(distRad)
        + Math.cos(latRad) * Math.sin(distRad) * Math.cos(azRad)
    );
    const lon = lonRad + Math.atan2(
        Math.sin(azRad) * Math.sin(distRad) * Math.cos(latRad),
        Math.cos(distRad) - Math.sin(latRad) * Math.sin(lat)
    );
    return { latitude: lat * 180 / Math.PI, longitude: lon * 180 / Math.PI };
}

export class Globe3D {
    constructor(iframe, { onLog, onClockToggle, onClockCycleFormat } = {}) {
        this.iframe = iframe;
        this.ready = false;
        this._pending = null;      // latest snapshot waiting for globe to be ready
        this._sunLatLon = null;
        this._clock = { format: 'matchClock', visible: true };
        this.onLog = onLog;
        this.onClockToggle = onClockToggle;
        this.onClockCycleFormat = onClockCycleFormat;

        window.addEventListener('message', (ev) => {
            if (ev.source !== iframe.contentWindow) return;
            const m = ev.data;
            if (!m || typeof m !== 'object' || typeof m.channel !== 'string') return;
            switch (m.channel) {
                case 'globeReady':
                    this.ready = true;
                    this._flushPending();
                    break;
                case 'globeLog':
                    if (this.onLog) this.onLog(m.body);
                    break;
                case 'clockToggle':
                    if (this.onClockToggle) this.onClockToggle();
                    break;
                case 'clockCycleFormat':
                    if (this.onClockCycleFormat) this.onClockCycleFormat();
                    break;
            }
        });
    }

    /// Update the globe with the latest snapshot. Args mirror
    /// GlobeWebView.buildUpdateJS — callers hand in everything the globe
    /// cares about and this method assembles the same JSON shape.
    update({
        satellites, sunPosition, moonPosition,
        observerLat, observerLon,
        passes, activePRNs, now = new Date(),
        showSatellites = true, showCelestials = true, showLabels = true,
        smoothTrails = true,
    }) {
        // Same trail-stroke boost as the Mac side so lines read at a similar
        // weight to the Canvas polar plot.
        const trailStrokeScale = 1.7;

        const satData = [];
        if (showSatellites && observerLat != null && observerLon != null) {
            for (const sat of satellites) {
                if ((sat.snr ?? 0) <= 0) continue;
                const coord = subSatellitePoint({
                    azDeg: sat.azimuth, elDeg: sat.elevation,
                    constellation: sat.constellation,
                    observerLat, observerLon,
                });
                if (!coord) continue;
                const isLive = activePRNs && activePRNs.has(sat.id);
                const dotAlpha = isLive ? 0.92 : 0.72;
                satData.push({
                    lat: coord.lat, lng: coord.lon,
                    alt: satAltitude(sat.elevation),
                    color: sat.constellation.hex,
                    fill: sat.constellation.rgba(dotAlpha),
                    size: isLive ? 9 : 7,
                    name: sat.id,
                    label: showLabels ? sat.id : '',
                    type: isLive ? 'live' : 'satellite',
                });
            }
        }

        // Trail paths — one polyline per pass, altitude per point using the
        // same elevation-to-radius formula as live sats.
        const pathData = [];
        if (observerLat != null && observerLon != null && passes) {
            const ordered = [...passes].sort((a, b) => {
                const ea = a.startTime.getTime() + (a.observations.at(-1)?.t ?? 0) * 1000;
                const eb = b.startTime.getTime() + (b.observations.at(-1)?.t ?? 0) * 1000;
                return ea - eb;
            });
            const nowMs = now.getTime();
            for (const pass of ordered) {
                const isLive = activePRNs && activePRNs.has(pass.prn);
                const endMs = pass.startTime.getTime() + (pass.observations.at(-1)?.t ?? 0) * 1000;
                const endAgeSec = Math.max(0, (nowMs - endMs) / 1000);
                const samples = groundTrackPoints({
                    pass, observerLat, observerLon,
                    maxPoints: Number.POSITIVE_INFINITY,
                    smoothingWindow: smoothTrails ? 0 : 1,
                });
                if (samples.length < 2) continue;
                const coords = samples.map(s => [s.lat, s.lon, satAltitude(s.elevation)]);
                const alpha = PassAgeTier.opacity({ endAgeSec, isLive });
                const stroke = PassAgeTier.strokeWidth({ endAgeSec, isLive }) * trailStrokeScale;
                pathData.push({
                    coords,
                    color: pass.constellation.rgba(alpha),
                    stroke,
                });
            }
        }

        // Sun / Moon as HTML elements floating above the observer's sky.
        const celestialData = [];
        if (showCelestials && observerLat != null && observerLon != null) {
            if (sunPosition && sunPosition.altitude > 0) {
                const coord = celestialCoordinate(sunPosition, observerLat, observerLon);
                if (coord) celestialData.push({
                    lat: coord.latitude, lng: coord.longitude,
                    alt: 0.30,
                    color: 'rgba(255,230,100,0.9)',
                    fill: 'rgba(255,230,100,0.85)',
                    size: 18,
                    name: 'Sun', label: '', type: 'celestial',
                });
            }
            if (moonPosition && moonPosition.altitude > 0) {
                const coord = celestialCoordinate(moonPosition, observerLat, observerLon);
                if (coord) celestialData.push({
                    lat: coord.latitude, lng: coord.longitude,
                    alt: 0.24,
                    color: 'rgba(230,232,240,0.9)',
                    fill: 'rgba(230,232,240,0.85)',
                    size: 11,
                    name: 'Moon', label: '', type: 'celestial',
                });
            }
        }

        // Rings = observer marker.
        const rings = (observerLat != null && observerLon != null)
            ? [{ lat: observerLat, lng: observerLon }]
            : [];

        // Sub-solar point drives the day/night terminator.
        const sub = subSolarPoint(now);
        this._sunLatLon = sub;

        this._pending = {
            elements: [...satData, ...celestialData],
            paths: pathData,
            rings,
            sub,
            observer: (observerLat != null && observerLon != null)
                ? { lat: observerLat, lon: observerLon } : null,
        };
        this._flushPending();
    }

    /// Mirrors GlobeClockSettings on the Mac side.
    setClockFormat(format, visible) {
        this._clock = { format, visible };
        this._callGlobe(w => w.setClockFormat && w.setClockFormat(format, !!visible));
    }

    _flushPending() {
        if (!this.ready || !this._pending) return;
        const snap = this._pending;
        this._callGlobe((w) => {
            w.setSunDirection && w.setSunDirection(snap.sub.latitude, snap.sub.longitude);
            w.setClockFormat && w.setClockFormat(this._clock.format, !!this._clock.visible);
            w.updateElements && w.updateElements(snap.elements);
            w.updateRings && w.updateRings(snap.rings);
            w.updatePaths && w.updatePaths(snap.paths);
            if (snap.observer) w.focusOn && w.focusOn(snap.observer.lat, snap.observer.lon);
        });
    }

    _callGlobe(fn) {
        try {
            const w = this.iframe.contentWindow;
            if (!w) return;
            fn(w);
        } catch (err) {
            console.warn('Globe RPC failed:', err);
        }
    }
}
