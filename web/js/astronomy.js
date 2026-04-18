// Solar / lunar position, sunrise-sunset, equation of time, and the
// Maidenhead grid locator. Direct port of `Astronomy.swift` — same
// algorithms, same J2000 epoch, same ~2° accuracy on the lunar position.
//
// All angles are degrees at the public surface; conversions happen inline.
// Keep in sync with the Swift version when tweaking — the Mac app and the
// web app should report identical values for the same time/place.

const J2000_UNIX = 946728000; // 2000-01-01 12:00 UTC as Unix seconds
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function julianDate(date) {
    return (date.getTime() / 1000 - J2000_UNIX) / 86400;
}

function wrap360(x) {
    let v = x % 360;
    if (v < 0) v += 360;
    return v;
}

export function sunPosition(date, latitude, longitude) {
    const n = julianDate(date);
    const L = wrap360(280.460 + 0.9856474 * n);
    const g = wrap360(357.528 + 0.9856003 * n);
    const gRad = g * DEG;

    const lambda = L + 1.915 * Math.sin(gRad) + 0.020 * Math.sin(2 * gRad);
    const lambdaRad = lambda * DEG;
    const epsilon = (23.439 - 0.0000004 * n) * DEG;

    const alpha = Math.atan2(Math.cos(epsilon) * Math.sin(lambdaRad), Math.cos(lambdaRad)) * RAD;
    const delta = Math.asin(Math.sin(epsilon) * Math.sin(lambdaRad));

    let gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    if (gmst < 0) gmst += 24;
    const lst = gmst * 15 + longitude;
    const ha = (lst - alpha) * DEG;
    const latRad = latitude * DEG;

    const sinAlt = Math.sin(latRad) * Math.sin(delta) + Math.cos(latRad) * Math.cos(delta) * Math.cos(ha);
    const altitude = Math.asin(sinAlt) * RAD;

    let azimuth = Math.atan2(-Math.sin(ha), Math.tan(delta) * Math.cos(latRad) - Math.sin(latRad) * Math.cos(ha)) * RAD;
    if (azimuth < 0) azimuth += 360;

    return { altitude, azimuth };
}

export function subSolarPoint(date) {
    const n = julianDate(date);
    const L = wrap360(280.460 + 0.9856474 * n);
    const g = wrap360(357.528 + 0.9856003 * n);
    const gRad = g * DEG;
    const lambda = L + 1.915 * Math.sin(gRad) + 0.020 * Math.sin(2 * gRad);
    const lambdaRad = lambda * DEG;
    const epsilon = (23.439 - 0.0000004 * n) * DEG;

    const alpha = Math.atan2(Math.cos(epsilon) * Math.sin(lambdaRad), Math.cos(lambdaRad)) * RAD;
    const delta = Math.asin(Math.sin(epsilon) * Math.sin(lambdaRad)) * RAD;

    let gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    if (gmst < 0) gmst += 24;

    let lon = alpha - gmst * 15;
    lon = lon % 360;
    if (lon > 180) lon -= 360;
    else if (lon <= -180) lon += 360;

    return { latitude: delta, longitude: lon };
}

