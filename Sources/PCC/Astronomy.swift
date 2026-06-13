import Foundation

// MARK: - Solar & Lunar position calculator

struct CelestialPosition {
    let altitude: Double   // degrees above horizon
    let azimuth: Double    // degrees from north, clockwise
}

struct SunTimes {
    let sunrise: Date
    let solarNoon: Date
    let sunset: Date
    let goldenHourStart: Date   // evening golden hour begins
    let goldenHourEnd: Date     // = sunset
    let civilTwilight: Date     // evening civil twilight end
    let nauticalTwilight: Date  // evening nautical twilight end
}

enum Astronomy {

    // MARK: - Julian Date

    private static func julianDate(from date: Date) -> Double {
        // J2000.0 epoch = 2000-01-01 12:00 UTC = JD 2451545.0
        let j2000: TimeInterval = 946728000 // 2000-01-01 12:00 UTC as Unix timestamp
        return (date.timeIntervalSince1970 - j2000) / 86400.0
    }

    // MARK: - Solar Position

    /// Calculate the sun's position in the sky for a given observer location and time.
    static func sunPosition(date: Date, latitude: Double, longitude: Double) -> CelestialPosition {
        let n = julianDate(from: date)

        // Mean longitude and anomaly (degrees)
        let L = (280.460 + 0.9856474 * n).truncatingRemainder(dividingBy: 360)
        let g = (357.528 + 0.9856003 * n).truncatingRemainder(dividingBy: 360)
        let gRad = g * .pi / 180

        // Ecliptic longitude
        let lambda = L + 1.915 * sin(gRad) + 0.020 * sin(2 * gRad)
        let lambdaRad = lambda * .pi / 180

        // Obliquity of ecliptic
        let epsilon = (23.439 - 0.0000004 * n) * .pi / 180

        // Right ascension and declination
        let alpha = atan2(cos(epsilon) * sin(lambdaRad), cos(lambdaRad)) * 180 / .pi
        let delta = asin(sin(epsilon) * sin(lambdaRad))

        // Greenwich mean sidereal time (hours)
        let gmst = (18.697374558 + 24.06570982441908 * n)
            .truncatingRemainder(dividingBy: 24)

        // Local sidereal time and hour angle (degrees)
        let lst = gmst * 15 + longitude
        let ha = (lst - alpha) * .pi / 180

        let latRad = latitude * .pi / 180

        // Altitude
        let sinAlt = sin(latRad) * sin(delta) + cos(latRad) * cos(delta) * cos(ha)
        let altitude = asin(sinAlt) * 180 / .pi

        // Azimuth
        var azimuth = atan2(-sin(ha), tan(delta) * cos(latRad) - sin(latRad) * cos(ha))
        azimuth = azimuth * 180 / .pi
        if azimuth < 0 { azimuth += 360 }

        return CelestialPosition(altitude: altitude, azimuth: azimuth)
    }

    // MARK: - Sub-solar point

    /// Latitude/longitude on Earth where the sun is directly overhead at `date`.
    /// Used by the globe view to drive the day/night terminator.
    ///
    /// Latitude equals the solar declination (±23.44° seasonally). Longitude is
    /// derived from the sun's apparent right ascension and Greenwich mean
    /// sidereal time: the sub-solar meridian is where the hour-angle is zero,
    /// which gives `lon = RA − GMST·15`, wrapped into (−180, +180].
    static func subSolarPoint(date: Date) -> (latitude: Double, longitude: Double) {
        let n = julianDate(from: date)

        let L = (280.460 + 0.9856474 * n).truncatingRemainder(dividingBy: 360)
        let g = (357.528 + 0.9856003 * n).truncatingRemainder(dividingBy: 360)
        let gRad = g * .pi / 180
        let lambda = L + 1.915 * sin(gRad) + 0.020 * sin(2 * gRad)
        let lambdaRad = lambda * .pi / 180
        let epsilon = (23.439 - 0.0000004 * n) * .pi / 180

        let alpha = atan2(cos(epsilon) * sin(lambdaRad), cos(lambdaRad)) * 180 / .pi
        let delta = asin(sin(epsilon) * sin(lambdaRad)) * 180 / .pi

        let gmst = (18.697374558 + 24.06570982441908 * n)
            .truncatingRemainder(dividingBy: 24)

        // Sub-solar longitude. Wrap into (−180, +180] so callers get a tidy
        // signed longitude regardless of how many modulo cycles have passed.
        var lon = alpha - gmst * 15
        lon = lon.truncatingRemainder(dividingBy: 360)
        if lon > 180       { lon -= 360 }
        else if lon <= -180 { lon += 360 }

        return (latitude: delta, longitude: lon)
    }

