import Foundation
import CoreLocation
import SwiftUI

// MARK: - Observation record

/// One recorded observation of a satellite: position, signal strength, and
/// time offset from the pass start. Packed into 6 bytes.
struct SatObservation: Codable, Hashable {
    let az: Int16    // 0–359° azimuth
    let el: Int8     // 0–90° elevation
    let snr: Int8    // 0–99 dB SNR
    let t: UInt16    // seconds since pass start (0–65535 ≈ 18h)
}

// MARK: - Complete satellite pass

/// One continuous track of a single satellite from acquisition to loss.
/// Observations are ordered by time; `startTime + observations.last.t == endTime`.
struct SatPass: Codable, Identifiable, Hashable {
    let id: UUID
    let prn: String
    let constellation: SatConstellation
    let startTime: Date
    var observations: [SatObservation]

    // MARK: Derived properties

    var endTime: Date {
        startTime.addingTimeInterval(TimeInterval(observations.last?.t ?? 0))
    }

    var duration: TimeInterval {
        TimeInterval(observations.last?.t ?? 0)
    }

    var peakElevation: Int {
        observations.reduce(0) { max($0, Int($1.el)) }
    }

    var peakSNR: Int {
        observations.reduce(0) { max($0, Int($1.snr)) }
    }

    var avgSNR: Double {
        guard !observations.isEmpty else { return 0 }
        let total = observations.reduce(0) { $0 + Int($1.snr) }
        return Double(total) / Double(observations.count)
    }

    // MARK: Rendering helpers

    /// Decimate to at most `maxPoints` observations, preserving first and last.
    /// Returns the original array when already short enough.
    func decimated(maxPoints: Int) -> [SatObservation] {
        guard observations.count > maxPoints, maxPoints > 1 else { return observations }
        let step = Double(observations.count - 1) / Double(maxPoints - 1)
        var result: [SatObservation] = []
        result.reserveCapacity(maxPoints)
        for i in 0..<maxPoints {
            let idx = min(observations.count - 1, Int(Double(i) * step))
            result.append(observations[idx])
        }
        return result
    }

    /// Sub-satellite ground track given the observer's fix.
    /// Uses constellation-specific orbital altitude and spherical geometry.
    ///
    /// Smoothing: NMEA reports az/el as integer degrees, which causes 1° quantization
    /// jumps in the raw observations. The underlying orbit is smooth, so we apply a
    /// centered moving-average window to az/el (in double precision, with azimuth
    /// unwrapped across the 0°/360° seam) before projecting, and run the average
    /// twice — two moderate-window passes approximate a Gaussian kernel and
    /// suppress residual 1° ripples without flattening real curvature the way a
    /// single wide window would. The window size adapts to sample count so long
    /// passes get more smoothing than short ones.
    /// Setting `smoothingWindow: 1` disables smoothing.
    func groundTrack(observerLat: Double, observerLon: Double, maxPoints: Int = .max, smoothingWindow: Int = 0) -> [CLLocationCoordinate2D] {
        groundTrackPoints(observerLat: observerLat, observerLon: observerLon,
                          maxPoints: maxPoints, smoothingWindow: smoothingWindow)
            .map(\.coord)
    }

    /// Like `groundTrack` but also returns the smoothed elevation at each point.
    /// Callers that render trails as 3D arcs (e.g. the globe view) use the
    /// elevation to lift the trail off the sphere using the same formula as
    /// the live satellite dot, so a high-arc pass actually arches over the
    /// globe instead of skating flat across the surface.
    func groundTrackPoints(observerLat: Double, observerLon: Double,
                           maxPoints: Int = .max,
                           smoothingWindow: Int = 0)
    -> [(coord: CLLocationCoordinate2D, elevation: Double)] {
        let base: [(Double, Double)] = observations.map { (Double($0.az), Double($0.el)) }
        let window = smoothingWindow > 0
            ? smoothingWindow
            : Self.adaptiveSmoothingWindow(for: base.count)
        let pass1 = Self.smoothedAzEl(base, window: window)
        // Second pass for a near-Gaussian result.
        let pass2 = Self.smoothedAzEl(pass1, window: window)
        // Decimate after smoothing so the full-resolution signal drives the
        // averages; callers asking for a coarse render still get evenly-spaced
        // samples from the smoothed curve.
        let samples = Self.decimate(pass2, toAtMost: maxPoints)
        return samples.compactMap { (az, el) in
            guard let coord = subSatellitePointD(
                azDeg: az, elDeg: el,
                constellation: constellation,
                observerLat: observerLat, observerLon: observerLon
            ) else { return nil }
            return (coord: coord, elevation: el)
        }
    }

