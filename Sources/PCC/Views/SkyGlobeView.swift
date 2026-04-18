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
    let satellites: [SatelliteInfo]
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    let userLatitude: Double?
    let userLongitude: Double?
    let passes: [SatPass]
    let activePRNs: Set<String>
    let now: Date
    let showLabels: Bool
    /// Passed through to `SatPass.groundTrackPoints` — when `false`, disables
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
        webView.setValue(false, forKey: "drawsBackground")

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
        let js = buildUpdateJS()
        context.coordinator.pendingJS = js
        context.coordinator.sendIfReady()
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator: NSObject, WKScriptMessageHandler {
        weak var webView: WKWebView?
        weak var clockSettings: GlobeClockSettings?
        var isReady = false
        var pendingJS: String?

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

    private func buildUpdateJS() -> String {
        // Globe trails get a modest stroke boost so WebGL-smoothed lines read
        // at a similar visual weight to the Canvas-rasterised polar plot.
        // Opacity comes directly from `PassAgeTier.opacity(endAge:isLive:)`
        // without any additional multiplier — one source of truth for fade.
        let trailStrokeScale = 1.7

        var satData: [[String: Any]] = []
        for sat in satellites where (sat.snr ?? 0) > 0 {
            guard let coord = sat.subSatellitePoint(
                observerLat: userLatitude ?? 0,
                observerLon: userLongitude ?? 0
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

        // Trail paths — one polyline per pass. Per-point altitude matches the
        // live-satellite formula so a recorded arc rises with observed
        // elevation instead of skating flat across the sphere.
        var pathData: [[String: Any]] = []

        if let lat = userLatitude, let lon = userLongitude {
            let ordered = passes.sorted { $0.endTime < $1.endTime }
            for pass in ordered {
                let isLive = activePRNs.contains(pass.prn)
                let endAge = now.timeIntervalSince(pass.endTime)
                // Render every real observation — no decimation. Earlier
                // versions passed `tier.maxPoints` here; globe.gl's path
                // smoothing then interpolated phantom vertices between the
                // sparse survivors, which looked like fake "points" along
                // the line. Feeding every real fix keeps segments short
                // enough that the spline has no room to wobble, and every
                // visible vertex corresponds to an actual NMEA observation.
                let samples = pass.groundTrackPoints(observerLat: lat, observerLon: lon,
                                                     maxPoints: .max,
                                                     smoothingWindow: smoothTrails ? 0 : 1)
                guard samples.count >= 2 else { continue }
                let points: [[Double]] = samples.map { sample in
                    [sample.coord.latitude,
                     sample.coord.longitude,
                     satAltitude(forElevation: sample.elevation)]
                }
                let alpha = PassAgeTier.opacity(endAge: endAge, isLive: isLive)
                let stroke = Double(PassAgeTier.strokeWidth(endAge: endAge, isLive: isLive))
                    * trailStrokeScale
                pathData.append([
                    "coords": points,
                    "color": pass.constellation.rgba(alpha: alpha),
                    "stroke": stroke
                ])
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
        if let pathJson = jsonString(pathData) {
            js += "if(window.updatePaths)updatePaths(\(pathJson));"
        }
        if let lat = userLatitude, let lon = userLongitude {
            js += "if(window.focusOn)focusOn(\(lat),\(lon));"
        }
        return js
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

    /// Project a celestial body (sun/moon) from observer azimuth/elevation to lat/lon on the globe.
    private func celestialCoordinate(_ pos: CelestialPosition, observerLat: Double, observerLon: Double) -> (latitude: Double, longitude: Double)? {
        guard pos.altitude > 0 else { return nil }
        let angularDist = (90.0 - pos.altitude) / 90.0 * 25.0
        let azRad = pos.azimuth * .pi / 180
        let distRad = angularDist * .pi / 180
        let latRad = observerLat * .pi / 180
        let lonRad = observerLon * .pi / 180

        let lat = asin(sin(latRad) * cos(distRad) + cos(latRad) * sin(distRad) * cos(azRad))
        let lon = lonRad + atan2(
            sin(azRad) * sin(distRad) * cos(latRad),
            cos(distRad) - sin(latRad) * sin(lat)
        )
        return (lat * 180 / .pi, lon * 180 / .pi)
    }
}

// MARK: - Bundle resource scheme handler

/// Serves files under `Bundle.module`'s `Globe/` directory via a custom URL
/// scheme so the WKWebView can load them with a real HTTP-style response.
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

        let globeDir = Bundle.module.bundleURL
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
