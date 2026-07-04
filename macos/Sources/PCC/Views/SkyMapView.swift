import SwiftUI
import MapKit
import CoreLocation
import AppKit

/// Satellite ground-track map for the Sky View.
/// Shows sub-satellite points, sun/moon projections, per-pass ground tracks, and
/// the user's GPS position.
///
/// # Why this is an `NSViewRepresentable` and not SwiftUI's declarative `Map`
///
/// The previous implementation used SwiftUI's `Map` with a `ForEach` emitting one
/// `MapPolyline` per pass-segment. CPU sampling of the running app showed a
/// pathology: the view body re-evaluates every second (the `now` tick plus live
/// recording updates), and MapKit/VectorKit responds by **destroying and
/// rebuilding every polyline overlay mesh** on each evaluation —
/// `_updateNonTileOverlays` → `~PolylineOverlayLayer` → `~RibbonLayer` →
/// `~BaseMesh` — pegging 1–2 CPU cores continuously at full resolution with the
/// real recorded history (~260 passes). The declarative `Map` rebuilds the whole
/// overlay set regardless of how stable the inputs are; an earlier attempt to
/// stabilise it by minute-bucketing the fade did not help, because the rebuild
/// is keyed on the body re-evaluation, not on whether any overlay's *bytes*
/// changed.
///
/// The fix is to drive an `MKMapView` directly and update its overlays
/// **incrementally**: on each `updateNSView` we recompute the desired overlay
/// set, diff it against what's currently installed, and add/remove only the
/// overlays that genuinely changed. On a plain 1 Hz `now` tick with no pass
/// growing, closing, or aging across a tier boundary, the diff finds nothing
/// changed and we touch **zero** overlays — so `_updateNonTileOverlays` never
/// fires and the per-tick mesh rebuild is gone. Only real events (a pass grows,
/// a pass closes, a pass crosses an age tier, the observer moves, `smoothTrails`
/// toggles, or the colour scheme flips) do any overlay work.
///
/// Annotations (the live satellite dots, sun, moon, and GPS fix) legitimately
/// move every tick, but updating annotations does not rebuild overlay meshes —
/// that's a different, cheap MapKit path — so they're allowed to refresh freely.
struct SkyMapView: View {
    let geometryCache: PassGeometryCache
    @Environment(\.colorScheme) private var colorScheme
    let satellites: [SatelliteInfo]
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    let userLatitude: Double?
    let userLongitude: Double?
    var showLabels: Bool = true
    var passes: [SatPass] = []
    var activePRNs: Set<String> = []
    var now: Date = Date()
    /// When `false`, disables the Swift-side az/el moving-average filter so
    /// the rendered polyline passes through every raw NMEA observation
    /// (visible 1° integer-quantization staircase). Maps through to
    /// `SatPass.groundTrackSegments(smoothingWindow:)` — `1` disables
    /// smoothing, `0` enables the adaptive window.
    var smoothTrails: Bool = true
    var toggles: AnyView?

    private var constellationsPresent: [SatConstellation] {
        let unique = Set(satellites.map(\.constellation))
        return SatConstellation.allCases.filter { unique.contains($0) }
    }

    var body: some View {
        // The representable owns the MKMapView and all overlay/annotation
        // diffing. The toggles and legend overlays, clip shape, and the
        // (absent) frame are kept identical to the old declarative body so the
        // SkyView call site — which appends `.frame(minHeight:)` / padding —
        // is completely unchanged.
        MapRepresentable(geometryCache: geometryCache,
                         colorScheme: colorScheme,
                         satellites: satellites,
                         sunPosition: sunPosition,
                         moonPosition: moonPosition,
                         userLatitude: userLatitude,
                         userLongitude: userLongitude,
                         showLabels: showLabels,
                         passes: passes,
                         activePRNs: activePRNs,
                         now: now,
                         smoothTrails: smoothTrails)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(alignment: .topTrailing) {
                if let toggles {
                    toggles
                        .padding(8)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(constellationsPresent, id: \.self) { c in
                        HStack(spacing: 4) {
                            Circle().fill(c.color).frame(width: 6, height: 6)
                            Text(c.rawValue).font(.system(size: 9))
                        }
                    }
                    if sunPosition != nil {
                        HStack(spacing: 4) {
                            Circle().fill(.yellow).frame(width: 6, height: 6)
                            Text("Sun").font(.system(size: 9))
                        }
                    }
                    if moonPosition != nil {
                        HStack(spacing: 4) {
                            Circle().fill(.gray).frame(width: 6, height: 6)
                            Text("Moon").font(.system(size: 9))
                        }
                    }
                }
                .padding(6)
                .background(.ultraThinMaterial)
                .cornerRadius(6)
                .padding(8)
            }
    }
}

// MARK: - Discrete per-tier styling

