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
    func groundTrack(observerLat: Double, observerLon: Double, maxPoints: Int = .max) -> [CLLocationCoordinate2D] {
        let obs = maxPoints < observations.count ? decimated(maxPoints: maxPoints) : observations
        return obs.compactMap {
            subSatellitePoint(az: Int($0.az), el: Int($0.el),
                              constellation: constellation,
                              observerLat: observerLat, observerLon: observerLon)
        }
    }
}

// MARK: - Age-based render tier

/// A pass's age determines how prominently it's rendered.
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

    var opacity: Double {
        switch self {
        case .live:    return 0.65
        case .recent:  return 0.38
        case .today:   return 0.20
        case .week:    return 0.10
        case .archive: return 0.05
        }
    }

    var strokeWidth: CGFloat {
        switch self {
        case .live:    return 2.2
        case .recent:  return 1.6
        case .today:   return 1.3
        case .week:    return 1.0
        case .archive: return 0.8
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
}

// MARK: - Time window filter

/// A user-selectable filter window for the sky view.
enum TimeWindow: String, CaseIterable, Identifiable {
    case live   = "Live"
    case m5     = "5m"
    case m15    = "15m"
    case h1     = "1h"
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
        case .h6:   return "last 6 hours"
        case .d1:   return "last 24 hours"
        case .d7:   return "last 7 days"
        case .d30:  return "last 30 days"
        case .all:  return "all time"
        }
    }
}

// MARK: - Geometry

/// Projects observer-relative az/el to the satellite's sub-satellite point using
/// the constellation's orbital altitude and spherical Earth geometry.
/// Returns `nil` for el ≤ 0 or degenerate cases.
func subSatellitePoint(az: Int, el: Int, constellation: SatConstellation,
                       observerLat: Double, observerLon: Double) -> CLLocationCoordinate2D? {
    guard el > 0, el <= 90 else { return nil }

    let R = 6_371.0
    let h: Double
    switch constellation {
    case .gps:     h = 20_200
    case .glonass: h = 19_100
    case .galileo: h = 23_222
    case .beidou:  h = 21_528
    }

    let elRad = Double(el) * .pi / 180
    let azRad = Double(az) * .pi / 180
    let latO  = observerLat * .pi / 180
    let lonO  = observerLon * .pi / 180

    let gamma = acos(sin(elRad) * R / (R + h)) - elRad

    let sinLatS = sin(latO) * cos(gamma) + cos(latO) * sin(gamma) * cos(azRad)
    let latS = asin(max(-1, min(1, sinLatS)))
    let lonS = lonO + atan2(sin(azRad) * sin(gamma) * cos(latO),
                             cos(gamma) - sin(latO) * sinLatS)

    let lat = latS * 180 / .pi
    let lon = lonS * 180 / .pi
    guard lat.isFinite, lon.isFinite else { return nil }
    return CLLocationCoordinate2D(latitude: lat, longitude: lon)
}