    /// Adaptive smoothing window: longer passes get wider smoothing. Two 5-tap
    /// passes (= 9-tap equivalent) already tame short passes; beyond ~80
    /// samples we step up to 7-tap, beyond ~160 to 9-tap, and cap at 11-tap for
    /// very long passes so we don't start eating real orbital curvature.
    private static func adaptiveSmoothingWindow(for count: Int) -> Int {
        switch count {
        case ..<20:  return 3       // keep short passes honest
        case ..<80:  return 5
        case ..<160: return 7
        case ..<260: return 9
        default:     return 11
        }
    }

    /// Centered moving-average smoothing of (az, el) in double precision.
    /// Azimuth is unwrapped (accumulated modulo-360 deltas) before averaging so
    /// that e.g. 359° → 1° doesn't average to 180°. Returns one (az, el) pair
    /// per input sample — no points are dropped. Safe to chain (pass the result
    /// back in for a second pass).
    private static func smoothedAzEl(_ pts: [(Double, Double)], window: Int) -> [(Double, Double)] {
        let n = pts.count
        guard n > 0 else { return [] }
        guard window >= 3, n >= 3 else { return pts }
        var unwrappedAz: [Double] = []
        unwrappedAz.reserveCapacity(n)
        var prev = pts[0].0
        unwrappedAz.append(prev)
        for i in 1..<n {
            var d = pts[i].0 - prev
            while d > 180 { d -= 360 }
            while d <= -180 { d += 360 }
            prev += d
            unwrappedAz.append(prev)
        }
        let half = window / 2
        var result: [(Double, Double)] = []
        result.reserveCapacity(n)
        for i in 0..<n {
            let lo = max(0, i - half)
            let hi = min(n - 1, i + half)
            let denom = Double(hi - lo + 1)
            var azSum = 0.0, elSum = 0.0
            for j in lo...hi {
                azSum += unwrappedAz[j]
                elSum += pts[j].1
            }
            var az = azSum / denom
            az = az.truncatingRemainder(dividingBy: 360)
            if az < 0 { az += 360 }
            result.append((az, elSum / denom))
        }
        return result
    }

    /// Evenly-spaced decimation preserving first and last sample.
    private static func decimate(_ pts: [(Double, Double)], toAtMost maxPoints: Int) -> [(Double, Double)] {
        guard pts.count > maxPoints, maxPoints > 1 else { return pts }
        let step = Double(pts.count - 1) / Double(maxPoints - 1)
        var result: [(Double, Double)] = []
        result.reserveCapacity(maxPoints)
        for i in 0..<maxPoints {
            let idx = min(pts.count - 1, Int(Double(i) * step))
            result.append(pts[idx])
        }
        return result
    }
}

// MARK: - Age-based render tier

/// A pass's age determines how prominently it's rendered. The *tier* is still
/// a discrete enum because it also drives `maxPoints` (a perf knob — fewer
/// observations per pass the older it gets) where a small number of explicit
/// buckets is easier to reason about than a continuous function. Opacity and
/// stroke width, however, are rendered as *continuous* curves keyed off raw
/// age — the previous per-tier constants produced visible step changes at the
/// 1h/24h/7d cliffs, which looked like glitches rather than decay. The curves
/// below are stretched-exponentials in √(age) with a non-zero floor, giving a
/// rapid near-term fade and a long gentle tail so week-old passes are still
/// faintly visible.
enum PassAgeTier {
    case live      // currently recording
    case recent    // endTime within the last hour
    case today     // within the last 24h
    case week      // within the last 7d
    case archive   // older

