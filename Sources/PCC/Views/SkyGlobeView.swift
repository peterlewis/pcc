import SwiftUI
import WebKit
import CoreLocation

// MARK: - Clock overlay format

/// Format used by the on-globe digital clock overlay.
///
/// - `.matchClock` — the app's local-time clock format, `YYYY-MM-DD HH:MM:SS.mmm`
///                   in the user's local timezone. This is the default.
/// - `.iso8601`    — full ISO 8601 with `T` separator and `Z` suffix in UTC,
///                   `YYYY-MM-DDTHH:MM:SS.mmmZ`.
enum GlobeClockFormat: String, CaseIterable, Identifiable, Codable {
    case matchClock
    case iso8601

    var id: Self { self }

    var displayName: String {
        switch self {
        case .matchClock: return "Match clock format"
        case .iso8601:    return "ISO 8601"
        }
    }

    /// Short example showing the resulting string shape.
    var example: String {
        switch self {
        case .matchClock: return "2026-04-18 14:23:05.123"
        case .iso8601:    return "2026-04-18T14:23:05.123Z"
        }
    }

    static let defaultsKey = "globeClockFormat"

    static var current: GlobeClockFormat {
        if let raw = UserDefaults.standard.string(forKey: defaultsKey),
           let v = GlobeClockFormat(rawValue: raw) {
            return v
        }
        return .matchClock
    }
}

/// Observable holder for the globe's clock-overlay preferences. Persists to
/// UserDefaults so the choice survives relaunch.
@MainActor
final class GlobeClockSettings: ObservableObject {
    static let shared = GlobeClockSettings()

    @Published var format: GlobeClockFormat {
        didSet {
            UserDefaults.standard.set(format.rawValue, forKey: GlobeClockFormat.defaultsKey)
        }
    }

    @Published var isVisible: Bool {
        didSet {
            UserDefaults.standard.set(isVisible, forKey: "globeClockVisible")
        }
    }

    private init() {
        self.format = GlobeClockFormat.current
        // Default to ON — the user wants the clock visible by default.
        if UserDefaults.standard.object(forKey: "globeClockVisible") == nil {
            self.isVisible = true
        } else {
            self.isVisible = UserDefaults.standard.bool(forKey: "globeClockVisible")
        }
    }
}

// MARK: - SkyGlobeView

/// 3D globe visualization of satellite positions using globe.gl.
///
/// Rendering model:
/// - Live satellites → HTML elements at sub-satellite lat/lng (pulsing dots).
/// - Recorded passes → WebGL polylines via `pathsData`, altitude per-point
///   matching the live satellite's observer-elevation formula so arcs rise
///   with elevation instead of skating flat across the sphere.
/// - Sun/Moon → HTML elements at observer-relative projected positions.
/// - User location → animated ring.
/// - Digital clock → HTML overlay, format user-selectable.
///
/// Look: photographic Earth with a real day/night terminator driven by
/// `Astronomy.subSolarPoint(date:)`. globe.gl UMD bundles its own THREE
/// instance and doesn't expose it; trying to hand it a `ShaderMaterial`
/// built from a separately-loaded THREE leaves the globe black because
/// three-globe's duck-typing rejects cross-instance objects.
///
/// The working approach (shipped): patch the default `MeshPhongMaterial`
/// via `onBeforeCompile` — everything stays inside globe.gl's bundled
/// THREE. The shader replaces `<opaque_fragment>` with
/// `mix(nightTex, dayTex, smoothstep(-0.1, 0.1, sunDotN))` and we switch
/// the scene's lights off (`myGlobe.lights([])`) so the Phong lighting
/// gradient never muddies either hemisphere. The result matches the
/// globe.gl `day-night-cycle` reference example: full texture saturation
/// on both sides of a crisp, narrow terminator band.
///
/// All runtime assets (globe.gl UMD, earth-day/earth-night/night-sky
/// images) live under `Sources/PCC/Resources/Globe/` and are bundled
/// locally — the globe works offline with a pinned version of every
/// third-party asset. Licensing: see `THIRD_PARTY_LICENSES.md`.
struct SkyGlobeView: View {
    let geometryCache: PassGeometryCache
    let satellites: [SatelliteInfo]
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    var userLatitude: Double?
    var userLongitude: Double?
    var passes: [SatPass] = []
    var activePRNs: Set<String> = []
    var now: Date = Date()
    /// When `false`, bypasses the Swift-side moving-average filter on az/el
    /// so every rendered vertex is literally a NMEA observation (visible 1°
    /// integer-quantization staircase and all). The toggle lives in `SkyView`;
    /// this property is the bound value.
    var smoothTrails: Bool = true