    // MARK: - Sunrise / Sunset / Twilight

    /// Calculate sun times for a given date and location.
    static func sunTimes(date: Date, latitude: Double, longitude: Double) -> SunTimes? {
        // Use noon on the given date as reference
        let cal = Calendar(identifier: .gregorian)
        var comps = cal.dateComponents(in: .gmt, from: date)
        comps.hour = 12; comps.minute = 0; comps.second = 0
        guard let noon = cal.date(from: comps) else { return nil }

        let n = julianDate(from: noon)
        let g = (357.528 + 0.9856003 * n).truncatingRemainder(dividingBy: 360)
        let gRad = g * .pi / 180
        let L = (280.460 + 0.9856474 * n).truncatingRemainder(dividingBy: 360)
        let lambda = L + 1.915 * sin(gRad) + 0.020 * sin(2 * gRad)
        let lambdaRad = lambda * .pi / 180
        let epsilon = (23.439 - 0.0000004 * n) * .pi / 180
        let delta = asin(sin(epsilon) * sin(lambdaRad))

        // Equation of time (minutes), from the canonical `L − α` identity (see
        // `equationOfTimeMinutes`). Recomputes the few sun intermediates from
        // the same `n` (noon on the requested day) rather than the duplicated
        // day-of-year Spencer series this used to inline, so the solar-noon and
        // sunrise/sunset times stay consistent with the displayed "Eq.T".
        let eot = equationOfTimeMinutes(n: n)

        let latRad = latitude * .pi / 180

        func hourAngle(for sunAngle: Double) -> Double? {
            let cosOmega = (sin(sunAngle * .pi / 180) - sin(latRad) * sin(delta))
                / (cos(latRad) * cos(delta))
            guard cosOmega >= -1 && cosOmega <= 1 else { return nil }
            return acos(cosOmega) * 180 / .pi
        }

        // Standard sunrise/sunset: -0.833 degrees (accounting for refraction + solar disc)
        guard let omega = hourAngle(for: -0.833) else { return nil }

        // Solar noon in UTC (hours from midnight)
        let solarNoonUTC = 12.0 - eot / 60.0 - longitude / 15.0
        let rise = solarNoonUTC - omega / 15.0
        let set = solarNoonUTC + omega / 15.0

        // Golden hour: sun at 6 degrees altitude
        let goldenOmega = hourAngle(for: 6.0) ?? omega
        let goldenStart = solarNoonUTC + goldenOmega / 15.0

        // Civil twilight: -6 degrees
        let civilOmega = hourAngle(for: -6.0) ?? omega
        let civilEnd = solarNoonUTC + civilOmega / 15.0

        // Nautical twilight: -12 degrees
        let nauticalOmega = hourAngle(for: -12.0) ?? civilOmega
        let nauticalEnd = solarNoonUTC + nauticalOmega / 15.0

        func makeDate(_ utcHours: Double) -> Date {
            noon.addingTimeInterval((utcHours - 12.0) * 3600)
        }

        return SunTimes(
            sunrise: makeDate(rise),
            solarNoon: makeDate(solarNoonUTC),
            sunset: makeDate(set),
            goldenHourStart: makeDate(goldenStart),
            goldenHourEnd: makeDate(set),
            civilTwilight: makeDate(civilEnd),
            nauticalTwilight: makeDate(nauticalEnd)
        )
    }