/// Discrete, per-`PassAgeTier` opacity and stroke width for **closed** passes.
///
/// `PassAgeTier.opacity(endAge:)` / `.strokeWidth(endAge:)` are *continuous*
/// curves in age: a closed pass's alpha changes every single second as it ages.
/// If we styled overlays with the continuous value, a bucket's appearance would
/// drift tick-to-tick and we'd have to re-stroke (and so rebuild) its mesh every
/// second — exactly the pathology we're eliminating. Instead each age *tier*
/// gets ONE alpha/width, sampled from the continuous curve at a representative
/// age inside that tier. A closed pass's style is then byte-stable until it
/// actually crosses into the next tier (a rare per-pass event), so its bucket's
/// mesh is built once and left alone.
///
/// The representative age per tier is chosen near the *young* end of the band so
/// the discrete value is close to what a freshly-demoted pass had on the
/// continuous curve, keeping the visual step at a boundary small.
private enum TierStyle {
    /// Representative age (seconds) used to sample the continuous fade curve for
    /// each tier. Live passes don't use this (they're styled live, below).
    static func representativeAge(for tier: PassAgeTier) -> TimeInterval {
        switch tier {
        case .live:    return 0
        case .recent:  return 5 * 60        // ~5 min into the [0, 1h) band
        case .today:   return 3 * 3_600     // ~3 h into the [1h, 24h) band
        case .week:    return 2 * 86_400    // ~2 d into the [24h, 7d) band
        case .archive: return 14 * 86_400   // ~2 weeks into the open-ended tail
        }
    }

    /// Base (space-tuned) opacity for a tier, sampled from the continuous curve.
    /// This is the same number the dark globe would use; the map then lifts it
    /// into a legible band (see `mapAlpha`).
    static func baseOpacity(for tier: PassAgeTier) -> Double {
        if tier == .live { return PassAgeTier.opacity(endAge: 0, isLive: true) }
        return PassAgeTier.opacity(endAge: representativeAge(for: tier), isLive: false)
    }

    /// Stroke width for a tier, sampled from the continuous taper.
    static func strokeWidth(for tier: PassAgeTier) -> CGFloat {
        if tier == .live { return PassAgeTier.strokeWidth(endAge: 0, isLive: true) }
        return PassAgeTier.strokeWidth(endAge: representativeAge(for: tier), isLive: false)
    }

    /// Map-legible alpha for a tier in the given colour scheme.
    ///
    /// `PassAgeTier.opacity` is tuned for the black globe (floor ~0.06); on the
    /// always-lighter map basemap those faint old tracks vanish, which is why the
    /// map looked starved next to the globe. Remap the [0.06, 0.75] age curve
    /// into a higher, map-legible band so older ground tracks stay visible while
    /// fresh/live ones still read as strong. The light basemap is far brighter
    /// than the dark one, so it needs a higher floor or old tracks still wash
    /// out. This is the identical lift the old declarative body applied, just
    /// computed per-tier instead of per-tick.
    static func mapAlpha(for tier: PassAgeTier, colorScheme: ColorScheme) -> Double {
        let baseAlpha = baseOpacity(for: tier)
        let floor = colorScheme == .light ? 0.62 : 0.45
        return min(0.96, floor + (baseAlpha - 0.06) / 0.69 * (0.95 - floor))
    }
}

// MARK: - Style-carrying overlay subclasses

/// `MKMultiPolyline` that remembers the stroke colour and width to draw it with.
///
/// `mapView(_:rendererFor:)` is handed an opaque `MKOverlay` and must produce a
/// renderer; it has no other channel to learn what colour/width an overlay
/// should use. Subclassing the overlay to carry its own style is the simplest
/// leak-free way to answer that — no side dictionary to keep in sync with the
/// overlay's lifetime, and the style travels with the object. (A dictionary
/// keyed by `ObjectIdentifier` would work too; the subclass avoids the bookkeeping.)
private final class StyledMultiPolyline: MKMultiPolyline {
    var strokeColor: NSColor = .clear
    var strokeWidth: CGFloat = 1
}

extension SatConstellation {
    /// `NSColor` form of the constellation palette, for MapKit renderers (which
    /// take `NSColor`, not SwiftUI `Color`). Built from the same raw `rgb255`
    /// channels as `color` so the map matches the globe/polar/legend with no
    /// palette drift. `alpha` bakes the per-tier fade into the stroke.
    func nsColor(alpha: Double) -> NSColor {
        let (r, g, b) = rgb255
        return NSColor(srgbRed: CGFloat(r) / 255,
                       green: CGFloat(g) / 255,
                       blue: CGFloat(b) / 255,
                       alpha: CGFloat(max(0, min(1, alpha))))
    }
}

// MARK: - Bucket identity

/// Identifies one CLOSED-pass overlay bucket. All closed passes of the same
/// constellation in the same age tier are merged into a single
/// `MKMultiPolyline`, so the entire recorded history collapses to at most
/// `4 constellations × 4 closed tiers ≈ 16` overlays regardless of how many
/// hundreds of passes are on disk. One overlay per bucket (instead of one per
/// pass) is also what makes the per-tier discrete styling possible: every member
/// of a bucket shares one colour/width, so the bucket can be drawn with a single
/// renderer.
private struct BucketKey: Hashable {
    let constellation: SatConstellation
    let tier: PassAgeTier
}