    // Toggle state is owned by the shared `AppSettings` so the user's
    // choices persist across launches. The overlay buttons bind directly
    // into the published properties.
    @EnvironmentObject var settings: AppSettings
    @ObservedObject private var clockSettings = GlobeClockSettings.shared

    var body: some View {
        GlobeWebView(
            geometryCache: geometryCache,
            satellites: settings.skyShowSatellites ? satellites : [],
            sunPosition: settings.skyShowCelestials ? sunPosition : nil,
            moonPosition: settings.skyShowCelestials ? moonPosition : nil,
            userLatitude: userLatitude,
            userLongitude: userLongitude,
            passes: passes,
            activePRNs: activePRNs,
            now: now,
            showLabels: settings.skyShowLabels,
            smoothTrails: smoothTrails,
            clockFormat: clockSettings.format,
            clockVisible: clockSettings.isVisible,
            clockSettings: clockSettings
        )
        .overlay(alignment: .topTrailing) {
            HStack(spacing: 2) {
                toggleButton("scope", isOn: $settings.skyShowSatellites, tip: "Satellites")
                toggleButton("sun.and.horizon", isOn: $settings.skyShowCelestials, tip: "Sun & Moon")
                toggleButton("tag", isOn: $settings.skyShowLabels, tip: "Labels")
                toggleButton("waveform.path", isOn: $settings.skySmoothTrails,
                             tip: "Smooth trails (average NMEA jitter)")
                toggleButton(clockSettings.isVisible ? "clock" : "clock.badge.xmark",
                             isOn: $clockSettings.isVisible,
                             tip: "Clock (right-click the clock to change format)")
            }
            .padding(4)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 6))
            .padding(8)
        }
    }

    private func toggleButton(_ icon: String, isOn: Binding<Bool>, tip: String) -> some View {
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            Image(systemName: icon)
                .font(.caption)
                .frame(width: 24, height: 24)
                .foregroundStyle(isOn.wrappedValue ? .primary : .tertiary)
        }
        .buttonStyle(.borderless)
        .help(tip)
    }
}

// MARK: - WebView Wrapper

private struct GlobeWebView: NSViewRepresentable {
    let geometryCache: PassGeometryCache
    let satellites: [SatelliteInfo]
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    let userLatitude: Double?
    let userLongitude: Double?
    let passes: [SatPass]
    let activePRNs: Set<String>
    let now: Date
    let showLabels: Bool
    /// Passed through to `SatPass.groundTrackSegments` — when `false`, disables
    /// the Swift-side az/el moving-average filter so the rendered polyline
    /// passes through every raw NMEA observation (visible 1° staircase).
    let smoothTrails: Bool
    let clockFormat: GlobeClockFormat
    let clockVisible: Bool
    /// Shared clock-overlay settings. The coordinator holds a reference so
    /// that click/right-click on the HTML clock element can mutate visibility
    /// and format directly — no round-trip through the overlay button is
    /// required for the "just click the clock" UX.
    let clockSettings: GlobeClockSettings

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let userController = WKUserContentController()
        userController.add(context.coordinator, name: "globeReady")
        userController.add(context.coordinator, name: "globeLog")
        userController.add(context.coordinator, name: "clockToggle")
        userController.add(context.coordinator, name: "clockCycleFormat")
        config.userContentController = userController

        // Serve bundled globe resources via a custom URL scheme instead of
        // `file://`. Two problems this solves at once:
        //
        //   1. three.js's TextureLoader sets `image.crossOrigin = 'anonymous'`
        //      on every image load, which triggers CORS. `file://` has no
        //      HTTP headers → no `Access-Control-Allow-Origin` → CORS fails
        //      silently → globe renders black with no textures. (The previous
        //      attempt poked `allowFileAccessFromFileURLs` on `WKPreferences`
        //      via KVC, but those keys are no longer KVC-accessible on
        //      macOS 26.4 — `setValue(_:forKey:)` raises
        //      `NSUndefinedKeyException` at layout time and crashes the app.)
        //
        //   2. A `WKURLSchemeHandler` lets us answer every request with a
        //      proper `Content-Type` and `Access-Control-Allow-Origin: *`
        //      header, so CORS-anonymous image loads succeed with no
        //      private API.
        //
        // The handler is retained by the configuration, so no storage on
        // `self` or the coordinator is required.
        let resourceHandler = GlobeResourceHandler()
        config.setURLSchemeHandler(resourceHandler,
                                   forURLScheme: GlobeResourceHandler.scheme)