    /// Equation of time in minutes: apparent solar time minus mean solar time.
    /// Positive means the true sun is *ahead* of the mean sun (a sundial reads
    /// later than the clock); it swings to roughly +16 min in early November
    /// and −14 min in February, passing through ~0 near 1 September.
    static func equationOfTime(date: Date) -> Double {
        equationOfTimeMinutes(n: julianDate(from: date))
    }

    /// Canonical equation of time from the same solar intermediates the rest of
    /// this file already computes: the sun's mean longitude `L` and its
    /// apparent right ascension `α`. By definition the equation of time is the
    /// hour-angle difference between the mean sun (which advances uniformly at
    /// `L`) and the true sun (whose hour angle is `α`), i.e.
    ///
    ///     EoT = L − α   (degrees)  →  ×4 min/°  →  minutes
    ///
    /// The previous implementation fed *days since J2000* into a Spencer series
    /// that was derived for *day-of-year*; the two agree only by coincidence
    /// near the epoch and drift apart by up to ~6 minutes across the year (and
    /// further every subsequent year as `n` grows). Computing it from `L − α`
    /// is exact to the precision of the underlying sun model and never drifts.
    ///
    /// `L − α` is wrapped into (−180°, +180°] before scaling so the ±~4° annual
    /// swing is never aliased by the 360° ambiguity between the two angles.
    private static func equationOfTimeMinutes(n: Double) -> Double {
        let L = (280.460 + 0.9856474 * n).truncatingRemainder(dividingBy: 360)
        let g = (357.528 + 0.9856003 * n).truncatingRemainder(dividingBy: 360)
        let gRad = g * .pi / 180
        let lambda = L + 1.915 * sin(gRad) + 0.020 * sin(2 * gRad)
        let lambdaRad = lambda * .pi / 180
        let epsilon = (23.439 - 0.0000004 * n) * .pi / 180

        // Apparent right ascension of the true sun, in degrees.
        let alpha = atan2(cos(epsilon) * sin(lambdaRad), cos(lambdaRad)) * 180 / .pi

        // Wrap (L − α) into (−180, +180] so the small real difference survives
        // the modulo wraparound of the two independently-reduced angles.
        var diff = (L - alpha).truncatingRemainder(dividingBy: 360)
        if diff > 180 { diff -= 360 }
        else if diff <= -180 { diff += 360 }

        // 4 minutes of time per degree of hour angle (Earth turns 360° / 1440 min).
        return 4 * diff
    }

    // MARK: - Lunar Position (simplified)

    /// Approximate moon position. Accurate to ~2 degrees.
    static func moonPosition(date: Date, latitude: Double, longitude: Double) -> CelestialPosition {
        let n = julianDate(from: date)

        // Lunar elements (degrees)
        let L0 = (218.316 + 13.176396 * n).truncatingRemainder(dividingBy: 360)
        let M = (134.963 + 13.064993 * n).truncatingRemainder(dividingBy: 360)
        let F = (93.272 + 13.229350 * n).truncatingRemainder(dividingBy: 360)

        let MRad = M * .pi / 180
        let FRad = F * .pi / 180

        // Ecliptic longitude and latitude
        let lonMoon = L0 + 6.289 * sin(MRad)
        let latMoon = 5.128 * sin(FRad)
        let lonRad = lonMoon * .pi / 180
        let latRad = latMoon * .pi / 180

        // Obliquity
        let epsilon = (23.439 - 0.0000004 * n) * .pi / 180

        // Equatorial coordinates
        let alpha = atan2(
            sin(lonRad) * cos(epsilon) - tan(latRad) * sin(epsilon),
            cos(lonRad)
        ) * 180 / .pi

        let delta = asin(
            sin(latRad) * cos(epsilon) + cos(latRad) * sin(epsilon) * sin(lonRad)
        )

        // Hour angle
        let gmst = (18.697374558 + 24.06570982441908 * n)
            .truncatingRemainder(dividingBy: 24)
        let lst = gmst * 15 + longitude
        let ha = (lst - alpha) * .pi / 180

        let obsLatRad = latitude * .pi / 180

        let sinAlt = sin(obsLatRad) * sin(delta) + cos(obsLatRad) * cos(delta) * cos(ha)
        let altitude = asin(sinAlt) * 180 / .pi

        var azimuth = atan2(-sin(ha), tan(delta) * cos(obsLatRad) - sin(obsLatRad) * cos(ha))
        azimuth = azimuth * 180 / .pi
        if azimuth < 0 { azimuth += 360 }

        return CelestialPosition(altitude: altitude, azimuth: azimuth)
    }