/// Per-pass geometry fingerprint used to decide whether a bucket changed.
///
/// A pass's projected ground geometry is a pure function of
/// `(pass.id, observations.count, maxPoints, smoothingWindow, observer)` — that's
/// exactly the `PassGeometryCache` validity key. With `maxPoints`, smoothing, and
/// observer held constant across a bucket, the only thing that can change a
/// member's geometry is its observation count growing. So `(id, count)` is a
/// sufficient signature: if every member's `(id, count)` is unchanged and the
/// member set is unchanged, the bucket's rendered mesh is identical and we leave
/// it untouched.
private struct PassSignature: Hashable {
    let id: UUID
    let count: Int
}

/// The full membership of one bucket plus the installed overlay drawing it.
/// `signatures` is the set of member fingerprints; the diff compares the freshly
/// computed signature set against this to decide whether to rebuild.
private struct BucketState {
    var signatures: Set<PassSignature>
    var overlay: StyledMultiPolyline
}

/// Tracks one live pass's installed overlay and the observation count it was
/// built from, so we only replace it when the pass actually grows.
private struct LiveState {
    var count: Int
    var overlay: StyledMultiPolyline
}

// MARK: - NSViewRepresentable

/// Wraps an `MKMapView` and updates its overlays incrementally. See the
/// `SkyMapView` doc comment for why this exists.
private struct MapRepresentable: NSViewRepresentable {
    let geometryCache: PassGeometryCache
    let colorScheme: ColorScheme
    let satellites: [SatelliteInfo]
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    let userLatitude: Double?
    let userLongitude: Double?
    let showLabels: Bool
    let passes: [SatPass]
    let activePRNs: Set<String>
    let now: Date
    let smoothTrails: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(geometryCache: geometryCache)
    }

    func makeNSView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        // Match the old `.standard(elevation: .flat)` look: a flat (non-3D)
        // standard basemap with points-of-interest suppressed so the satellite
        // tracks aren't competing with restaurant pins. The map follows the
        // system light/dark appearance automatically (it inherits the effective
        // appearance of its view hierarchy), which keeps the basemap matched to
        // the rest of the app without us toggling anything.
        let config = MKStandardMapConfiguration(elevationStyle: .flat,
                                                emphasisStyle: .muted)
        config.pointOfInterestFilter = .excludingAll
        map.preferredConfiguration = config
        map.showsCompass = false
        map.isPitchEnabled = false
        map.showsScale = false
        // The user's pan/zoom must be respected after the first frame, so the
        // initial region is set once in updateNSView (guarded by a flag on the
        // coordinator) rather than here, where we may not yet have a GPS fix.
        return map
    }

    func updateNSView(_ map: MKMapView, context: Context) {
        context.coordinator.update(map: map,
                                   colorScheme: colorScheme,
                                   satellites: satellites,
                                   sunPosition: sunPosition,
                                   moonPosition: moonPosition,
                                   userLatitude: userLatitude,
                                   userLongitude: userLongitude,
                                   showLabels: showLabels,
                                   passes: passes,
                                   activePRNs: activePRNs,
                                   now: now,
                                   smoothTrails: smoothTrails)
    }

    // MARK: Coordinator / MKMapViewDelegate

    /// Owns every piece of displayed overlay and annotation state and performs
    /// the diff. It is the `MKMapViewDelegate`, so all of its work runs on the
    /// main actor where `MKMapView` and `PassGeometryCache` both require to be
    /// touched. `@MainActor` here lets the delegate methods satisfy strict
    /// concurrency without `@preconcurrency` hatch-escapes: `MKMapViewDelegate`
    /// is itself main-actor in the macOS SDK, and `NSViewRepresentable.Coordinator`
    /// is constructed on the main actor.
    @MainActor
    final class Coordinator: NSObject, MKMapViewDelegate {
        private let geometryCache: PassGeometryCache

        // Installed CLOSED-pass buckets, keyed by (constellation, tier).
        private var buckets: [BucketKey: BucketState] = [:]
        // Installed LIVE-pass overlays, keyed by pass id.
        private var liveOverlays: [UUID: LiveState] = [:]

        // The global render inputs the installed overlays were built against.
        // If any of these changes, EVERY overlay's geometry/colour is stale and
        // the whole overlay set is rebuilt. They change rarely (the observer is
        // stationary; the user toggles smoothing or flips appearance by hand),
        // so this full rebuild is not a per-tick cost.
        private var lastObserverLatMilli: Int?
        private var lastObserverLonMilli: Int?
        private var lastSmoothTrails: Bool?
        private var lastColorScheme: ColorScheme?

        // Region is set once; afterwards we never fight the user's pan/zoom.
        private var didSetInitialRegion = false

        // Annotation bookkeeping. Annotations are cheap to refresh, but we still
        // avoid pointless churn by only re-adding the satellite dots when the
        // satellite set's identity/style actually changes, and by moving the
        // singleton sun/moon/GPS annotations in place rather than recreating them.
        private var satelliteAnnotations: [String: SatelliteDotAnnotation] = [:]
        private var lastSatelliteRenderKeys: [String: SatelliteDotAnnotation.RenderKey] = [:]
        private let sunAnnotation = CelestialAnnotation(kind: .sun)
        private let moonAnnotation = CelestialAnnotation(kind: .moon)
        private let gpsAnnotation = GPSAnnotation()
        private var sunShown = false
        private var moonShown = false
        private var gpsShown = false

        init(geometryCache: PassGeometryCache) {
            self.geometryCache = geometryCache
        }

        // MARK: Update entry point

        func update(map: MKMapView,
                    colorScheme: ColorScheme,
                    satellites: [SatelliteInfo],
                    sunPosition: CelestialPosition?,
                    moonPosition: CelestialPosition?,
                    userLatitude: Double?,
                    userLongitude: Double?,
                    showLabels: Bool,
                    passes: [SatPass],
                    activePRNs: Set<String>,
                    now: Date,
                    smoothTrails: Bool) {
            updateRegionIfNeeded(map: map, lat: userLatitude, lon: userLongitude)

            // Overlays need an observer fix to project against. Without one
            // there's nothing to draw — clear any stale overlays and bail.
            guard let lat = userLatitude, let lon = userLongitude else {
                clearAllOverlays(map: map)
                updateAnnotations(map: map, satellites: satellites,
                                  sunPosition: sunPosition, moonPosition: moonPosition,
                                  userLatitude: userLatitude, userLongitude: userLongitude,
                                  showLabels: showLabels)
                return
            }

            // If a global render input changed, every installed overlay is stale.
            // Wipe them so the diff below rebuilds from a clean slate with the
            // new geometry/colour. This is the only place a full rebuild happens.
            let latMilli = Int((lat * 1000).rounded())
            let lonMilli = Int((lon * 1000).rounded())
            let globalsChanged = latMilli != lastObserverLatMilli
                || lonMilli != lastObserverLonMilli
                || smoothTrails != lastSmoothTrails
                || colorScheme != lastColorScheme
            if globalsChanged {
                clearAllOverlays(map: map)
                lastObserverLatMilli = latMilli
                lastObserverLonMilli = lonMilli
                lastSmoothTrails = smoothTrails
                lastColorScheme = colorScheme
            }

            reconcileOverlays(map: map,
                              colorScheme: colorScheme,
                              passes: passes,
                              activePRNs: activePRNs,
                              now: now,
                              observerLat: lat,
                              observerLon: lon,
                              smoothTrails: smoothTrails)

            updateAnnotations(map: map, satellites: satellites,
                              sunPosition: sunPosition, moonPosition: moonPosition,
                              userLatitude: userLatitude, userLongitude: userLongitude,
                              showLabels: showLabels)
        }

        // MARK: Overlay reconciliation (the crux)

        private func reconcileOverlays(map: MKMapView,
                                       colorScheme: ColorScheme,
                                       passes: [SatPass],
                                       activePRNs: Set<String>,
                                       now: Date,
                                       observerLat: Double,
                                       observerLon: Double,
                                       smoothTrails: Bool) {
            // Full resolution, same as the old code: tier.maxPoints is `.max`
            // and the smoothing window is 0 (adaptive) unless smoothing is off.
            let maxPoints = Int.max
            let smoothingWindow = smoothTrails ? 0 : 1

            // --- CLOSED passes: bucket by (constellation, tier) -------------
            //
            // Build the *desired* bucket membership for this frame. For closed
            // passes the only per-tick input is `now`, which only matters when a
            // pass crosses a tier boundary — otherwise every pass lands in the
            // same bucket it was in last tick with the same `(id, count)`
            // signature, so the diff below is a no-op.
            var desiredSignatures: [BucketKey: Set<PassSignature>] = [:]
            // Keep the member geometry around only for buckets we end up
            // (re)building, to avoid re-projecting passes in untouched buckets.
            var desiredMembers: [BucketKey: [(pass: SatPass, sig: PassSignature)]] = [:]

            for pass in passes where !activePRNs.contains(pass.prn) {
                let age = now.timeIntervalSince(pass.endTime)
                let tier = PassAgeTier.tier(endAge: age, isLive: false)
                let key = BucketKey(constellation: pass.constellation, tier: tier)
                let sig = PassSignature(id: pass.id, count: pass.observations.count)
                desiredSignatures[key, default: []].insert(sig)
                desiredMembers[key, default: []].append((pass, sig))
            }

            // Remove buckets that no longer exist (e.g. the time-window filter
            // dropped every member, or all members aged out into another tier).
            for (key, state) in buckets where desiredSignatures[key] == nil {
                map.removeOverlay(state.overlay)
                buckets[key] = nil
            }

            // Add or rebuild buckets whose membership/geometry changed; skip the
            // ones whose signature set is byte-identical to what's installed.
            for (key, sigs) in desiredSignatures {
                if let existing = buckets[key], existing.signatures == sigs {
                    continue   // unchanged — the common per-tick path, do NOTHING
                }

                // (Re)project this bucket's members. `geometryCache` makes the
                // closed passes permanent cache hits, so a rebuild triggered by
                // an *unrelated* bucket changing doesn't recompute geometry; it
                // just reassembles already-projected segments into a new
                // MKMultiPolyline. We still only get here when THIS bucket's
                // signature changed.
                let members = desiredMembers[key] ?? []
                // Oldest-first layering within the bucket so fresher passes draw
                // on top. (Across buckets, the renderer's alpha already encodes
                // age; within a tier we order by endTime to preserve the
                // overlapping-sweep look from the old code.)
                let ordered = members.sorted { $0.pass.endTime < $1.pass.endTime }
                var lines: [MKPolyline] = []
                for member in ordered {
                    let segments = geometryCache.groundSegments(
                        for: member.pass,
                        observerLat: observerLat, observerLon: observerLon,
                        maxPoints: maxPoints, smoothingWindow: smoothingWindow)
                    for segment in segments {
                        // Each contiguous segment is its OWN polyline so a
                        // recording gap doesn't draw a chord across unobserved
                        // ground (the "spiral", issue #8). MKMultiPolyline draws
                        // its member polylines without connecting them, which is
                        // exactly the segmented-trail look we want.
                        let coords = segment.map(\.coord)
                        if coords.count >= 2 {
                            lines.append(MKPolyline(coordinates: coords, count: coords.count))
                        }
                    }
                }

                // Replace the old overlay for this bucket (if any) with the new
                // merged multipolyline.
                if let existing = buckets[key] {
                    map.removeOverlay(existing.overlay)
                }
                guard !lines.isEmpty else {
                    // Members exist but none projected to a drawable segment
                    // (e.g. all at 0° elevation). Nothing to install; forget the
                    // bucket so a later frame can rebuild it.
                    buckets[key] = nil
                    continue
                }
                let overlay = StyledMultiPolyline(lines)
                overlay.strokeColor = key.constellation.nsColor(
                    alpha: TierStyle.mapAlpha(for: key.tier, colorScheme: colorScheme))
                overlay.strokeWidth = TierStyle.strokeWidth(for: key.tier)
                map.addOverlay(overlay, level: .aboveRoads)
                buckets[key] = BucketState(signatures: sigs, overlay: overlay)
            }

            // --- LIVE passes: one overlay each, replaced only when they grow --
            //
            // There are only 1–2 live passes. Each gets its own polyline, styled
            // with the live alpha/width. We replace it only when its observation
            // count changes (it grew) — NOT every tick. A live pass animating
            // against the wall clock would otherwise re-stroke its mesh each
            // second; gating on the count means a tick with no new observation
            // touches nothing.
            let liveAlpha = TierStyle.mapAlpha(for: .live, colorScheme: colorScheme)
            let liveWidth = TierStyle.strokeWidth(for: .live)
            var seenLive: Set<UUID> = []
            for pass in passes where activePRNs.contains(pass.prn) {
                seenLive.insert(pass.id)
                let count = pass.observations.count
                if let existing = liveOverlays[pass.id], existing.count == count {
                    continue   // unchanged this tick — do NOTHING
                }
                if let existing = liveOverlays[pass.id] {
                    map.removeOverlay(existing.overlay)
                }
                let segments = geometryCache.groundSegments(
                    for: pass, observerLat: observerLat, observerLon: observerLon,
                    maxPoints: maxPoints, smoothingWindow: smoothingWindow)
                // One MKPolyline per contiguous run, wrapped in a single
                // multipolyline so the live pass is one styled overlay keyed by
                // pass id. Using a multipolyline (not a concatenated polyline)
                // means a recording gap never draws a chord across unobserved
                // ground, exactly as for closed history (issue #8) — live passes
                // rarely have gaps, but this keeps the rule uniform.
                let lines: [MKPolyline] = segments.compactMap { segment in
                    let coords = segment.map(\.coord)
                    return coords.count >= 2 ? MKPolyline(coordinates: coords, count: coords.count) : nil
                }
                guard !lines.isEmpty else {
                    liveOverlays[pass.id] = nil
                    continue
                }
                let overlay = StyledMultiPolyline(lines)
                overlay.strokeColor = pass.constellation.nsColor(alpha: liveAlpha)
                overlay.strokeWidth = liveWidth
                map.addOverlay(overlay, level: .aboveRoads)
                liveOverlays[pass.id] = LiveState(count: count, overlay: overlay)
            }
            // Remove live overlays whose pass is no longer live (it closed — it
            // will reappear as a member of a closed bucket on this same frame).
            for (id, state) in liveOverlays where !seenLive.contains(id) {
                map.removeOverlay(state.overlay)
                liveOverlays[id] = nil
            }
        }

        private func clearAllOverlays(map: MKMapView) {
            for state in buckets.values { map.removeOverlay(state.overlay) }
            for state in liveOverlays.values { map.removeOverlay(state.overlay) }
            buckets.removeAll()
            liveOverlays.removeAll()
        }

        // MARK: Annotations

        private func updateAnnotations(map: MKMapView,
                                       satellites: [SatelliteInfo],
                                       sunPosition: CelestialPosition?,
                                       moonPosition: CelestialPosition?,
                                       userLatitude: Double?,
                                       userLongitude: Double?,
                                       showLabels: Bool) {
            updateSatelliteDots(map: map, satellites: satellites,
                                userLatitude: userLatitude, userLongitude: userLongitude,
                                showLabels: showLabels)
            updateGPS(map: map, userLatitude: userLatitude, userLongitude: userLongitude)
            updateCelestial(map: map, annotation: sunAnnotation, shown: &sunShown,
                            position: sunPosition,
                            userLatitude: userLatitude, userLongitude: userLongitude)
            updateCelestial(map: map, annotation: moonAnnotation, shown: &moonShown,
                            position: moonPosition,
                            userLatitude: userLatitude, userLongitude: userLongitude)
        }

        /// Live sub-satellite dots. These move every tick and that's fine —
        /// annotation moves don't rebuild overlay meshes. We reuse annotation
        /// objects keyed by satellite id and only add/remove on set changes;
        /// when a satellite's projected point or style changes we mutate the
        /// existing annotation in place and refresh just its view.
        private func updateSatelliteDots(map: MKMapView,
                                         satellites: [SatelliteInfo],
                                         userLatitude: Double?,
                                         userLongitude: Double?,
                                         showLabels: Bool) {
            guard let lat = userLatitude, let lon = userLongitude else {
                if !satelliteAnnotations.isEmpty {
                    map.removeAnnotations(Array(satelliteAnnotations.values))
                    satelliteAnnotations.removeAll()
                    lastSatelliteRenderKeys.removeAll()
                }
                return
            }

            var desiredIDs: Set<String> = []
            for sat in satellites {
                guard let coord = sat.subSatellitePoint(observerLat: lat, observerLon: lon) else {
                    continue
                }
                desiredIDs.insert(sat.id)
                let renderKey = SatelliteDotAnnotation.RenderKey(
                    constellation: sat.constellation, hasSNR: sat.snr != nil,
                    label: showLabels ? sat.id : "")
                if let existing = satelliteAnnotations[sat.id] {
                    existing.coordinate = coord
                    if lastSatelliteRenderKeys[sat.id] != renderKey {
                        existing.apply(renderKey)
                        existing.refreshView()
                        lastSatelliteRenderKeys[sat.id] = renderKey
                    }
                } else {
                    let annotation = SatelliteDotAnnotation(id: sat.id, coordinate: coord)
                    annotation.apply(renderKey)
                    satelliteAnnotations[sat.id] = annotation
                    lastSatelliteRenderKeys[sat.id] = renderKey
                    map.addAnnotation(annotation)
                }
            }
            // Drop satellites that are no longer visible.
            for (id, annotation) in satelliteAnnotations where !desiredIDs.contains(id) {
                map.removeAnnotation(annotation)
                satelliteAnnotations[id] = nil
                lastSatelliteRenderKeys[id] = nil
            }
        }

        private func updateGPS(map: MKMapView, userLatitude: Double?, userLongitude: Double?) {
            guard let lat = userLatitude, let lon = userLongitude else {
                if gpsShown { map.removeAnnotation(gpsAnnotation); gpsShown = false }
                return
            }
            gpsAnnotation.coordinate = CLLocationCoordinate2D(latitude: lat, longitude: lon)
            if !gpsShown { map.addAnnotation(gpsAnnotation); gpsShown = true }
        }

        /// Sun/Moon, projected with the same `celestialCoordinate` formula as the
        /// old code (including the asin clamp). Added when above the horizon and
        /// the fix is known; removed otherwise.
        private func updateCelestial(map: MKMapView,
                                     annotation: CelestialAnnotation,
                                     shown: inout Bool,
                                     position: CelestialPosition?,
                                     userLatitude: Double?,
                                     userLongitude: Double?) {
            guard let position,
                  let coord = Self.celestialCoordinate(position,
                                                       userLatitude: userLatitude,
                                                       userLongitude: userLongitude) else {
                if shown { map.removeAnnotation(annotation); shown = false }
                return
            }
            annotation.coordinate = coord
            if !shown { map.addAnnotation(annotation); shown = true }
        }

        /// Projects a celestial body (sun/moon) to a map coordinate. Pulled
        /// verbatim from the old declarative view so the markers land in exactly
        /// the same place; in particular it keeps the `asin` clamp into [-1, 1],
        /// because floating-point error in the spherical-triangle terms can nudge
        /// the argument a hair past ±1 and `asin` of an out-of-domain value is
        /// NaN, which propagates to a NaN coordinate and silently drops (or
        /// mis-places) the body.
        private static func celestialCoordinate(_ pos: CelestialPosition,
                                                userLatitude: Double?,
                                                userLongitude: Double?) -> CLLocationCoordinate2D? {
            guard let lat = userLatitude, let lon = userLongitude, pos.altitude > 0 else {
                return nil
            }
            let angularDist = (90.0 - pos.altitude) / 90.0 * 25.0
            let azRad = pos.azimuth * .pi / 180
            let distRad = angularDist * .pi / 180
            let userLatRad = lat * .pi / 180
            let userLonRad = lon * .pi / 180
            let sinLat = sin(userLatRad) * cos(distRad)
                + cos(userLatRad) * sin(distRad) * cos(azRad)
            let latS = asin(max(-1, min(1, sinLat)))
            let lonS = userLonRad + atan2(
                sin(azRad) * sin(distRad) * cos(userLatRad),
                cos(distRad) - sin(userLatRad) * sin(latS))
            return CLLocationCoordinate2D(latitude: latS * 180 / .pi,
                                          longitude: lonS * 180 / .pi)
        }

        // MARK: Camera

        /// Sets a sensible initial region ONCE: centred on the GPS fix if known,
        /// otherwise a world view. After the first set we never touch the region
        /// again, so the user's pan/zoom is never fought (matching the old
        /// `.automatic` camera, which also settled and then left the user in
        /// control).
        private func updateRegionIfNeeded(map: MKMapView, lat: Double?, lon: Double?) {
            guard !didSetInitialRegion else { return }
            let region: MKCoordinateRegion
            if let lat, let lon {
                region = MKCoordinateRegion(
                    center: CLLocationCoordinate2D(latitude: lat, longitude: lon),
                    span: MKCoordinateSpan(latitudeDelta: 90, longitudeDelta: 120))
            } else {
                region = MKCoordinateRegion(
                    center: CLLocationCoordinate2D(latitude: 20, longitude: 0),
                    span: MKCoordinateSpan(latitudeDelta: 140, longitudeDelta: 360))
            }
            map.setRegion(region, animated: false)
            didSetInitialRegion = true
        }

        // MARK: MKMapViewDelegate

        /// Produces the renderer for a styled overlay. The overlay subclass
        /// carries its own stroke colour and width (see `StyledMultiPolyline`),
        /// so the renderer is a pure read of those fields — there's no per-tick
        /// restyling and no side table to consult. Both closed buckets and live
        /// passes are `StyledMultiPolyline`s (live ones with one member per
        /// contiguous run), so a single renderer branch covers everything.
        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let multi = overlay as? StyledMultiPolyline {
                let renderer = MKMultiPolylineRenderer(multiPolyline: multi)
                renderer.strokeColor = multi.strokeColor
                renderer.lineWidth = multi.strokeWidth
                renderer.lineCap = .round
                renderer.lineJoin = .round
                return renderer
            }
            // Unknown overlay type: an invisible renderer rather than a crash.
            return MKOverlayRenderer(overlay: overlay)
        }

        /// Supplies the dot/marker views for our annotations. Reuses dequeued
        /// views by reuse identifier. Returns `nil` for the map's own user
        /// location (we draw our own GPS dot), letting MapKit use its default.
        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            switch annotation {
            case let sat as SatelliteDotAnnotation:
                return sat.makeOrReuse(on: mapView)
            case let celestial as CelestialAnnotation:
                return celestial.makeOrReuse(on: mapView)
            case is GPSAnnotation:
                return gpsAnnotation.makeOrReuse(on: mapView)
            default:
                return nil
            }
        }
    }
}