        let webView = WKWebView(frame: .zero, configuration: config)
        // NB: do NOT poke `setValue(false, forKey: "drawsBackground")` here.
        // `drawsBackground` is private WKWebView KVC and on macOS 26.x raises
        // an uncatchable `NSUndefinedKeyException` at layout time, crashing the
        // app. It also had no visible effect — the loaded page paints an opaque
        // black body, so the web view never shows through anyway. If genuine
        // transparency is ever needed, use the public `underPageBackgroundColor`
        // instead of private KVC.

        // Relative refs (`./globe.gl.min.js`, `./earth-day.jpg`, …) in the
        // bundled HTML resolve against this document URL, so they all go
        // through `GlobeResourceHandler`.
        if let url = URL(string: "\(GlobeResourceHandler.scheme)://globe/index.html") {
            webView.load(URLRequest(url: url))
        }

        context.coordinator.webView = webView
        context.coordinator.clockSettings = clockSettings
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // Keep the coordinator's settings ref fresh in case the SwiftUI
        // identity changes across updates (cheap and avoids stale closures).
        context.coordinator.clockSettings = clockSettings
        // The coordinator is passed in because the path-update step is now
        // INCREMENTAL: it diffs the current paths against what was last sent
        // (state that must persist across updates, so it lives on the
        // coordinator) and emits only a delta. Everything else in the JS
        // string is still recomputed wholesale each tick — those updates are
        // cheap; only the path re-tessellation was expensive.
        let js = buildUpdateJS(coordinator: context.coordinator)
        context.coordinator.pendingJS = js
        context.coordinator.sendIfReady()
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator: NSObject, WKScriptMessageHandler {
        weak var webView: WKWebView?
        weak var clockSettings: GlobeClockSettings?
        var isReady = false
        var pendingJS: String?

        // MARK: Incremental path-diff state
        //
        // These persist across SwiftUI updates so each tick can compute a
        // delta against the last send instead of reshipping every polyline.
        //
        // `sentPathVersions` maps a path's stable id
        // (`"<passUUID>#<segmentIndex>"`) to the content-version string that
        // was last sent for it. A path is re-sent (upserted) only when its id
        // is new or its version differs; ids present last time but absent now
        // are removed. When neither set has anything, no path update is sent
        // at all — the steady-state win that stops the per-second
        // re-tessellation of unchanged tracks.
        var sentPathVersions: [String: String] = [:]

        // Signature of the GLOBAL inputs that, when changed, invalidate every
        // path at once (the visible pass set's time-window trim, the
        // smoothTrails toggle, and the quantized observer position — all of
        // which can change every path's coordinates). A mismatch forces a
        // full `replaceAll` rather than a per-path diff. `nil` until the first
        // send so the first update always rebuilds from scratch.
        var lastGlobalSignature: String?

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            switch message.name {
            case "globeReady":
                isReady = true
                sendIfReady()
            case "globeLog":
                print("[Globe] \(message.body)")
            case "clockToggle":
                // Left-click on the clock overlay → toggle visibility. The
                // new state flows back down through the next SwiftUI update
                // via `setClockFormat(mode, visible)` so CSS and state stay
                // in lockstep.
                DispatchQueue.main.async { [weak self] in
                    self?.clockSettings?.isVisible.toggle()
                }
            case "clockCycleFormat":
                // Right-click on the clock overlay → cycle through available
                // formats. With only two formats (match-clock / ISO 8601) a
                // cycle feels natural; if we grow the format list we'll swap
                // this for a proper menu.
                DispatchQueue.main.async { [weak self] in
                    guard let settings = self?.clockSettings else { return }
                    let all = GlobeClockFormat.allCases
                    guard let idx = all.firstIndex(of: settings.format) else { return }
                    let next = all[(idx + 1) % all.count]
                    settings.format = next
                }
            default:
                break
            }
        }