    static func tier(endAge: TimeInterval, isLive: Bool) -> PassAgeTier {
        if isLive { return .live }
        switch endAge {
        case ..<3_600:       return .recent
        case ..<86_400:      return .today
        case ..<604_800:     return .week
        default:             return .archive
        }
    }

    /// Cap on observations rendered per pass — lower for old passes to
    /// keep frame time bounded as history accumulates.
    var maxPoints: Int {
        switch self {
        case .live:    return 400
        case .recent:  return 150
        case .today:   return 75
        case .week:    return 40
        case .archive: return 25
        }
    }

    // MARK: Continuous render curves

    /// Smooth opacity fade driven by the pass's end-age. Live passes get a
    /// fixed bright alpha; everything else decays along a stretched
    /// exponential in √(hours) so the first few hours fade quickly and older
    /// passes settle onto a visible floor rather than vanishing.
    ///
    /// Hand-picked waypoints (non-live):
    /// - just ended  ≈ 0.35
    /// - 1 h ago     ≈ 0.28
    /// - 6 h         ≈ 0.20
    /// - 24 h        ≈ 0.12
    /// - 7 d         ≈ 0.04
    /// - 30 d+       ≈ 0.03 (floor)
    static func opacity(endAge: TimeInterval, isLive: Bool) -> Double {
        if isLive { return 0.45 }
        let ageHours = max(0, endAge) / 3600
        let decay = 0.32 * exp(-sqrt(ageHours / 16))
        return 0.03 + decay
    }

    /// Smooth stroke-width taper along the same age axis. Uses a gentler
    /// half-life than opacity so even week-old passes keep enough line weight
    /// to read as a recognisable arc rather than a single pixel.
    ///
    /// Waypoints (non-live): just ended 2.2 → 6 h 1.7 → 24 h 1.4 → 7 d 0.9 → 30 d floor 0.8.
    static func strokeWidth(endAge: TimeInterval, isLive: Bool) -> CGFloat {
        if isLive { return 2.2 }
        let ageHours = max(0, endAge) / 3600
        let decay = 1.4 * exp(-sqrt(ageHours / 30))
        return 0.8 + CGFloat(decay)
    }
}

// MARK: - Time window filter

/// A user-selectable filter window for the sky view.
enum TimeWindow: String, CaseIterable, Identifiable {
    case live   = "Live"
    case m5     = "5m"
    case m15    = "15m"
    case h1     = "1h"
    case h2     = "2h"
    case h6     = "6h"
    case d1     = "24h"
    case d7     = "7d"
    case d30    = "30d"
    case all    = "All"

    var id: Self { self }

    /// Cutoff date; a pass is visible if its `endTime >= cutoff`.
    /// `nil` means no filter.
    func cutoff(from now: Date) -> Date? {
        switch self {
        case .live: return now.addingTimeInterval(-180)   // ~3 min grace
        case .m5:   return now.addingTimeInterval(-300)
        case .m15:  return now.addingTimeInterval(-900)
        case .h1:   return now.addingTimeInterval(-3_600)
        case .h2:   return now.addingTimeInterval(-7_200)
        case .h6:   return now.addingTimeInterval(-21_600)
        case .d1:   return now.addingTimeInterval(-86_400)
        case .d7:   return now.addingTimeInterval(-604_800)
        case .d30:  return now.addingTimeInterval(-2_592_000)
        case .all:  return nil
        }
    }

    /// Human-readable description of the window for UI captions.
    var description: String {
        switch self {
        case .live: return "last 3 minutes"
        case .m5:   return "last 5 minutes"
        case .m15:  return "last 15 minutes"
        case .h1:   return "last hour"
        case .h2:   return "last 2 hours"
        case .h6:   return "last 6 hours"
        case .d1:   return "last 24 hours"
        case .d7:   return "last 7 days"
        case .d30:  return "last 30 days"
        case .all:  return "all time"
        }
    }
}

// MARK: - Retention window