// MARK: - Annotation model + views

/// Live sub-satellite dot. A reference type because MapKit annotations must be
/// classes, and because we mutate `coordinate` in place each tick (an
/// annotation move is cheap and does not rebuild overlay meshes). The drawn
/// appearance is captured in `RenderKey` so we only rebuild the view when the
/// colour/size/label actually changes.
private final class SatelliteDotAnnotation: NSObject, MKAnnotation {
    /// The inputs that determine how the dot is drawn. Comparing the current
    /// key against the last one lets the coordinator skip view rebuilds on ticks
    /// where only the position moved.
    struct RenderKey: Equatable {
        let constellation: SatConstellation
        let hasSNR: Bool
        let label: String
    }

    let id: String
    @objc dynamic var coordinate: CLLocationCoordinate2D
    var title: String?

    private(set) var constellation: SatConstellation = .gps
    private(set) var hasSNR: Bool = false

    init(id: String, coordinate: CLLocationCoordinate2D) {
        self.id = id
        self.coordinate = coordinate
    }

    func apply(_ key: RenderKey) {
        constellation = key.constellation
        hasSNR = key.hasSNR
        title = key.label.isEmpty ? nil : key.label
    }

    private weak var view: MKAnnotationView?

    /// A tracked satellite (has SNR) is drawn larger and more opaque with a
    /// white ring; one without a signal is a small faint dot — matching the old
    /// declarative styling exactly (sizes 9/5, alpha 0.85/0.3, ring 0.6/0).
    ///
    /// `@MainActor` because it touches main-actor-isolated MapKit view APIs
    /// (`dequeueReusableAnnotationView`, `MKAnnotationView.init`, `.image`,
    /// `.centerOffset`). It's only ever called from the Coordinator's
    /// `mapView(_:viewFor:)`, which is itself main-actor, so the isolation is a
    /// no-op at the call site and just satisfies strict concurrency. The class
    /// stays a plain (nonisolated) `MKAnnotation` so its `coordinate`/`title`
    /// protocol requirements don't cross actors.
    @MainActor
    func makeOrReuse(on map: MKMapView) -> MKAnnotationView {
        let reuseID = "satDot"
        let v = map.dequeueReusableAnnotationView(withIdentifier: reuseID)
            ?? MKAnnotationView(annotation: self, reuseIdentifier: reuseID)
        v.annotation = self
        view = v
        renderInto(v)
        return v
    }