        func sendIfReady() {
            guard isReady, let js = pendingJS, let webView else { return }
            webView.evaluateJavaScript(js, completionHandler: nil)
            pendingJS = nil
        }
    }

    // MARK: - Data → JS

    private func buildUpdateJS(coordinator: Coordinator) -> String {
        // Globe trails get a substantial stroke boost so the WebGL fat-line
        // tubes read as solid, overlapping ribbons rather than a string of
        // beads. The previous 1.7× left the tube too thin to bridge the
        // angular gap between adjacent (now full-resolution) observations, so
        // the joins pinched into discrete dots; 3.2× makes each tube fat
        // enough to fuse into a continuous sweep. The matching `pathResolution`
        // bump in index.html does the rest. Opacity still comes directly from
        // `PassAgeTier.opacity(endAge:isLive:)` with no extra multiplier — one
        // source of truth for fade.
        let trailStrokeScale = 2.2

        // Live satellite dots require a real observer fix. The sub-satellite
        // projection is observer-relative, so without a fix we'd previously
        // fall back to (0,0) and scatter every tracked satellite into the Gulf
        // of Guinea off west Africa. Gate the whole loop on a non-nil fix —
        // mirroring how trails, rings, and celestials below already do — so no
        // dots appear until we actually know where the observer is.
        var satData: [[String: Any]] = []
        if let observerLat = userLatitude, let observerLon = userLongitude {
            for sat in satellites where (sat.snr ?? 0) > 0 {
                guard let coord = sat.subSatellitePoint(
                    observerLat: observerLat,
                    observerLon: observerLon
                ) else { continue }
                let isLive = activePRNs.contains(sat.id)
                let dotAlpha: Double = isLive ? 0.92 : 0.72  // Translucent, not solid.
                satData.append([
                    "lat": coord.latitude,
                    "lng": coord.longitude,
                    "alt": satAltitude(forElevation: Double(sat.elevation)),
                    "color": sat.constellation.hex,
                    "fill": sat.constellation.rgba(alpha: dotAlpha),
                    "size": isLive ? 9 : 7,
                    "name": sat.id,
                    "label": showLabels ? sat.id : "",
                    "type": isLive ? "live" : "satellite"
                ])
            }
        }

        // Trail paths — one polyline per pass SEGMENT. Per-point altitude
        // matches the live-satellite formula so a recorded arc rises with
        // observed elevation instead of skating flat across the sphere.
        //
        // Each entry carries a STABLE id and a content VERSION alongside its
        // dict so the diff downstream can decide what actually needs
        // re-sending. The id and version are NOT shipped as path style — the
        // id rides in the dict purely as the JS Map key; the version stays
        // Swift-side in `sentPathVersions`.
        var pathEntries: [(id: String, version: String, dict: [String: Any])] = []

        if let lat = userLatitude, let lon = userLongitude {
            let ordered = passes.sorted { $0.endTime < $1.endTime }
            for pass in ordered {
                let isLive = activePRNs.contains(pass.prn)
                let endAge = now.timeIntervalSince(pass.endTime)
                // Age tier drives both the per-pass point budget (older passes
                // decimated harder to bound frame time — issue #7) and the
                // fade/taper styling.
                let tier = PassAgeTier.tier(endAge: endAge, isLive: isLive)
                let alpha = PassAgeTier.opacity(endAge: endAge, isLive: isLive)
                let stroke = Double(PassAgeTier.strokeWidth(endAge: endAge, isLive: isLive))
                    * trailStrokeScale

                // Content version. A path's dict changes iff its coords,
                // color, or stroke change, so the version must move iff one of
                // those would:
                //   - observation count covers live growth (more points) and
                //     a window trim handing back a shorter same-id pass.
                //   - opacity and stroke are CONTINUOUS functions of age (the
                //     look depends on that — they are deliberately not
                //     quantized into the rendered dict). But a continuous value
                //     drifts every tick, which alone would defeat the identity
                //     diff. So we quantize ONLY here, finely: ~0.005 in opacity
                //     and ~0.05 in stroke. An imperceptible per-second drift (a
                //     6 h-old pass moves ~0.0001/s in opacity) stays on the same
                //     step and is NOT re-sent, while genuine fade still crosses
                //     a step every few minutes and re-sends — visually smooth,
                //     incrementally stable.
                let opacityQ = Int((alpha * 200).rounded())
                let strokeQ = Int((stroke * 20).rounded())
                let version = "\(pass.observations.count):\(opacityQ):\(strokeQ)"

                // Age-based desaturation (FIX #4). Alpha alone separates ages
                // poorly against the dense, bright globe, so we ALSO cool/mute
                // the hue with age: newest/live keeps full constellation
                // saturation, oldest fades toward a desaturated cool-grey.
                //
                // The desaturation amount is derived from `opacityQ` — the SAME
                // quantized age signal already in the version string above — not
                // from the raw `alpha`. That is the key to keeping the
                // incremental delta system honest: the rendered colour is now a
                // pure function of `opacityQ`, so it is byte-identical whenever
                // `opacityQ` is, and it changes ONLY when `opacityQ` changes —
                // which already bumps the version and triggers that path's
                // re-send. No new continuously-varying colour dimension is
                // introduced, so no extra version component is needed.
                let trailColor = desaturatedTrailColor(
                    for: pass.constellation,
                    opacityQ: opacityQ,
                    alpha: alpha
                )

                // Segmented ground track: the pass is split at recording gaps
                // and each run is smoothed and decimated to its share of the
                // tier budget. Each segment is pushed as its OWN path entry —
                // concatenating them into one polyline let globe.gl draw a
                // great-circle chord across the gap through unobserved sky,
                // which is the "spiral" artefact (issue #8).
                let segments = geometryCache.groundSegments(for: pass, observerLat: lat, observerLon: lon,
                                                            maxPoints: tier.maxPoints,
                                                            smoothingWindow: smoothTrails ? 0 : 1)
                for (segmentIndex, segment) in segments.enumerated() {
                    guard segment.count >= 2 else { continue }
                    // Stable across ticks: same pass + same segment ordinal →
                    // same id, so an unchanged segment keeps its WebGL geometry.
                    let id = "\(pass.id.uuidString)#\(segmentIndex)"
                    let points: [[Double]] = segment.map { sample in
                        [sample.coord.latitude,
                         sample.coord.longitude,
                         satAltitude(forElevation: sample.elevation)]
                    }
                    pathEntries.append((
                        id: id,
                        version: version,
                        dict: [
                            "id": id,
                            "coords": points,
                            "color": trailColor,
                            "stroke": stroke
                        ]
                    ))
                }
            }
        }

        // Sun & Moon. Altitude is the dot's distance above the sphere (globe
        // radius = 1). Satellites top out at 0.10 (90° elevation). The
        // celestial bodies live much farther out in reality, so visually
        // perch them well above the satellite shell — 0.30 / 0.24 reads as
        // "up in the sky" rather than "a high satellite". The atmosphere is
        // drawn at 0.15, so these also clear that layer cleanly.
        var celestialData: [[String: Any]] = []
        if let lat = userLatitude, let lon = userLongitude {
            if let sun = sunPosition, sun.altitude > 0,
               let coord = celestialCoordinate(sun, observerLat: lat, observerLon: lon) {
                celestialData.append([
                    "lat": coord.latitude,
                    "lng": coord.longitude,
                    "alt": 0.30,
                    "color": "rgba(255,230,100,0.9)",
                    "fill": "rgba(255,230,100,0.85)",
                    // The real angular diameters of sun and moon are nearly
                    // identical (~0.5°), but visually the sun reads as the
                    // dominant light source, so we give it a clear size
                    // advantage here rather than faithful-but-confusing parity.
                    "size": 18,
                    "name": "Sun", "label": "", "type": "celestial"
                ])
            }
            if let moon = moonPosition, moon.altitude > 0,
               let coord = celestialCoordinate(moon, observerLat: lat, observerLon: lon) {
                celestialData.append([
                    "lat": coord.latitude,
                    "lng": coord.longitude,
                    "alt": 0.24,
                    "color": "rgba(230,232,240,0.9)",
                    "fill": "rgba(230,232,240,0.85)",
                    "size": 11,
                    "name": "Moon", "label": "", "type": "celestial"
                ])
            }
        }

        // Rings at user location
        var rings: [[String: Any]] = []
        if let lat = userLatitude, let lon = userLongitude {
            rings.append(["lat": lat, "lng": lon])
        }

        // Sub-solar point — drives the day/night terminator and the
        // directional-light position.
        let subSolar = Astronomy.subSolarPoint(date: now)

        var js = ""
        js += "if(window.setSunDirection)setSunDirection(\(subSolar.latitude),\(subSolar.longitude));"

        // Clock overlay: mode + visibility. The JS side drives its own tick
        // loop so the displayed time doesn't stutter at Swift's push cadence.
        js += "if(window.setClockFormat)setClockFormat('\(clockFormat.rawValue)',\(clockVisible ? "true" : "false"));"

        let allElements = satData + celestialData
        if let json = jsonString(allElements) {
            js += "if(window.updateElements)updateElements(\(json));"
        }
        if let ringJson = jsonString(rings) {
            js += "if(window.updateRings)updateRings(\(ringJson));"
        }

        // ---- Incremental path delta -------------------------------------
        // Decide the smallest path update that brings the globe's Map in line
        // with the current frame, exploiting three-globe's object-identity
        // diff. See `Coordinator.sentPathVersions` for the rationale.
        if let pathJS = buildPathDeltaJS(entries: pathEntries, coordinator: coordinator) {
            js += pathJS
        }

        if let lat = userLatitude, let lon = userLongitude {
            js += "if(window.focusOn)focusOn(\(lat),\(lon));"
        }
        return js
    }

    /// Compute the incremental `applyPathDelta` call (or `nil` when nothing
    /// about the paths changed this tick — the common steady state).
    ///
    /// Mutates the coordinator's `sentPathVersions` / `lastGlobalSignature` to
    /// reflect what is now on the globe.
    ///
    /// Decision order:
    ///  - If the GLOBAL signature changed (time-window membership,
    ///    `smoothTrails`, or the quantized observer position — any of which can
    ///    silently move every path's coords WITHOUT changing its per-path
    ///    version), rebuild everything via `replaceAll`. This is the only thing
    ///    that catches an observer move or a smoothTrails toggle, because those
    ///    leave observation count, opacity, and stroke untouched.
    ///  - Otherwise upsert paths that are new or whose version differs, and
    ///    remove ids that were sent before but are gone now.
    ///  - If neither set has anything, send no path update at all.
    private func buildPathDeltaJS(entries: [(id: String, version: String, dict: [String: Any])],
                                  coordinator: Coordinator) -> String? {
        // Global signature. Observer position is quantized to ~1e-3° (≈100 m),
        // matching `PassGeometryCache`'s own key granularity so the two agree
        // on what counts as "moved". The visible pass set is folded in by id
        // MEMBERSHIP only — never by observation count, since a live pass's
        // count climbing each tick must NOT trigger a global rebuild (that is
        // a per-path upsert). A window change alters membership and so does
        // flip the signature, forcing the (rare, user-initiated) full rebuild.
        let obsSig: String
        if let lat = userLatitude, let lon = userLongitude {
            let latQ = Int((lat * 1000).rounded())
            let lonQ = Int((lon * 1000).rounded())
            obsSig = "\(latQ),\(lonQ)"
        } else {
            obsSig = "none"
        }
        // Membership is the raw sorted id list, not its `hashValue`: Swift's
        // string hash is per-process randomized (stable within a run, but we
        // avoid depending on that) and a hash collision could in theory mask a
        // membership change. The list is short enough (≈100 UUIDs) that direct
        // comparison each tick is negligible. Membership change is in any case
        // also caught by the per-path upsert/remove below; this just promotes
        // it to a clean full rebuild.
        let memberSig = passes.map { $0.id.uuidString }.sorted().joined(separator: ",")
        let globalSignature = "\(smoothTrails ? 1 : 0)|\(obsSig)|\(memberSig)"

        // Current id → version. (The dicts themselves are read straight from
        // `entries` when building upserts, so no separate id→dict map is kept.)
        var currentVersions: [String: String] = [:]
        currentVersions.reserveCapacity(entries.count)
        for entry in entries {
            // Ids are unique per (pass, segmentIndex); on the off chance of a
            // collision, last write wins — harmless, the dicts are equivalent.
            currentVersions[entry.id] = entry.version
        }

        let globalChanged = coordinator.lastGlobalSignature != globalSignature

        if globalChanged {
            // Full rebuild: replace the entire dataset with every current dict.
            // Order is stable (passes were sorted by endTime upstream) so the
            // newest tracks draw last / on top, as before.
            let allDicts = entries.map { $0.dict }
            // Serialize BEFORE committing state: if serialization were to fail
            // we must not record a send that never reached the globe, or the
            // next diff would compute against a phantom baseline. We also hold
            // off updating `lastGlobalSignature` so a failed rebuild is retried
            // next tick rather than silently skipped.
            guard let upsertJSON = jsonString(allDicts) else { return nil }
            coordinator.lastGlobalSignature = globalSignature
            coordinator.sentPathVersions = currentVersions
            return "if(window.applyPathDelta)applyPathDelta({replaceAll:true,upsert:\(upsertJSON)});"
        }
        coordinator.lastGlobalSignature = globalSignature

        // Per-path diff against the last send.
        var upsertDicts: [[String: Any]] = []
        for entry in entries where coordinator.sentPathVersions[entry.id] != entry.version {
            upsertDicts.append(entry.dict)
        }
        var removeIDs: [String] = []
        for id in coordinator.sentPathVersions.keys where currentVersions[id] == nil {
            removeIDs.append(id)
        }

        if upsertDicts.isEmpty && removeIDs.isEmpty {
            // Steady state: nothing changed, so the globe keeps every existing
            // line object by identity and we skip the path call entirely.
            // `sentPathVersions` already equals `currentVersions` here (same
            // ids, same versions), so there is nothing to commit.
            return nil
        }

        // Serialize the delta first; only once we have a payload to ship do we
        // commit the new baseline, so Swift's record of the globe's contents
        // never drifts from what was actually applied.
        var parts: [String] = []
        if !removeIDs.isEmpty {
            guard let removeJSON = jsonString(removeIDs) else { return nil }
            parts.append("remove:\(removeJSON)")
        }
        if !upsertDicts.isEmpty {
            guard let upsertJSON = jsonString(upsertDicts) else { return nil }
            parts.append("upsert:\(upsertJSON)")
        }
        coordinator.sentPathVersions = currentVersions
        return "if(window.applyPathDelta)applyPathDelta({\(parts.joined(separator: ","))});"
    }

    /// Satellite-to-globe altitude mapping. Sits on a band well off the sphere
    /// (0.02–0.10) so both the live dot and the recorded trail clearly float
    /// over the surface, with higher-elevation passes visibly higher than
    /// low ones — same geometry for both so a trail traces the dot's arc.
    private func satAltitude(forElevation elDeg: Double) -> Double {
        let clamped = max(0.0, min(90.0, elDeg))
        return 0.02 + (clamped / 90.0) * 0.08
    }

    private func jsonString(_ obj: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let str = String(data: data, encoding: .utf8) else { return nil }
        return str
    }

    /// Constellation colour for a trail, cooled and desaturated by age so older
    /// tracks read as older (FIX #4). Returns a pre-formatted `rgba(...)` string
    /// for globe.gl `pathColor`.
    ///
    /// Why blend toward a *cool grey* and not just lower alpha: against the
    /// bright, dense day/night globe a pure alpha fade barely separates a
    /// 1 h-old arc from a 6 h-old one — both stay vividly coloured. Pulling the
    /// hue toward a muted blue-grey as it ages gives a second, stronger depth
    /// cue: live/newest sweeps stay fully saturated and "hot", week-old ones
    /// recede into a faint cool wash.
    ///
    /// Incremental-system contract: the desaturation amount is a pure function
    /// of `opacityQ` — the quantized opacity already folded into each path's
    /// version string — reconstructed here as `Double(opacityQ) / 200`. We do
    /// NOT key it off the raw continuous `alpha`. That guarantees the emitted
    /// colour is constant for a constant `opacityQ` and changes only when
    /// `opacityQ` steps, which already moves the version and re-sends the path.
    /// `alpha` is passed in only as the (already-quantized-upstream) value to
    /// bake into the rgba's own alpha channel, keeping one source of truth for
    /// the fade while the hue cooling rides the same age step.
    private func desaturatedTrailColor(for constellation: SatConstellation,
                                       opacityQ: Int,
                                       alpha: Double) -> String {
        let (r, g, b) = constellation.rgb255

        // Reconstruct the quantized alpha so the cooling is a step function of
        // the SAME signal the version key tracks (see contract above).
        let quantAlpha = Double(opacityQ) / 200.0

        // Map opacity → "age fraction" across the non-live fade band. The
        // opacity curve runs ≈0.58 (just ended) down to a 0.06 floor (≈7 d+),
        // with live pinned at 0.75. Normalize so freshly-ended ≈ 0 (no cooling)
        // and the oldest ≈ 1 (max cooling); anything brighter than the
        // just-ended value (i.e. live) also clamps to 0. Cheap arithmetic only.
        let freshAlpha = 0.58
        let oldAlpha = 0.06
        let raw = (freshAlpha - quantAlpha) / (freshAlpha - oldAlpha)
        let ageFraction = max(0.0, min(1.0, raw))

        // Cap the blend so the oldest tracks are clearly muted but never lose
        // their hue entirely (a fully grey trail would be unreadable against
        // the night side). 0.7 leaves ~30% of the original chroma at the floor.
        let blend = ageFraction * 0.7

        // Cool-grey target: a slightly blue-biased neutral so aged trails drift
        // cool rather than to a dead flat grey, reinforcing the "receding into
        // the dark" read. Mid-low luminance so they sit back against the globe.
        let targetR = 120.0, targetG = 130.0, targetB = 150.0

        let mr = Double(r) + (targetR - Double(r)) * blend
        let mg = Double(g) + (targetG - Double(g)) * blend
        let mb = Double(b) + (targetB - Double(b)) * blend

        let clampChannel: (Double) -> Int = { Int(max(0.0, min(255.0, $0)).rounded()) }
        let a = max(0.0, min(1.0, alpha))
        return String(format: "rgba(%d,%d,%d,%.3f)",
                      clampChannel(mr), clampChannel(mg), clampChannel(mb), a)
    }

    /// Project a celestial body (sun/moon) from observer azimuth/elevation to lat/lon on the globe.
    private func celestialCoordinate(_ pos: CelestialPosition, observerLat: Double, observerLon: Double) -> (latitude: Double, longitude: Double)? {
        guard pos.altitude > 0 else { return nil }
        let angularDist = (90.0 - pos.altitude) / 90.0 * 25.0
        let azRad = pos.azimuth * .pi / 180
        let distRad = angularDist * .pi / 180
        let latRad = observerLat * .pi / 180
        let lonRad = observerLon * .pi / 180

        // Clamp the asin argument into [-1, 1]. Floating-point error can push
        // it a hair past ±1, and `asin` then returns NaN. On the globe that NaN
        // flows into the `celestialData` dictionary and reaches
        // `JSONSerialization.data(withJSONObject:)`, which throws
        // `NSInvalidArgumentException` — an Objective-C exception Swift cannot
        // catch, so it crashes the app outright. Mirrors `subSatellitePointD`.
        let sinLat = sin(latRad) * cos(distRad) + cos(latRad) * sin(distRad) * cos(azRad)
        let lat = asin(max(-1, min(1, sinLat)))
        let lon = lonRad + atan2(
            sin(azRad) * sin(distRad) * cos(latRad),
            cos(distRad) - sin(latRad) * sin(lat)
        )
        return (lat * 180 / .pi, lon * 180 / .pi)
    }
}