/// How long recorded passes should be kept on disk. Separate from `TimeWindow`
/// (which only decides what's *rendered* right now) because the user may want
/// to display only the last hour while still accumulating a month of history —
/// or vice-versa, cap disk usage to a day while filtering to "all".
enum RetentionWindow: String, CaseIterable, Identifiable, Codable {
    case h1        = "1h"
    case h6        = "6h"
    case d1        = "24h"
    case d7        = "7d"
    case d30       = "30d"
    case d90       = "90d"
    case y1        = "1y"
    case unlimited = "∞"

    var id: Self { self }

    /// Retention duration in seconds; `nil` means keep forever.
    var seconds: TimeInterval? {
        switch self {
        case .h1:  return 3_600
        case .h6:  return 21_600
        case .d1:  return 86_400
        case .d7:  return 604_800
        case .d30: return 2_592_000
        case .d90: return 7_776_000
        case .y1:  return 31_536_000
        case .unlimited: return nil
        }
    }

    var displayName: String {
        switch self {
        case .h1:  return "1 hour"
        case .h6:  return "6 hours"
        case .d1:  return "24 hours"
        case .d7:  return "7 days"
        case .d30: return "30 days"
        case .d90: return "90 days"
        case .y1:  return "1 year"
        case .unlimited: return "Unlimited"
        }
    }

    static let defaultsKey = "skyTrailRetention"

    /// Current retention read directly from UserDefaults. Safe to call from
    /// any context (not `@MainActor`-isolated) — reads only.
    static var current: RetentionWindow {
        if let raw = UserDefaults.standard.string(forKey: defaultsKey),
           let v = RetentionWindow(rawValue: raw) {
            return v
        }
        return .d30   // matches the previous hardcoded behaviour
    }
}

// MARK: - Geometry

/// Projects observer-relative az/el to the satellite's sub-satellite point using
/// the constellation's orbital altitude and spherical Earth geometry.
/// Returns `nil` for el ≤ 0 or degenerate cases.
func subSatellitePoint(az: Int, el: Int, constellation: SatConstellation,
                       observerLat: Double, observerLon: Double) -> CLLocationCoordinate2D? {
    subSatellitePointD(azDeg: Double(az), elDeg: Double(el),
                       constellation: constellation,
                       observerLat: observerLat, observerLon: observerLon)
}

/// Double-precision form used when az/el come from smoothing or other non-integer
/// sources. Callers with integer NMEA samples should use `subSatellitePoint(az:el:…)`.
func subSatellitePointD(azDeg: Double, elDeg: Double, constellation: SatConstellation,
                        observerLat: Double, observerLon: Double) -> CLLocationCoordinate2D? {
    guard elDeg > 0, elDeg <= 90 else { return nil }

    let R = 6_371.0
    let h: Double
    switch constellation {
    case .gps:     h = 20_200
    case .glonass: h = 19_100
    case .galileo: h = 23_222
    case .beidou:  h = 21_528
    }

    let elRad = elDeg * .pi / 180
    let azRad = azDeg * .pi / 180
    let latO  = observerLat * .pi / 180
    let lonO  = observerLon * .pi / 180

    // Central angle at Earth's centre between observer and sub-sat point:
    //   γ = acos(R · cos(el) / (R+h)) − el
    // Using cos(el), not sin(el) — the latter projects the sub-sat point
    // behind the observer at high elevations and amplifies el jitter on the
    // ground track.
    let gamma = acos(cos(elRad) * R / (R + h)) - elRad

    let sinLatS = sin(latO) * cos(gamma) + cos(latO) * sin(gamma) * cos(azRad)
    let latS = asin(max(-1, min(1, sinLatS)))
    let lonS = lonO + atan2(sin(azRad) * sin(gamma) * cos(latO),
                             cos(gamma) - sin(latO) * sinLatS)

    let lat = latS * 180 / .pi
    let lon = lonS * 180 / .pi
    guard lat.isFinite, lon.isFinite else { return nil }
    return CLLocationCoordinate2D(latitude: lat, longitude: lon)
}
