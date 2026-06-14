import Foundation
import CoreLocation

/// Memoizes the expensive per-pass smooth-then-project pipeline
/// (`SatPass.polarTrackSegments` / `groundTrackSegments`).
///
/// Why this exists: the sky views re-evaluate at ~1 Hz (the live `now`
/// tick), and each evaluation previously re-ran the full two-pass moving
/// average + spherical projection over *every raw observation of every
/// visible pass* — even though a CLOSED pass is mathematically immutable
/// and its geometry never changes. At tens of thousands of observations
/// that recompute is the dominant per-frame cost and the source of the
/// lag. Here we compute a pass's geometry once and reuse it until the pass
/// actually changes.
///
/// Validity key: `(pass.id, observations.count, maxPoints, smoothingWindow)`
/// — plus a quantized observer position for ground tracks, which are
/// observer-relative. A closed pass keeps a stable count, so it's a
/// permanent cache hit; a live pass's count grows each observation, which
/// produces a fresh key (and evicts its now-stale older entries). The count
/// also distinguishes a pass trimmed to a short time window from its full
/// self, since `filtered(by:)` hands back a same-id pass with a shorter
/// observation array.
///
/// Main-thread confined: SwiftUI bodies and `Canvas` draw closures (the
/// only callers) run on the main actor, so a plain dictionary needs no
/// locking. `ObservableObject` conformance is only so a view can own it via
/// `@StateObject` and have it persist across body re-evaluations — it
/// publishes nothing and never triggers an invalidation.
@MainActor
final class PassGeometryCache: ObservableObject {
    private struct PolarKey: Hashable {
        let id: UUID
        let count: Int
        let maxPoints: Int
        let window: Int
    }
    private struct GroundKey: Hashable {
        let id: UUID
        let count: Int
        let maxPoints: Int
        let window: Int
        let latMilli: Int
        let lonMilli: Int
    }

    private var polar: [PolarKey: [[(az: Double, el: Double)]]] = [:]
    private var ground: [GroundKey: [[(coord: CLLocationCoordinate2D, elevation: Double)]]] = [:]

    /// Cached az/el track segments for the polar plot (observer-independent).
    func polarSegments(for pass: SatPass, maxPoints: Int, smoothingWindow: Int)
    -> [[(az: Double, el: Double)]] {
        let key = PolarKey(id: pass.id, count: pass.observations.count,
                           maxPoints: maxPoints, window: smoothingWindow)
        if let hit = polar[key] { return hit }
        let value = pass.polarTrackSegments(maxPoints: maxPoints, smoothingWindow: smoothingWindow)
        evictPolar(id: pass.id, keepingCount: key.count)
        polar[key] = value
        return value
    }

    /// Cached projected ground-track segments for the map/globe. The observer
    /// position is part of the key (quantized to ~1e-3°, ≈100 m) so a moved
    /// fix invalidates; in practice the observer is stationary so this is a
    /// stable hit.
    func groundSegments(for pass: SatPass, observerLat: Double, observerLon: Double,
                        maxPoints: Int, smoothingWindow: Int)
    -> [[(coord: CLLocationCoordinate2D, elevation: Double)]] {
        let key = GroundKey(id: pass.id, count: pass.observations.count,
                            maxPoints: maxPoints, window: smoothingWindow,
                            latMilli: Int((observerLat * 1000).rounded()),
                            lonMilli: Int((observerLon * 1000).rounded()))
        if let hit = ground[key] { return hit }
        let value = pass.groundTrackSegments(observerLat: observerLat, observerLon: observerLon,
                                             maxPoints: maxPoints, smoothingWindow: smoothingWindow)
        evictGround(id: pass.id, keepingCount: key.count)
        ground[key] = value
        return value
    }

    /// Drop the entire cache (e.g. after the store is cleared). Cheap; it
    /// just refills lazily on the next render.
    func clear() {
        polar.removeAll()
        ground.removeAll()
    }

    // A growing live pass produces a new observation count each tick; remove
    // its superseded entries so the cache doesn't accumulate dead snapshots
    // as a pass accrues thousands of observations over its lifetime.
    private func evictPolar(id: UUID, keepingCount count: Int) {
        for k in polar.keys where k.id == id && k.count != count { polar[k] = nil }
    }
    private func evictGround(id: UUID, keepingCount count: Int) {
        for k in ground.keys where k.id == id && k.count != count { ground[k] = nil }
    }
}