// MARK: - Bundle resource scheme handler

/// Serves files under the resource bundle's `Globe/` directory (resolved
/// via `Bundle.pccResources`) through a custom URL scheme so the WKWebView
/// can load them with a real HTTP-style response.
///
/// Why a scheme handler and not `loadFileURL`: three.js's `TextureLoader`
/// sets `image.crossOrigin = 'anonymous'` on every load, which turns the
/// request into a CORS request. `file://` has no HTTP headers, so CORS
/// fails silently and every texture comes back empty — the globe renders
/// black even though the scripts run. Serving via this handler lets us
/// attach `Access-Control-Allow-Origin: *` and a proper `Content-Type`,
/// which satisfies CORS without touching private WebKit API.
///
/// Scheme layout: `pccglobe://globe/<relative path under Globe/>`.
/// The host is fixed at `globe` so everything lives on one origin; only
/// the path varies. Example URLs the HTML ends up requesting:
///
///   - `pccglobe://globe/index.html`        (the page itself)
///   - `pccglobe://globe/globe.gl.min.js`   (via `<script src>`)
///   - `pccglobe://globe/earth-day.jpg`     (via three.js TextureLoader)
///   - `pccglobe://globe/earth-night.jpg`
///   - `pccglobe://globe/night-sky.png`
///
/// Path-traversal guard: the resolved path is checked against the bundle
/// directory's prefix so a crafted `../` can't escape. We only serve
/// content from our own bundle, but the guard is cheap insurance.
private final class GlobeResourceHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "pccglobe"

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        // Map the URL path onto a file inside the bundled `Globe/` dir.
        // Default to `index.html` for `/` so a bare host URL works.
        var relative = url.path
        if relative.hasPrefix("/") { relative.removeFirst() }
        if relative.isEmpty { relative = "index.html" }

        let globeDir = Bundle.pccResources.bundleURL
            .appendingPathComponent("Globe")
            .standardizedFileURL
        let fileURL = globeDir
            .appendingPathComponent(relative)
            .standardizedFileURL

        // Keep the scheme handler a strict servant of the bundled dir —
        // reject anything that resolves outside it (defence in depth).
        guard fileURL.path.hasPrefix(globeDir.path) else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        do {
            let data = try Data(contentsOf: fileURL)
            let mime = Self.mimeType(forExtension: fileURL.pathExtension)
            // `Access-Control-Allow-Origin: *` keeps three.js's
            // `crossOrigin = 'anonymous'` image loads happy. `no-store`
            // stops WKWebView caching a stale copy if we ever edit the
            // HTML/JS during development.
            guard let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": mime,
                    "Content-Length": "\(data.count)",
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-store"
                ]
            ) else {
                // Effectively unreachable with these inputs, but avoid force
                // unwrapping so a malformed header value never brings the
                // whole globe view down.
                urlSchemeTask.didFailWithError(URLError(.cannotParseResponse))
                return
            }
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        // We complete synchronously in `start`, so there's nothing to
        // cancel — but WKURLSchemeHandler requires the method regardless.
    }

    private static func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm":  return "text/html; charset=utf-8"
        case "js", "mjs":    return "application/javascript; charset=utf-8"
        case "css":          return "text/css; charset=utf-8"
        case "json":         return "application/json; charset=utf-8"
        case "jpg", "jpeg":  return "image/jpeg"
        case "png":          return "image/png"
        case "webp":         return "image/webp"
        case "svg":          return "image/svg+xml"
        case "gif":          return "image/gif"
        default:             return "application/octet-stream"
        }
    }
}