    /// Re-render the existing view when the style changed (constellation/SNR/
    /// label). Cheap: it just swaps the small drawn image and label.
    @MainActor
    func refreshView() {
        guard let view else { return }
        renderInto(view)
    }

    @MainActor
    private func renderInto(_ v: MKAnnotationView) {
        let diameter: CGFloat = hasSNR ? 9 : 5
        let fill = constellation.nsColor(alpha: hasSNR ? 0.85 : 0.3)
        let ringAlpha: CGFloat = hasSNR ? 0.6 : 0
        v.image = SkyMapMarker.dot(diameter: diameter, fill: fill,
                                   ring: NSColor.white.withAlphaComponent(ringAlpha),
                                   ringWidth: 1)
        // Centre the dot on the coordinate.
        v.centerOffset = .zero
    }
}

/// Sun or Moon marker. Position is updated in place each tick; the appearance is
/// fixed per kind, so the view is built once and reused.
private final class CelestialAnnotation: NSObject, MKAnnotation {
    enum Kind { case sun, moon }
    let kind: Kind
    @objc dynamic var coordinate = CLLocationCoordinate2D()
    var title: String? { kind == .sun ? "Sun" : "Moon" }

    init(kind: Kind) { self.kind = kind }

    /// `@MainActor`: builds/configures a MapKit annotation view (see the note on
    /// `SatelliteDotAnnotation.makeOrReuse`). Called only from the main-actor
    /// delegate.
    @MainActor
    func makeOrReuse(on map: MKMapView) -> MKAnnotationView {
        let reuseID = kind == .sun ? "sun" : "moon"
        let v = map.dequeueReusableAnnotationView(withIdentifier: reuseID)
            ?? MKAnnotationView(annotation: self, reuseIdentifier: reuseID)
        v.annotation = self
        switch kind {
        case .sun:
            // Yellow disc with an orange ring — matches the old SwiftUI marker.
            v.image = SkyMapMarker.dot(diameter: 12, fill: .systemYellow,
                                       ring: .systemOrange, ringWidth: 1.5)
        case .moon:
            v.image = SkyMapMarker.dot(diameter: 10, fill: .systemGray,
                                       ring: NSColor.white.withAlphaComponent(0.5),
                                       ringWidth: 1)
        }
        v.centerOffset = .zero
        return v
    }
}