/// Sunrise/sunset/twilight at the observer's latitude for a given calendar
/// day. Returns an object of Date values, or null in polar-day/night cases
/// where the sun never crosses the relevant altitude.
export function sunTimes(date, latitude, longitude) {
    const noon = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        12, 0, 0
    ));

    const n = julianDate(noon);
    const g = wrap360(357.528 + 0.9856003 * n);
    const gRad = g * DEG;
    const L = wrap360(280.460 + 0.9856474 * n);
    const lambda = L + 1.915 * Math.sin(gRad) + 0.020 * Math.sin(2 * gRad);
    const lambdaRad = lambda * DEG;
    const epsilon = (23.439 - 0.0000004 * n) * DEG;
    const delta = Math.asin(Math.sin(epsilon) * Math.sin(lambdaRad));

    const B = (360 / 365 * (n + 10)) * DEG;
    const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(B) - 0.032077 * Math.sin(B)
                          - 0.014615 * Math.cos(2 * B) - 0.040849 * Math.sin(2 * B));

    const latRad = latitude * DEG;

    function hourAngle(sunAngleDeg) {
        const cosOmega = (Math.sin(sunAngleDeg * DEG) - Math.sin(latRad) * Math.sin(delta))
                       / (Math.cos(latRad) * Math.cos(delta));
        if (cosOmega < -1 || cosOmega > 1) return null;
        return Math.acos(cosOmega) * RAD;
    }

    const omega = hourAngle(-0.833);
    if (omega == null) return null;

    const solarNoonUTC = 12 - eot / 60 - longitude / 15;
    const rise = solarNoonUTC - omega / 15;
    const set  = solarNoonUTC + omega / 15;

    const goldenOmega   = hourAngle(6.0)  ?? omega;
    const civilOmega    = hourAngle(-6.0) ?? omega;
    const nauticalOmega = hourAngle(-12.0) ?? civilOmega;

    const goldenStart   = solarNoonUTC + goldenOmega   / 15;
    const civilEnd      = solarNoonUTC + civilOmega    / 15;
    const nauticalEnd   = solarNoonUTC + nauticalOmega / 15;

    const make = (utcHours) => new Date(noon.getTime() + (utcHours - 12) * 3600_000);

    return {
        sunrise: make(rise),
        solarNoon: make(solarNoonUTC),
        sunset: make(set),
        goldenHourStart: make(goldenStart),
        goldenHourEnd: make(set),
        civilTwilight: make(civilEnd),
        nauticalTwilight: make(nauticalEnd),
    };
}

export function equationOfTime(date) {
    const n = julianDate(date);
    const B = (360 / 365 * (n + 10)) * DEG;
    return 229.18 * (0.000075 + 0.001868 * Math.cos(B) - 0.032077 * Math.sin(B)
                      - 0.014615 * Math.cos(2 * B) - 0.040849 * Math.sin(2 * B));
}

export function moonPosition(date, latitude, longitude) {
    const n = julianDate(date);
    const L0 = wrap360(218.316 + 13.176396 * n);
    const M  = wrap360(134.963 + 13.064993 * n);
    const F  = wrap360(93.272 + 13.229350 * n);

    const MRad = M * DEG;
    const FRad = F * DEG;

    const lonMoon = L0 + 6.289 * Math.sin(MRad);
    const latMoon = 5.128 * Math.sin(FRad);
    const lonRad = lonMoon * DEG;
    const latRad = latMoon * DEG;

    const epsilon = (23.439 - 0.0000004 * n) * DEG;

    const alpha = Math.atan2(
        Math.sin(lonRad) * Math.cos(epsilon) - Math.tan(latRad) * Math.sin(epsilon),
        Math.cos(lonRad)
    ) * RAD;

    const delta = Math.asin(
        Math.sin(latRad) * Math.cos(epsilon) + Math.cos(latRad) * Math.sin(epsilon) * Math.sin(lonRad)
    );

    let gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    if (gmst < 0) gmst += 24;
    const lst = gmst * 15 + longitude;
    const ha = (lst - alpha) * DEG;
    const obsLatRad = latitude * DEG;

    const sinAlt = Math.sin(obsLatRad) * Math.sin(delta) + Math.cos(obsLatRad) * Math.cos(delta) * Math.cos(ha);
    const altitude = Math.asin(sinAlt) * RAD;

    let azimuth = Math.atan2(-Math.sin(ha), Math.tan(delta) * Math.cos(obsLatRad) - Math.sin(obsLatRad) * Math.cos(ha)) * RAD;
    if (azimuth < 0) azimuth += 360;

    return { altitude, azimuth };
}

export function moonPhase(date) {
    const n = julianDate(date);
    let phase = ((n - 6.26) / 29.53059) % 1;
    if (phase < 0) phase += 1;
    return phase;
}

/// Lat/lon → 6-character Maidenhead grid locator (e.g. IO81wh).
export function maidenhead(latitude, longitude) {
    const lon = longitude + 180;
    const lat = latitude + 90;

    const fieldLon = String.fromCharCode(Math.floor(lon / 20) + 65);
    const fieldLat = String.fromCharCode(Math.floor(lat / 10) + 65);
    const squareLon = Math.floor((lon % 20) / 2);
    const squareLat = Math.floor(lat % 10);
    const subLon = String.fromCharCode(Math.floor((lon % 2) * 12) + 97);
    const subLat = String.fromCharCode(Math.floor((lat % 1) * 24) + 97);

    return `${fieldLon}${fieldLat}${squareLon}${squareLat}${subLon}${subLat}`;
}
