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

        // Equation of time (minutes)
        let B = (360.0 / 365.0 * (n + 10)) * .pi / 180
        let eot = 229.18 * (0.000075 + 0.001868 * cos(B) - 0.032077 * sin(B)
                             - 0.014615 * cos(2 * B) - 0.040849 * sin(2 * B))

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

    /// Equation of time in minutes (difference between solar time and clock time)
    static func equationOfTime(date: Date) -> Double {
        let n = julianDate(from: date)
        let B = (360.0 / 365.0 * (n + 10)) * .pi / 180
        return 229.18 * (0.000075 + 0.001868 * cos(B) - 0.032077 * sin(B)
                          - 0.014615 * cos(2 * B) - 0.040849 * sin(2 * B))
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
        // Synodic month ≈ 29.53059 days
        // Known new moon: 2000-01-06 18:14 UTC ≈ n = 6.26
        let phase = ((n - 6.26) / 29.53059).truncatingRemainder(dividingBy: 1)
        return phase < 0 ? phase + 1 : phase
    }

    // MARK: - Maidenhead Grid Locator

    /// Convert lat/lon to 6-character Maidenhead grid locator (e.g. IO81wh)
    static func maidenhead(latitude: Double, longitude: Double) -> String {
        let lon = longitude + 180
        let lat = latitude + 90

        let fieldLon = Character(UnicodeScalar(Int(lon / 20) + 65)!)
        let fieldLat = Character(UnicodeScalar(Int(lat / 10) + 65)!)

        let squareLon = Int(lon.truncatingRemainder(dividingBy: 20) / 2)
        let squareLat = Int(lat.truncatingRemainder(dividingBy: 10))

        let subLon = Character(UnicodeScalar(Int(lon.truncatingRemainder(dividingBy: 2) * 12) + 97)!)
        let subLat = Character(UnicodeScalar(Int(lat.truncatingRemainder(dividingBy: 1) * 24) + 97)!)

        return "\(fieldLon)\(fieldLat)\(squareLon)\(squareLat)\(subLon)\(subLat)"
    }
}