    /// Approximate moon phase (0 = new, 0.5 = full, 1 = new again)
    static func moonPhase(date: Date) -> Double {
        let n = julianDate(from: date)
        // Synodic month ≈ 29.53059 days.
        // `n` here is days since the J2000.0 epoch (2000-01-01 12:00 UTC).
        // The reference new moon 2000-01-06 18:14 UTC is 5.26 days after that
        // epoch, so subtract 5.26 — not 6.26. The old 6.26 put the epoch a full
        // day late and shifted every reported phase back by ~3.4%.
        let phase = ((n - 5.26) / 29.53059).truncatingRemainder(dividingBy: 1)
        return phase < 0 ? phase + 1 : phase
    }

    // MARK: - Maidenhead Grid Locator

    /// Convert lat/lon to 6-character Maidenhead grid locator (e.g. IO81wh).
    ///
    /// Robustness: the grid is only defined for latitude in [−90, +90) and
    /// longitude in [−180, +180). Two failure modes are guarded here:
    ///
    ///  - Non-finite input (NaN/±∞ from an upstream divide-by-zero) — `Int(NaN)`
    ///    is a hard Swift trap, not a recoverable error, so we bail to a
    ///    sentinel before any conversion.
    ///  - The exact upper edges (+90 lat, +180 lon) — these fall one grid cell
    ///    *past* the last valid field letter ('R'), so the old
    ///    `UnicodeScalar(...)!` chain produced an out-of-band character (or, for
    ///    the offending field index, could force-unwrap a scalar well outside
    ///    A–R). We clamp the inputs just inside the top of the grid and clamp
    ///    every derived index into its legal range, so the result is always a
    ///    well-formed locator and the force-unwraps can never fail.
    static func maidenhead(latitude: Double, longitude: Double) -> String {
        guard latitude.isFinite, longitude.isFinite else { return "----" }

        // Clamp to the grid's domain. The upper bounds are nudged a hair inside
        // (`nextDown`) because +90/+180 belong to the next, non-existent field.
        let clampedLat = min(90.0.nextDown, max(-90.0, latitude))
        let clampedLon = min(180.0.nextDown, max(-180.0, longitude))

        let lon = clampedLon + 180   // 0 ..< 360
        let lat = clampedLat + 90    // 0 ..< 180

        // Build each character from a base scalar plus an index that is clamped
        // into range as defence in depth — after the input clamp these clamps
        // are no-ops, but they guarantee `UnicodeScalar(_:)` always succeeds.
        func letter(base: Int, index: Int, span: Int) -> Character {
            let scalar = base + min(span - 1, max(0, index))
            // `scalar` is provably in printable-ASCII range, so the unwrap is
            // safe; the `?? "?"` keeps the no-force-unwrap house rule literal.
            return Character(UnicodeScalar(scalar) ?? UnicodeScalar(63))   // 63 = '?'
        }

        let fieldLon = letter(base: 65, index: Int(lon / 20), span: 18)        // A–R
        let fieldLat = letter(base: 65, index: Int(lat / 10), span: 18)        // A–R

        let squareLon = min(9, max(0, Int(lon.truncatingRemainder(dividingBy: 20) / 2)))
        let squareLat = min(9, max(0, Int(lat.truncatingRemainder(dividingBy: 10))))

        let subLon = letter(base: 97, index: Int(lon.truncatingRemainder(dividingBy: 2) * 12), span: 24)  // a–x
        let subLat = letter(base: 97, index: Int(lat.truncatingRemainder(dividingBy: 1) * 24), span: 24)  // a–x

        return "\(fieldLon)\(fieldLat)\(squareLon)\(squareLat)\(subLon)\(subLat)"
    }
}
