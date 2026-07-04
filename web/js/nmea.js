// NMEA 0183 parsers for GGA (fix + position), RMC (time + date),
// and GSV (satellites in view). Ports the parsing logic from
// SerialManager.swift to run against the Web Serial line stream.
//
// Every parser is pure and synchronous: pass in a raw NMEA line, get back a
// plain object (or `null` if the sentence is malformed / wrong type).
//
// The clock's GNSS module emits talker-prefixed variants: $GP (GPS),
// $GL (GLONASS), $GA (Galileo), $GB / $BD (BeiDou), and $GN (combined).
// GGA/RMC typically come as $GN since they're fix-aggregated; GSV is
// per-constellation.

export const CONSTELLATIONS = {
    gps:     { id: 'gps',     name: 'GPS',     prefix: 'G', rgb: [0, 122, 255] },
    glonass: { id: 'glonass', name: 'GLONASS', prefix: 'R', rgb: [255, 59, 48] },
    galileo: { id: 'galileo', name: 'Galileo', prefix: 'E', rgb: [255, 149, 0] },
    beidou:  { id: 'beidou',  name: 'BeiDou',  prefix: 'C', rgb: [90, 200, 250] },
};

export function constellationFromTalker(talker) {
    switch (talker) {
        case '$GP': return CONSTELLATIONS.gps;
        case '$GL': return CONSTELLATIONS.glonass;
        case '$GA': return CONSTELLATIONS.galileo;
        case '$GB': return CONSTELLATIONS.beidou;
        case '$BD': return CONSTELLATIONS.beidou;
        default: return null;
    }
}

/// Strip the `*XX` checksum and split on commas, keeping empty fields.
function splitSentence(line) {
    const stripped = line.split('*')[0].trim();
    return stripped.split(',');
}

/// Parse $xxGGA — position + fix.
/// Returns { lat, lon, altitudeM, fix, satsUsed, hdop } or null.
export function parseGGA(line) {
    const fields = splitSentence(line);
    if (fields.length < 10) return null;
    if (!fields[0].endsWith('GGA')) return null;
    const fix = parseInt(fields[6], 10);
    if (!Number.isFinite(fix) || fix <= 0) return { fix: 0 };

    const rawLat = parseFloat(fields[2]);
    const rawLon = parseFloat(fields[4]);
    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLon)) return null;
    if (!fields[3] || !fields[5]) return null;

    // DDMM.MMMM → decimal degrees
    const latDeg = Math.floor(rawLat / 100);
    let lat = latDeg + (rawLat - latDeg * 100) / 60;
    if (fields[3] === 'S') lat = -lat;

    const lonDeg = Math.floor(rawLon / 100);
    let lon = lonDeg + (rawLon - lonDeg * 100) / 60;
    if (fields[5] === 'W') lon = -lon;

    const altParsed = parseFloat(fields[9]);
    const hdopParsed = parseFloat(fields[8]);
    const satsParsed = parseInt(fields[7], 10);
    return {
        lat,
        lon,
        // parseFloat/parseInt can return 0 for a legitimate "0" field;
        // use isFinite so we keep that and only swap NaN → null.
        altitudeM: Number.isFinite(altParsed) ? altParsed : null,
        fix,
        satsUsed: Number.isFinite(satsParsed) ? satsParsed : 0,
        hdop: Number.isFinite(hdopParsed) ? hdopParsed : null,
    };
}

/// Parse $xxRMC — recommended minimum, gives UTC time + date.
/// Returns { utc: Date, active: boolean } or null.
export function parseRMC(line) {
    const fields = splitSentence(line);
    if (fields.length < 10) return null;
    if (!fields[0].endsWith('RMC')) return null;
    if (fields[2] !== 'A') return { active: false };

    const timeStr = fields[1];
    const dateStr = fields[9];
    if (timeStr.length < 6 || dateStr.length !== 6) return null;

    const hh = parseInt(timeStr.slice(0, 2), 10);
    const mm = parseInt(timeStr.slice(2, 4), 10);
    const ss = parseFloat(timeStr.slice(4));
    const day = parseInt(dateStr.slice(0, 2), 10);
    const mon = parseInt(dateStr.slice(2, 4), 10);
    const yr  = parseInt(dateStr.slice(4, 6), 10);
    if ([hh, mm, day, mon, yr].some(n => !Number.isFinite(n))) return null;

    const utc = new Date(Date.UTC(2000 + yr, mon - 1, day, hh, mm, Math.floor(ss),
                                  Math.round((ss - Math.floor(ss)) * 1000)));
    return { utc, active: true };
}