/// The user's GPS fix: a translucent blue halo around a solid white-ringed blue
/// dot, matching the old SwiftUI "Clock" marker.
private final class GPSAnnotation: NSObject, MKAnnotation {
    @objc dynamic var coordinate = CLLocationCoordinate2D()
    var title: String? { "Clock" }

    /// `@MainActor`: builds/configures a MapKit annotation view (see the note on
    /// `SatelliteDotAnnotation.makeOrReuse`). Called only from the main-actor
    /// delegate.
    @MainActor
    func makeOrReuse(on map: MKMapView) -> MKAnnotationView {
        let reuseID = "gps"
        let v = map.dequeueReusableAnnotationView(withIdentifier: reuseID)
            ?? MKAnnotationView(annotation: self, reuseIdentifier: reuseID)
        v.annotation = self
        v.image = SkyMapMarker.gpsDot()
        v.centerOffset = .zero
        return v
    }
}

// MARK: - Marker image rendering

/// Draws small annotation marker images (`NSImage`) for the map dots. MapKit
/// annotation views take an image; drawing the SwiftUI circles into a bitmap
/// once per style is far cheaper than hosting SwiftUI views as annotations, and
/// the resulting images are cached by MapKit's view reuse.
private enum SkyMapMarker {
    /// A filled disc with an optional ring, sized to fit a `diameter`-point dot
    /// inside a slightly larger canvas so the ring isn't clipped.
    static func dot(diameter: CGFloat, fill: NSColor, ring: NSColor, ringWidth: CGFloat) -> NSImage {
        let pad = ringWidth + 1
        let side = diameter + pad * 2
        let image = NSImage(size: NSSize(width: side, height: side))
        image.lockFocus()
        defer { image.unlockFocus() }
        let rect = NSRect(x: pad, y: pad, width: diameter, height: diameter)
        let path = NSBezierPath(ovalIn: rect)
        fill.setFill()
        path.fill()
        if ring.alphaComponent > 0 && ringWidth > 0 {
            ring.setStroke()
            path.lineWidth = ringWidth
            path.stroke()
        }
        return image
    }

    /// The GPS "Clock" marker: a 24-pt translucent blue halo with a 10-pt solid
    /// blue dot and a 2-pt white ring at its centre.
    static func gpsDot() -> NSImage {
        let side: CGFloat = 24
        let image = NSImage(size: NSSize(width: side, height: side))
        image.lockFocus()
        defer { image.unlockFocus() }
        let center = NSPoint(x: side / 2, y: side / 2)

        let halo = NSBezierPath(ovalIn: NSRect(x: center.x - 12, y: center.y - 12,
                                               width: 24, height: 24))
        NSColor.systemBlue.withAlphaComponent(0.2).setFill()
        halo.fill()

        let inner = NSBezierPath(ovalIn: NSRect(x: center.x - 5, y: center.y - 5,
                                                width: 10, height: 10))
        NSColor.systemBlue.setFill()
        inner.fill()
        NSColor.white.setStroke()
        inner.lineWidth = 2
        inner.stroke()
        return image
    }
}