/// Parse $xxGSA — DOP + the PRNs used in the position solution.
/// Fields after the talker: mode(A/M), fixType(1/2/3), 12 PRN slots, PDOP,
/// HDOP, VDOP[, systemId]. The three DOP values sit at fixed indices 15/16/17
/// (the 12 PRN slots are always present, even when empty), so a trailing NMEA
/// 4.10 systemId field doesn't shift them. Returns
/// { fixType, pdop, hdop, vdop, usedPRNs } or null.
export function parseGSA(line) {
    const f = splitSentence(line);
    if (f.length < 18) return null;
    if (!f[0].endsWith('GSA')) return null;
    const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : null; };
    const usedPRNs = [];
    for (let i = 3; i <= 14; i++) { const p = parseInt(f[i], 10); if (Number.isFinite(p)) usedPRNs.push(p); }
    return { fixType: parseInt(f[2], 10) || 0, pdop: num(f[15]), hdop: num(f[16]), vdop: num(f[17]), usedPRNs };
}

/// GSV (satellites in view) parser with multi-message reassembly.
///
/// GSV is multi-message: a single "frame" may span up to 4 sentences,
/// each carrying up to 4 satellites. NMEA 4.10+ also appends a signal ID
/// (e.g. `,1` for GPS L1 C/A) as the trailing field, meaning the same
/// constellation can emit multiple concurrent GSV streams on different
/// signals — we key buffers by (talker, signal) so they don't overwrite
/// each other.
///
/// The buffer emits a `satellites` callback with a merged, deduplicated
/// snapshot once every ~100ms of quiet — same debounce as the Mac app.
export class GSVBuffer {
    constructor({ onSatellites, debounceMs = 100 } = {}) {
        this.onSatellites = onSatellites;
        this.debounceMs = debounceMs;
        this._buffers = new Map();    // bufferKey → [{id, prn, constellation, elevation, azimuth, snr}]
        this._debounceTimer = null;
    }

    push(line) {
        const fields = splitSentence(line);
        if (fields.length < 4) return;
        if (!fields[0].endsWith('GSV')) return;
        const talker = fields[0].slice(0, 3);
        const constellation = constellationFromTalker(talker);
        if (!constellation) return;

        const numMsg = parseInt(fields[1], 10);
        const msgNum = parseInt(fields[2], 10);
        if (!Number.isFinite(numMsg) || !Number.isFinite(msgNum)) return;

        // Detect trailing signal ID (NMEA 4.10+): when data-field count is
        // 4n+1, the extra field is the signal-ID byte.
        const dataFields = fields.length - 4;
        const signalId = (dataFields > 0 && dataFields % 4 === 1) ? (fields[fields.length - 1] || '') : '';
        const bufferKey = `${talker}_${signalId}`;

        if (msgNum === 1) {
            this._buffers.set(bufferKey, []);
        }
        if (!this._buffers.has(bufferKey)) {
            // First message we've seen for this key wasn't msgNum 1 —
            // drop rather than record a partial frame.
            return;
        }

        for (let i = 4; i + 3 < fields.length; i += 4) {
            const prn = parseInt(fields[i], 10);
            const elevation = parseInt(fields[i + 1], 10);
            const azimuth = parseInt(fields[i + 2], 10);
            const snrRaw = fields[i + 3];
            if (!Number.isFinite(prn) || !Number.isFinite(elevation) || !Number.isFinite(azimuth)) continue;
            const snr = snrRaw === '' ? null : parseInt(snrRaw, 10);
            this._buffers.get(bufferKey).push({
                id: `${constellation.prefix}${prn}`,
                prn,
                constellation,
                elevation,
                azimuth,
                snr: Number.isFinite(snr) ? snr : null,
            });
        }

        if (msgNum === numMsg && this.onSatellites) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => this._flush(), this.debounceMs);
        }
    }

    _flush() {
        // Dedup across all buffers by satellite id, preferring entries
        // with SNR data (same precedence rule as the Mac app).
        const merged = new Map();
        for (const sats of this._buffers.values()) {
            for (const sat of sats) {
                const existing = merged.get(sat.id);
                if (existing) {
                    if (existing.snr == null && sat.snr != null) {
                        merged.set(sat.id, sat);
                    }
                } else {
                    merged.set(sat.id, sat);
                }
            }
        }
        this.onSatellites(Array.from(merged.values()));
    }
}
