import SwiftUI
import AppKit

// MARK: - Model

enum SatConstellation: String, CaseIterable, Hashable, Codable {
    case gps = "GPS"
    case glonass = "GLONASS"
    case galileo = "Galileo"
    case beidou = "BeiDou"

    /// Apple-system palette for constellation-coloured rendering. Kept as
    /// raw 0–255 RGB so the same channels drive SwiftUI `Color`, globe.gl
    /// hex, and pre-formatted `rgba(...)` strings without palette drift.
    var rgb255: (r: Int, g: Int, b: Int) {
        switch self {
        case .gps:     return (0, 122, 255)    // Apple blue
        case .glonass: return (255, 59, 48)    // Apple red
        case .galileo: return (255, 149, 0)    // Apple orange
        case .beidou:  return (90, 200, 250)   // Apple light blue
        }
    }

    /// SwiftUI `Color` — polar plot, map overlays, legends, signal bars.
    var color: Color {
        let (r, g, b) = rgb255
        return Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
    }

    /// Hex string — globe.gl HTML dot `color` field.
    var hex: String {
        let (r, g, b) = rgb255
        return String(format: "#%02x%02x%02x", r, g, b)
    }

    /// Pre-formatted `rgba(...)` with baked alpha — globe.gl `pathColor`
    /// and translucent dot `fill` colours.
    func rgba(alpha: Double) -> String {
        let (r, g, b) = rgb255
        let a = max(0, min(1, alpha))
        return String(format: "rgba(%d,%d,%d,%.3f)", r, g, b, a)
    }

    var prefix: String {
        switch self {
        case .gps:     return "G"
        case .glonass: return "R"
        case .galileo: return "E"
        case .beidou:  return "C"
        }
    }

    init?(talkerId: String) {
        switch talkerId {
        case "$GP": self = .gps
        case "$GL": self = .glonass
        case "$GA": self = .galileo
        case "$GB", "$BD": self = .beidou
        default: return nil
        }
    }
}

struct SatelliteInfo: Identifiable, Equatable {
    var id: String { "\(constellation.prefix)\(prn)" }
    let prn: Int
    let constellation: SatConstellation
    let elevation: Int
    let azimuth: Int
    let snr: Int?
}

// MARK: - SNR colour helpers

/// SNR-to-colour helpers used by the signal bars and (indirectly) by legends.
/// The bitmap heatmap was replaced by per-pass arc rendering; see SkyPlotCanvas.
enum SkyTrail {
    /// SNR to RGB: red (weak) -> yellow -> green -> cyan (strong).
    static func snrRGB(_ snr: Int) -> (CGFloat, CGFloat, CGFloat) {
        let t = min(Double(snr) / 50.0, 1.0)
        if t < 0.4 { return (1.0, CGFloat(t / 0.4), 0.0) }
        if t < 0.7 { return (CGFloat(1.0 - (t - 0.4) / 0.3), 1.0, 0.0) }
        return (0.0, 1.0, CGFloat((t - 0.7) / 0.3))
    }

    static func snrColor(_ snr: Int?) -> Color {
        guard let s = snr, s > 0 else { return .gray.opacity(0.3) }
        let (r, g, b) = snrRGB(s)
        return Color(red: Double(r), green: Double(g), blue: Double(b))
    }
}

// MARK: - View Mode

enum SkyViewMode: String, CaseIterable {
    case polar = "Polar"
    case map = "Map"
    case globe = "Globe"
}

// MARK: - Sky View

struct SkyView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var trailStore: SkyTrailStore
    @EnvironmentObject var settings: AppSettings
    @State private var now = Date()
    @State private var showClearConfirm = false
    @State private var showInsights = false
    // Owned here so it survives this view's frequent re-creation; passed down
    // to all three renderers so a closed pass's geometry is computed once
    // rather than re-smoothed/re-projected on every 1 Hz tick.
    @StateObject private var geometryCache = PassGeometryCache()
    // Pauses the per-second view refresh when the app isn't frontmost.
    // Recording continues in the background via the AppDelegate sink
    // regardless; this only stops the *rendering* churn that, at full
    // resolution, could pin the main thread during a background layout cascade.
    @Environment(\.scenePhase) private var scenePhase

    // Sky-view toggles live in `AppSettings` so they persist across relaunch.
    // The view exposes them through lightweight computed `Binding`s below —
    // enum values (`SkyViewMode`, `TimeWindow`) are stored as raw strings
    // because `@AppStorage` doesn't support them natively and `AppSettings`
    // is already the single source for UserDefaults-backed state.
    private var viewModeBinding: Binding<SkyViewMode> {
        Binding(
            get: { SkyViewMode(rawValue: settings.skyViewMode) ?? .polar },
            set: { settings.skyViewMode = $0.rawValue }
        )
    }
    private var timeWindowBinding: Binding<TimeWindow> {
        Binding(
            get: { TimeWindow(rawValue: settings.skyTimeWindow) ?? .h1 },
            set: { settings.skyTimeWindow = $0.rawValue }
        )
    }
    private var viewMode: SkyViewMode {
        SkyViewMode(rawValue: settings.skyViewMode) ?? .polar
    }
    private var timeWindow: TimeWindow {
        TimeWindow(rawValue: settings.skyTimeWindow) ?? .h1
    }

    /// Drives the comet-head pulse and age-fade refresh.
    private let celestialTimer = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    private let liveTimer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var visiblePasses: [SatPass] {
        trailStore.filtered(by: timeWindow, now: now)
    }

    private var sunPos: CelestialPosition? {
        guard let lat = serialManager.gpsLatitude, let lon = serialManager.gpsLongitude else { return nil }
        return Astronomy.sunPosition(date: now, latitude: lat, longitude: lon)
    }

    private var moonPos: CelestialPosition? {
        guard let lat = serialManager.gpsLatitude, let lon = serialManager.gpsLongitude else { return nil }
        return Astronomy.moonPosition(date: now, latitude: lat, longitude: lon)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Trail recording controls
            HStack(spacing: 8) {
                Button {
                    trailStore.isLogging.toggle()
                } label: {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(trailStore.isLogging ? .red : .red.opacity(0.4))
                            .frame(width: 8, height: 8)
                        Text(trailStore.isLogging ? "Stop Recording" : "Record")
                            .font(.caption)
                            .fontWeight(trailStore.isLogging ? .semibold : .regular)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        RoundedRectangle(cornerRadius: 5)
                            .fill(trailStore.isLogging ? .red.opacity(0.1) : .secondary.opacity(0.08))
                    )
                }
                .buttonStyle(.borderless)
                .help(trailStore.isLogging
                      ? "Stop recording satellite positions"
                      : "Record satellite positions for heatmaps")

                if !trailStore.allPasses.isEmpty {
                    Button {
                        showClearConfirm = true
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "trash")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text("Clear")
                                .font(.caption)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            RoundedRectangle(cornerRadius: 5)
                                .fill(.secondary.opacity(0.08))
                        )
                    }
                    .buttonStyle(.borderless)
                    .help("Delete all recorded satellite passes")
                    .confirmationDialog(
                        "Clear all recorded satellite passes?",
                        isPresented: $showClearConfirm,
                        titleVisibility: .visible
                    ) {
                        Button("Clear All Passes", role: .destructive) {
                            trailStore.clear()
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("This permanently deletes every recorded pass and cannot be undone.")
                    }

                    if let dur = trailStore.durationSummary {
                        Text(dur)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text(trailStore.dataSummary)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                Spacer()

                // Insights button — analytical companion to the recording
                // controls. Dimmed when there's nothing to analyse (no passes
                // on disk); opens a sheet with three trail-grounded modes.
                Button {
                    showInsights = true
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "sparkles")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                        Text("Insights")
                            .font(.caption)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        RoundedRectangle(cornerRadius: 5)
                            .fill(.orange.opacity(0.08))
                    )
                }
                .buttonStyle(.borderless)
                .disabled(trailStore.allPasses.isEmpty)
                .help(trailStore.allPasses.isEmpty
                      ? "Record satellite passes first to enable analysis"
                      : "Analyse recorded passes with on-device AI")
            }
            .padding(.horizontal)
            .padding(.top, 8)

            HStack(spacing: 8) {
                Picker("View", selection: viewModeBinding) {
                    ForEach(SkyViewMode.allCases, id: \.self) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                TimeWindowMenu(selection: timeWindowBinding)

                RetentionMenu(trailStore: trailStore)
            }
            .padding(.horizontal)
            .padding(.top, 4)

            if viewMode == .polar {
                if serialManager.satellites.isEmpty && trailStore.allPasses.isEmpty {
                    emptyStateView
                } else {
                    SkyPlotCanvas(
                        geometryCache: geometryCache,
                        satellites: settings.skyShowSatellites ? serialManager.satellites : [],
                        passes: visiblePasses,
                        activePRNs: trailStore.activePRNs,
                        // Pass nil when celestials are toggled off — the
                        // canvas already bails out on nil so this is the
                        // cheapest way to suppress them.
                        sunPosition: settings.skyShowCelestials ? sunPos : nil,
                        moonPosition: settings.skyShowCelestials ? moonPos : nil,
                        moonPhase: Astronomy.moonPhase(date: now),
                        // Horizon mask is currently locked-out (feature
                        // hidden) — the sector heatmap below covers the
                        // same information in 2D with SNR colouring. The
                        // toggle, setting, store-side computation, and
                        // drawHorizonMask canvas method are all still in
                        // place; to re-enable, restore the toggle in the
                        // overlay HStack and swap this back to:
                        //     settings.skyShowHorizonMask
                        //         ? trailStore.horizonMask
                        //         : Array(repeating: nil, count: 72)
                        horizonMask: Array(repeating: nil, count: 72),
                        // Same trick for the sector heatmap: empty grid ⇒
                        // canvas draws nothing, no extra flag needed.
                        sectorHeatmap: settings.skyShowSectorHeatmap
                            ? trailStore.sectorHeatmap
                            : Array(repeating: Array(repeating: nil, count: 18), count: 72),
                        timeWindow: timeWindow,
                        now: now,
                        showLabels: settings.skyShowLabels
                    )
                    .aspectRatio(1, contentMode: .fit)
                    .padding(.horizontal)
                    .padding(.top, 4)
                    .overlay(alignment: .topTrailing) {
                        HStack(spacing: 2) {
                            polarToggle("scope", isOn: $settings.skyShowSatellites, tip: "Satellites")
                            polarToggle("sun.and.horizon", isOn: $settings.skyShowCelestials, tip: "Sun & Moon")
                            polarToggle("tag", isOn: $settings.skyShowLabels, tip: "Labels")
                            polarToggle("square.grid.3x3.fill", isOn: $settings.skyShowSectorHeatmap,
                                        tip: "Sector heatmap (peak SNR per 5° sky cell)")
                            // Horizon-mask toggle intentionally hidden — the
                            // sector heatmap supersedes it. Re-add here if
                            // the mask is brought back:
                            //   polarToggle("mountain.2", isOn: $settings.skyShowHorizonMask,
                            //               tip: "Horizon mask (lowest elevation seen per sector)")
                        }
                        .padding(4)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 6))
                        .padding(8)
                    }
                }
            } else if viewMode == .map {
                SkyMapView(
                    geometryCache: geometryCache,
                    satellites: settings.skyShowSatellites ? serialManager.satellites : [],
                    sunPosition: settings.skyShowCelestials ? sunPos : nil,
                    moonPosition: settings.skyShowCelestials ? moonPos : nil,
                    userLatitude: serialManager.gpsLatitude,
                    userLongitude: serialManager.gpsLongitude,
                    showLabels: settings.skyShowLabels,
                    passes: visiblePasses,
                    activePRNs: trailStore.activePRNs,
                    now: now,
                    smoothTrails: settings.skySmoothTrails,
                    toggles: AnyView(
                        HStack(spacing: 2) {
                            polarToggle("scope", isOn: $settings.skyShowSatellites, tip: "Satellites")
                            polarToggle("sun.and.horizon", isOn: $settings.skyShowCelestials, tip: "Sun & Moon")
                            polarToggle("tag", isOn: $settings.skyShowLabels, tip: "Labels")
                            polarToggle("waveform.path", isOn: $settings.skySmoothTrails,
                                        tip: "Smooth trails (average NMEA jitter)")
                        }
                        .padding(4)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 6))
                    )
                )
                .frame(minHeight: 300)
                .padding(.horizontal)
                .padding(.top, 4)
            } else {
                SkyGlobeView(
                    geometryCache: geometryCache,
                    satellites: serialManager.satellites,
                    sunPosition: sunPos,
                    moonPosition: moonPos,
                    userLatitude: serialManager.gpsLatitude,
                    userLongitude: serialManager.gpsLongitude,
                    passes: visiblePasses,
                    activePRNs: trailStore.activePRNs,
                    now: now,
                    smoothTrails: settings.skySmoothTrails
                )
                .frame(minHeight: 350)
                .padding(.horizontal)
                .padding(.top, 4)
            }

            // Signal strength bars
            SignalBars(satellites: serialManager.satellites)
                .frame(height: 90)
                .padding(.horizontal)
                .padding(.top, 4)

            // GPS info panel
            if serialManager.gpsFix > 0 {
                GPSInfoPanel(serialManager: serialManager, now: now)
                    .padding(.horizontal)
                    .padding(.top, 4)
            }

            Spacer(minLength: 0)

            // Footer
            GroupBox {
                HStack {
                    if !serialManager.satellites.isEmpty {
                        let tracked = serialManager.satellites.filter { ($0.snr ?? 0) > 0 }
                        if tracked.isEmpty {
                            Text("\(serialManager.satellites.count) in view, acquiring\u{2026}")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("\(tracked.count) tracked, \(serialManager.satellites.count) in view")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if sunPos != nil {
                        HStack(spacing: 3) {
                            Circle().fill(.yellow).frame(width: 6, height: 6)
                            Text("Sun").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    if moonPos != nil {
                        HStack(spacing: 3) {
                            Circle().fill(.gray).frame(width: 6, height: 6)
                            Text("Moon").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(constellationsPresent, id: \.self) { c in
                        HStack(spacing: 3) {
                            Circle().fill(c.color).frame(width: 6, height: 6)
                            Text(c.rawValue).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(2)
            }
            .padding(.horizontal)
            .padding(.bottom, 8)
        }
        .onReceive(celestialTimer) { if scenePhase == .active { now = $0 } }
        .onReceive(liveTimer) { _ in
            // Refresh `now` every second while any satellite is being tracked —
            // but only while frontmost. Backgrounded, this would drive the
            // full-resolution redraw every second behind the user's back (a
            // contributor to the background hang); it resumes on refocus.
            guard scenePhase == .active, !trailStore.activePRNs.isEmpty else { return }
            now = Date()
        }
        // NOTE: satellite ingestion lives in AppDelegate's window-independent
        // Combine sink (so recording survives window close — issue #9). It is
        // deliberately NOT wired here too; doing both ran update() twice per
        // tick while this pane was open, double-counting and doubling the
        // store's objectWillChange churn.
        .onAppear {
            now = Date()
            serialManager.requestSatelliteTracking()
            serialManager.requestNMEA(consumer: "Sky View")
        }
        .onDisappear {
            serialManager.releaseSatelliteTracking()
            serialManager.releaseNMEA(consumer: "Sky View")
        }
        .sheet(isPresented: $showInsights) {
            GPSInsightsView()
                .environmentObject(serialManager)
                .environmentObject(trailStore)
        }
    }

    private func polarToggle(_ icon: String, isOn: Binding<Bool>, tip: String) -> some View {
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

    private var emptyStateView: some View {
        VStack(spacing: 12) {
            Image(systemName: "scope")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text(serialManager.isConnected
                 ? "Waiting for satellite data\u{2026}"
                 : "Connect to clock to view satellites")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var constellationsPresent: [SatConstellation] {
        let unique = Set(serialManager.satellites.map(\.constellation))
        return SatConstellation.allCases.filter { unique.contains($0) }
    }

    private func durationLabel(since start: Date) -> String {
        let s = Int(Date().timeIntervalSince(start))
        if s < 60 { return "Recording\u{2026}" }
        let h = s / 3600
        let m = (s % 3600) / 60
        if h > 0 { return "Recording for \(h)h \(m)m" }
        return "Recording for \(m)m"
    }
}

// MARK: - Polar Plot Canvas

private struct SkyPlotCanvas: View {
    let geometryCache: PassGeometryCache
    let satellites: [SatelliteInfo]
    let passes: [SatPass]
    let activePRNs: Set<String>
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    let moonPhase: Double
    let horizonMask: [Double?]
    /// 72 az × 18 el grid of peak SNR per 5°×5° sky cell, nil when unseen.
    let sectorHeatmap: [[Int?]]
    /// The active recency filter. Folded into `contentVersion` so changing the
    /// window forces the static layer to redraw even in the rare case where the
    /// new window's closed-pass count/observation totals coincide with the old.
    let timeWindow: TimeWindow
    let now: Date
    var showLabels: Bool = true

    // The polar plot draws on the window background, which flips with the
    // system appearance. The heatmap colormap and trail-fade alphas were both
    // tuned against a dark/space backdrop, so the draw helpers read this to
    // lift them into a legible band on a white background (see drawTrails and
    // snrHeatColor). Threaded into both child layers so their shared draw
    // helpers can branch on it.
    @Environment(\.colorScheme) private var colorScheme
    // When the app isn't frontmost, skip the expensive heatmap/trail/glow
    // strokes — at full resolution, re-stroking the whole history on every
    // store mutation during a background layout cascade is what wedged the
    // UI. Grid + live satellites stay; the trails return on refocus.
    @Environment(\.scenePhase) private var scenePhase

    /// Closed passes (not currently recording). Their geometry is immutable, so
    /// they belong in the cached static layer; only the age-fade changes, and
    /// that is bucketed to once a minute below.
    private var closedPasses: [SatPass] {
        passes.filter { !activePRNs.contains($0.prn) }
    }
    /// Live passes (currently recording). These grow every tick, carry the
    /// comet head, and so are drawn fresh each second by the live layer.
    private var livePasses: [SatPass] {
        passes.filter { activePRNs.contains($0.prn) }
    }

    /// `now` snapped down to the start of the current minute. The static
    /// layer's closed-pass age-fade is computed against this instead of the
    /// live `now`, so the fade only steps once a MINUTE — imperceptible, and it
    /// keeps `contentVersion` (which folds in the same bucket) stable between
    /// minute boundaries so the cached layer isn't redrawn on every 1 Hz tick.
    private var staticNow: Date {
        Date(timeIntervalSince1970: (now.timeIntervalSince1970 / 60).rounded(.down) * 60)
    }

    /// Cheap change-detector for the static layer. It folds in everything that
    /// can alter the cached pixels — how many closed passes there are, their
    /// combined observation counts (so a pass closing or a window re-trim is
    /// caught), the active set, the appearance, and a once-a-minute age bucket
    /// for the fade — WITHOUT touching the heavy `passes`/`sectorHeatmap`
    /// arrays element-by-element. `StaticPolarLayer`'s custom `==` compares
    /// only this Int, so when the parent body re-runs every second SwiftUI sees
    /// an unchanged version and skips re-stroking the whole history.
    private var staticContentVersion: Int {
        let closed = closedPasses
        var hasher = Hasher()
        hasher.combine(closed.count)
        hasher.combine(closed.reduce(0) { $0 + $1.observations.count })
        // The active set decides which passes are closed-vs-live; a change here
        // moves a pass between layers, which the counts above may not reflect.
        hasher.combine(activePRNs)
        // The recency filter: a new window can change which closed passes show.
        hasher.combine(timeWindow)
        // Minute bucket: refreshes the age-fade of closed trails once a minute.
        // This is the ONLY term that ticks on its own (every 60 s); the rest
        // change only on real data/UI events, so between minute boundaries the
        // version is stable and the cached layer is skipped on every 1 Hz tick.
        hasher.combine(Int(now.timeIntervalSince1970 / 60))
        hasher.combine(colorScheme)
        // Heatmap is part of the static layer but the full grid is too heavy to
        // hash every frame; fold a cheap fingerprint (filled-cell count + a
        // coarse SNR sum) so a heatmap update still bumps the version.
        hasher.combine(heatmapFingerprint)
        return hasher.finalize()
    }

    /// Coarse fingerprint of the sector heatmap: count of filled cells plus the
    /// sum of their SNRs. Cheap relative to a deep hash and changes whenever the
    /// field is repainted (new cell observed or a peak SNR rises).
    private var heatmapFingerprint: Int {
        var filled = 0
        var snrSum = 0
        for row in sectorHeatmap {
            for cell in row {
                if let v = cell { filled += 1; snrSum += v }
            }
        }
        return filled &* 31 &+ snrSum
    }

    var body: some View {
        // Both layers share one coordinate space: each computes `center`/`maxR`
        // from the same `size`, and they overlay in a ZStack at the same frame,
        // so the cheap live layer registers exactly on top of the cached one.
        ZStack {
            StaticPolarLayer(
                geometryCache: geometryCache,
                closedPasses: closedPasses,
                horizonMask: horizonMask,
                sectorHeatmap: sectorHeatmap,
                staticNow: staticNow,
                colorScheme: colorScheme,
                active: scenePhase == .active,
                contentVersion: staticContentVersion
            )
            .equatable()

            LivePolarLayer(
                geometryCache: geometryCache,
                satellites: satellites,
                livePasses: livePasses,
                sunPosition: sunPosition,
                moonPosition: moonPosition,
                moonPhase: moonPhase,
                now: now,
                showLabels: showLabels,
                colorScheme: colorScheme,
                active: scenePhase == .active
            )
        }
    }
}

// MARK: - Polar drawing primitives (shared by both layers)

/// Project a smoothed az/el sample (in degrees) onto the polar canvas.
/// Azimuth 0° is up (north); elevation 90° is the centre. Kept in double
/// precision because the segmented track returns smoothed, non-integer
/// az/el — rounding to `Int` here would re-introduce the 1° staircase the
/// smoothing pass exists to remove.
///
/// Free function (not a method) so the static and live layers — which both
/// stroke trails — call the same projection without inheriting each other's
/// state. Both layers derive `center`/`maxR` identically, so points land in
/// the same place in either layer.
private func polarPosition(azDeg: Double, elDeg: Double, center: CGPoint, maxR: CGFloat) -> CGPoint {
    let r = (90.0 - elDeg) / 90.0 * Double(maxR)
    let rad = azDeg * .pi / 180.0
    return CGPoint(x: center.x + CGFloat(r * sin(rad)),
                   y: center.y - CGFloat(r * cos(rad)))
}

/// Stroke one pass's smoothed, segmented az/el track. Shared verbatim between
/// the static (closed passes) and live layers so the look — colour, age-fade
/// remap, per-segment polylines, stroke taper — is identical regardless of
/// which layer draws it. `now` is the live clock for live passes and the
/// minute-bucketed clock for closed ones, which is the only difference between
/// the two callers. Returns the freshest point on the smoothed curve (last
/// point of the last segment) so a live caller can place the comet head there.
@discardableResult
@MainActor
private func drawPassTrail(_ pass: SatPass, isLive: Bool,
                           context: inout GraphicsContext,
                           center: CGPoint, maxR: CGFloat,
                           now: Date, colorScheme: ColorScheme,
                           geometryCache: PassGeometryCache) -> (az: Double, el: Double)? {
    let age = now.timeIntervalSince(pass.endTime)

    // Age tier drives BOTH the per-pass point budget (older passes are
    // decimated harder to bound frame time as history accumulates —
    // issue #7) and the fade/taper styling, so opacity, stroke, and
    // the sample count all come from one source of truth.
    let tier = PassAgeTier.tier(endAge: age, isLive: isLive)

    // Segmented az/el track: the smoothing pipeline splits the pass at
    // recording gaps and decimates each run to its share of the tier
    // budget. Each segment must be stroked as its OWN polyline — joining
    // them with `addLine` across a gap is exactly what fabricated the
    // "spiral" chord through unobserved sky (issue #8).
    let segments = geometryCache.polarSegments(for: pass, maxPoints: tier.maxPoints,
                                               smoothingWindow: 0)
    guard !segments.isEmpty else { return nil }

    // `PassAgeTier.opacity` is tuned for a dark backdrop (floor ~0.06,
    // live ~0.75). On a WHITE light-mode background those low alphas
    // wash out, so older tracks vanish entirely. Remap locally into a
    // higher, light-legible band — lifting the floor so week-old arcs
    // stay readable while still compressing toward a strong top end —
    // rather than editing the shared tier (each renderer's background
    // differs). Dark mode keeps the original curve untouched.
    let rawAlpha = PassAgeTier.opacity(endAge: age, isLive: isLive)
    let alpha: Double
    if colorScheme == .light {
        // Source span runs ~0.06 (7 d floor) → ~0.81 (live). Normalise
        // across it, then expand into ~0.38…~0.9 so the dimmest arc is
        // still clearly visible on white and the freshest stays strong.
        let lo = 0.06, hi = 0.81
        let t = min(1.0, max(0.0, (rawAlpha - lo) / (hi - lo)))
        alpha = 0.38 + (0.90 - 0.38) * t
    } else {
        alpha = rawAlpha
    }
    let stroke = PassAgeTier.strokeWidth(endAge: age, isLive: isLive)
    let baseColor = pass.constellation.color.opacity(alpha)

    for segment in segments {
        guard segment.count >= 2 else { continue }
        var path = Path()
        for (i, p) in segment.enumerated() {
            let pt = polarPosition(azDeg: p.az, elDeg: p.el, center: center, maxR: maxR)
            if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
        }
        context.stroke(path, with: .color(baseColor),
                       style: StrokeStyle(lineWidth: stroke, lineCap: .round, lineJoin: .round))
    }

    return segments.last?.last
}

// MARK: - Static Polar Layer

/// The cached, slow-changing half of the polar plot: the sector heatmap, the
/// horizon mask, the grid, and the CLOSED-pass trails (whose geometry is
/// immutable). It is wrapped in `.equatable()` by the parent and its custom
/// `==` compares ONLY `contentVersion`, so when the parent body re-evaluates
/// every second (the live `now` tick), SwiftUI finds this view value-equal and
/// SKIPS re-running its `Canvas` closure entirely. The heavy `closedPasses` /
/// `sectorHeatmap` arrays are still passed in for drawing — they're simply
/// excluded from the equality check, which is what makes the skip safe and
/// cheap. Result: the full-resolution history is stroked only when it actually
/// changes (a pass closes, the window changes, the heatmap repaints, the
/// appearance flips, or ~once a minute for the age-fade), not on every tick.
private struct StaticPolarLayer: View, Equatable {
    let geometryCache: PassGeometryCache
    let closedPasses: [SatPass]
    let horizonMask: [Double?]
    let sectorHeatmap: [[Int?]]
    /// `now` bucketed to the minute (see `SkyPlotCanvas.staticNow`) — drives
    /// the closed-pass age-fade at a once-a-minute cadence.
    let staticNow: Date
    let colorScheme: ColorScheme
    /// Whether the app is frontmost; mirrors the parent's `scenePhase` gate so
    /// the heavy heatmap/trail strokes are skipped while backgrounded.
    let active: Bool
    /// The ONLY field `==` compares. Everything that can change the cached
    /// pixels is folded into this Int by the parent.
    let contentVersion: Int

    /// Custom equality is the crux of the whole refactor: by comparing only the
    /// cheap `contentVersion` and deliberately ignoring the heavy arrays
    /// (`closedPasses`, `sectorHeatmap`, `horizonMask`), an unchanged version
    /// makes SwiftUI treat the layer as unchanged and skip the Canvas redraw.
    static func == (lhs: StaticPolarLayer, rhs: StaticPolarLayer) -> Bool {
        lhs.contentVersion == rhs.contentVersion
    }

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let maxR = min(size.width, size.height) / 2 - 24
            guard maxR > 10 else { return }

            // Heavy layers (full-resolution trail strokes + the blurred heatmap
            // field) draw only when frontmost — see the `active` note above.
            // Heatmap goes below everything so the grid lines and trails sit on
            // top of the coloured cells.
            if active {
                drawSectorHeatmap(context: &context, center: center, maxR: maxR)
            }
            drawHorizonMask(context: &context, center: center, maxR: maxR)
            drawGrid(context: &context, center: center, maxR: maxR)
            if active {
                drawClosedTrails(context: &context, center: center, maxR: maxR)
            }
        }
    }

    // MARK: - Trails

    private func drawClosedTrails(context: inout GraphicsContext, center: CGPoint, maxR: CGFloat) {
        // Draw oldest first so fresher passes layer on top. Closed passes carry
        // no comet head (that's a live-only marker), so the shared helper's
        // returned head point is ignored here.
        let ordered = closedPasses.sorted { $0.endTime < $1.endTime }
        for pass in ordered {
            drawPassTrail(pass, isLive: false, context: &context,
                          center: center, maxR: maxR,
                          now: staticNow, colorScheme: colorScheme,
                          geometryCache: geometryCache)
        }
    }

    // MARK: - Horizon Mask

    private func drawHorizonMask(context: inout GraphicsContext, center: CGPoint, maxR: CGFloat) {
        let filledCount = horizonMask.compactMap({ $0 }).count
        guard filledCount >= 6 else { return }

        let sectorWidth = 360.0 / Double(horizonMask.count)

        // Filled region: from mask elevation to horizon (outer edge)
        // Missing sectors default to 0 (no obstruction = no shading)
        var path = Path()

        // Outer circle clockwise
        for i in 0...horizonMask.count {
            let angle = Double(i % horizonMask.count) * sectorWidth * .pi / 180
            let pt = CGPoint(x: center.x + maxR * sin(angle), y: center.y - maxR * cos(angle))
            if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
        }

        // Inner line counter-clockwise at mask elevation
        for i in stride(from: horizonMask.count - 1, through: 0, by: -1) {
            let elev = horizonMask[i] ?? 0
            let r = (90.0 - elev) / 90.0 * Double(maxR)
            let angle = Double(i) * sectorWidth * .pi / 180
            path.addLine(to: CGPoint(x: center.x + r * sin(angle), y: center.y - r * cos(angle)))
        }
        path.closeSubpath()

        context.fill(path, with: .color(.red.opacity(0.05)))

        // Mask line through sectors with data
        var maskLine = Path()
        var lineStarted = false
        for i in 0...horizonMask.count {
            let idx = i % horizonMask.count
            guard let elev = horizonMask[idx], elev > 2 else {
                lineStarted = false
                continue
            }
            let r = (90.0 - elev) / 90.0 * Double(maxR)
            let angle = Double(idx) * sectorWidth * .pi / 180
            let pt = CGPoint(x: center.x + r * sin(angle), y: center.y - r * cos(angle))
            if !lineStarted {
                maskLine.move(to: pt)
                lineStarted = true
            } else {
                maskLine.addLine(to: pt)
            }
        }
        context.stroke(maskLine, with: .color(.red.opacity(0.25)), lineWidth: 0.75)
    }

    // MARK: - Sector Heatmap

    /// u-center-style sky-view: each observed 5°×5° sky cell is painted as a
    /// wedge coloured by peak SNR. Empty cells render nothing, so the
    /// transparent background fades smoothly between cardinal directions.
    private func drawSectorHeatmap(context: inout GraphicsContext, center: CGPoint, maxR: CGFloat) {
        // Cheap early-out: don't touch the canvas at all if there's no data.
        let hasAny = sectorHeatmap.contains { row in row.contains { $0 != nil } }
        guard hasAny else { return }

        let azBins = sectorHeatmap.count         // 72
        let elBins = sectorHeatmap.first?.count ?? 0    // 18
        guard azBins == 72, elBins == 18 else { return }

        let sectorWidthDeg = 360.0 / Double(azBins)       // 5°
        let elStepDeg = 90.0 / Double(elBins)             // 5°

        // Render the whole field into one layer so we can (1) hold its overall
        // weight well below the trails — the heatmap is context, the arcs are
        // the subject — and (2) blur the layer as a unit. The blur is the main
        // softening lever: it dissolves the hard cell-to-cell seams that made
        // the field read as chunky tiles into a smooth gradient, while a small
        // per-wedge overlap (below) stops faint hairline gaps appearing between
        // neighbours once blurred.
        context.drawLayer { layer in
            layer.addFilter(.blur(radius: 3))
            layer.opacity = (colorScheme == .light) ? 0.85 : 0.6

            for azBin in 0..<azBins {
                for elBin in 0..<elBins {
                    guard let snr = sectorHeatmap[azBin][elBin] else { continue }

                    // Elevation → radius: 0° at outer edge, 90° at center.
                    // Overlap neighbours by half a step on each side so the
                    // blurred wedges blend instead of leaving seams between
                    // adjacent cells.
                    let elLo = Double(elBin) * elStepDeg
                    let elHi = elLo + elStepDeg
                    let rOuter = (90.0 - elLo) / 90.0 * Double(maxR) + 1.0
                    let rInner = max(0, (90.0 - elHi) / 90.0 * Double(maxR) - 1.0)

                    // Azimuth → angle: 0° north, clockwise. Widen each wedge by
                    // a fraction of a sector on both sides for the same reason.
                    let azPad = sectorWidthDeg * 0.18 * .pi / 180.0
                    let azStart = Double(azBin) * sectorWidthDeg * .pi / 180.0 - azPad
                    let azEnd = (Double(azBin) + 1) * sectorWidthDeg * .pi / 180.0 + azPad

                    // Build wedge: outer arc clockwise, then inner arc counter-
                    // clockwise. Sampled at intermediate angles because the
                    // radial lines alone make a straight chord that looks jagged
                    // at the outer edge.
                    var path = Path()
                    let steps = 4
                    for i in 0...steps {
                        let t = Double(i) / Double(steps)
                        let a = azStart + (azEnd - azStart) * t
                        let pt = CGPoint(
                            x: center.x + CGFloat(rOuter * sin(a)),
                            y: center.y - CGFloat(rOuter * cos(a))
                        )
                        if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
                    }
                    for i in stride(from: steps, through: 0, by: -1) {
                        let t = Double(i) / Double(steps)
                        let a = azStart + (azEnd - azStart) * t
                        let pt = CGPoint(
                            x: center.x + CGFloat(rInner * sin(a)),
                            y: center.y - CGFloat(rInner * cos(a))
                        )
                        path.addLine(to: pt)
                    }
                    path.closeSubpath()

                    layer.fill(path, with: .color(snrHeatColor(snr: snr)))
                }
            }
        }
    }

    /// SNR → heatmap colour, with a ramp per appearance because the polar plot
    /// sits on the window background and the same colours can't read on both.
    ///
    /// Dark mode keeps the original u-center-style ramp: navy → purple → warm
    /// red, which only separates from a near-black backdrop. On a WHITE
    /// background that low end is invisible (dark purple on white reads as a
    /// flat smudge and the low alpha makes it vanish), so light mode uses a
    /// distinct ramp of mid-saturation colours — teal → amber → crimson — that
    /// all sit clearly darker than white, plus a higher alpha floor so even the
    /// weakest observed cell shows. Overall layer weight is held down by the
    /// caller's `drawLayer` opacity so neither ramp swamps the trails on top.
    private func snrHeatColor(snr: Int) -> Color {
        // Clamp into the 10–50 dBHz band that matters for GPS.
        let lo = 10.0, hi = 50.0
        let t = min(1.0, max(0.0, (Double(snr) - lo) / (hi - lo)))

        let r, g, b, alpha: Double
        if colorScheme == .light {
            // Teal (weak) → amber (mid) → crimson (strong). Every stop is a
            // saturated mid-tone that contrasts against white, so low SNR is
            // legible rather than a pale lavender wash. Alpha starts higher and
            // climbs so the gradient is visible across the whole range on white.
            // Cohesive cool ramp: soft blue (weak) → violet (mid) → rose
            // (strong). One harmonious hue arc rather than the previous
            // teal/amber/crimson clash, every stop clearly darker than white.
            if t < 0.5 {
                let u = t / 0.5
                r = 0.35 + (0.58 - 0.35) * u
                g = 0.55 + (0.42 - 0.55) * u
                b = 0.80 + (0.70 - 0.80) * u
            } else {
                let u = (t - 0.5) / 0.5
                r = 0.58 + (0.82 - 0.58) * u
                g = 0.42 + (0.32 - 0.42) * u
                b = 0.70 + (0.52 - 0.70) * u
            }
            alpha = 0.42 + 0.32 * t
        } else {
            // Two-stop ramp through purple: navy → purple → warm red. Values
            // picked to echo the u-center colour wheel without being a direct
            // lift. Reads only against the dark backdrop.
            if t < 0.5 {
                let u = t / 0.5
                r = 0.10 + (0.55 - 0.10) * u
                g = 0.20 + (0.10 - 0.20) * u
                b = 0.55 + (0.75 - 0.55) * u
            } else {
                let u = (t - 0.5) / 0.5
                r = 0.55 + (0.95 - 0.55) * u
                g = 0.10 + (0.25 - 0.10) * u
                b = 0.75 + (0.30 - 0.75) * u
            }
            alpha = 0.25 + 0.25 * t
        }

        return Color(red: r, green: g, blue: b, opacity: alpha)
    }

    // MARK: - Grid

    private func drawGrid(context: inout GraphicsContext, center: CGPoint, maxR: CGFloat) {
        // Elevation circles
        for elev in stride(from: 0, through: 60, by: 30) {
            let r = Double(90 - elev) / 90.0 * Double(maxR)
            let rect = CGRect(x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r)
            context.stroke(Path(ellipseIn: rect),
                           with: .color(.secondary.opacity(elev == 0 ? 0.35 : 0.15)),
                           lineWidth: elev == 0 ? 1 : 0.5)
        }

        // Direction lines
        for angle in stride(from: 0, to: 360, by: 45) {
            let rad = Double(angle) * .pi / 180.0
            let end = CGPoint(x: center.x + maxR * sin(rad), y: center.y - maxR * cos(rad))
            context.stroke(Path { p in
                p.move(to: center)
                p.addLine(to: end)
            }, with: .color(.secondary.opacity(angle % 90 == 0 ? 0.2 : 0.08)), lineWidth: 0.5)
        }

        // Cardinal labels
        let dist = maxR + 14
        for (label, angle, weight) in [
            ("N", 0.0, Font.Weight.bold), ("E", 90.0, .regular),
            ("S", 180.0, .regular), ("W", 270.0, .regular)
        ] {
            let rad = angle * .pi / 180.0
            context.draw(
                Text(label).font(.system(size: 11, weight: weight)).foregroundColor(.secondary),
                at: CGPoint(x: center.x + dist * sin(rad), y: center.y - dist * cos(rad))
            )
        }

        // Elevation labels
        for elev in [30, 60] {
            let r = Double(90 - elev) / 90.0 * Double(maxR)
            context.draw(
                Text("\(elev)\u{00B0}").font(.system(size: 8)).foregroundColor(.secondary.opacity(0.4)),
                at: CGPoint(x: center.x + 2, y: center.y - r - 7), anchor: .leading
            )
        }
    }
}

// MARK: - Live Polar Layer

/// The cheap, fast-changing half of the polar plot, drawn ON TOP of the cached
/// static layer every tick. It holds only the handful of items that genuinely
/// move with the live `now`: the LIVE-pass trails (which grow each second) and
/// their comet-head glow, the current satellite dots and their glow, and the
/// sun and moon. There is deliberately no `Equatable`/`.equatable()` here — its
/// per-frame cost is a tiny fraction of the static history, so re-running it at
/// 1 Hz is fine. It shares the exact coordinate maths (`center`/`maxR` from the
/// same `size`) with the static layer, so the two register pixel-for-pixel.
private struct LivePolarLayer: View {
    let geometryCache: PassGeometryCache
    let satellites: [SatelliteInfo]
    let livePasses: [SatPass]
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    let moonPhase: Double
    let now: Date
    var showLabels: Bool = true
    let colorScheme: ColorScheme
    /// Whether the app is frontmost; mirrors the parent's `scenePhase` gate so
    /// the live trails + glow are skipped while backgrounded (the satellite
    /// dots, sun, and moon stay, matching the original behaviour).
    let active: Bool

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let maxR = min(size.width, size.height) / 2 - 24
            guard maxR > 10 else { return }

            if active {
                drawLiveTrails(context: &context, center: center, maxR: maxR)
                drawGlowLayer(context: &context, center: center, maxR: maxR)
            }
            drawSatellites(context: &context, center: center, maxR: maxR)
            drawSun(context: &context, center: center, maxR: maxR)
            drawMoon(context: &context, center: center, maxR: maxR)
        }
    }

    // MARK: - Trails

    private func drawLiveTrails(context: inout GraphicsContext, center: CGPoint, maxR: CGFloat) {
        // Draw oldest first so fresher passes layer on top. Each live pass also
        // gets a glowing comet-head at its freshest fix — the last point of the
        // last segment (segments are time-ordered, so this is the newest sample
        // on the smoothed curve), returned by the shared trail helper.
        let ordered = livePasses.sorted { $0.endTime < $1.endTime }
        for pass in ordered {
            let head = drawPassTrail(pass, isLive: true, context: &context,
                                     center: center, maxR: maxR,
                                     now: now, colorScheme: colorScheme,
                                     geometryCache: geometryCache)
            if let last = head {
                let pt = polarPosition(azDeg: last.az, elDeg: last.el, center: center, maxR: maxR)
                let glowRect = CGRect(x: pt.x - 5, y: pt.y - 5, width: 10, height: 10)
                context.drawLayer { ctx in
                    ctx.addFilter(.blur(radius: 2.5))
                    ctx.fill(Path(ellipseIn: glowRect),
                             with: .color(pass.constellation.color.opacity(0.5)))
                }
            }
        }
    }

    // MARK: - Satellites

    private func drawGlowLayer(context: inout GraphicsContext, center: CGPoint, maxR: CGFloat) {
        context.drawLayer { glow in
            glow.addFilter(.blur(radius: 4))
            for sat in satellites {
                guard let snr = sat.snr, snr > 0 else { continue }
                let pos = polarPoint(sat, center: center, maxR: maxR)
                let glowSize: CGFloat = 10
                glow.fill(
                    Path(ellipseIn: CGRect(x: pos.x - glowSize / 2, y: pos.y - glowSize / 2,
                                           width: glowSize, height: glowSize)),
                    with: .color(sat.constellation.color.opacity(0.25))
                )
            }
        }
    }

    private func drawSatellites(context: inout GraphicsContext, center: CGPoint, maxR: CGFloat) {
        for sat in satellites {
            let pos = polarPoint(sat, center: center, maxR: maxR)
            let dotSize: CGFloat = 10
            let dotRect = CGRect(x: pos.x - dotSize / 2, y: pos.y - dotSize / 2,
                                 width: dotSize, height: dotSize)

            if let snr = sat.snr, snr > 0 {
                context.fill(Path(ellipseIn: dotRect), with: .color(sat.constellation.color))
            } else {
                context.stroke(Path(ellipseIn: dotRect),
                               with: .color(sat.constellation.color.opacity(0.35)),
                               lineWidth: 1)
            }

            // Label
            if showLabels {
                context.draw(
                    Text(sat.id).font(.system(size: 7, weight: .medium)).foregroundColor(.primary),
                    at: CGPoint(x: pos.x, y: pos.y - 9)
                )
            }
        }
    }

    // MARK: - Sun & Moon

    private func drawSun(context: inout GraphicsContext, center: CGPoint, maxR: CGFloat) {
        guard let pos = sunPosition, pos.altitude > 0 else { return }

        let r = (90.0 - pos.altitude) / 90.0 * Double(maxR)
        let rad = pos.azimuth * .pi / 180.0
        let pt = CGPoint(x: center.x + r * sin(rad), y: center.y - r * cos(rad))

        // Visual hierarchy: sun dominates, moon is a quieter body.
        // (Real angular diameters are nearly equal; we deliberately exaggerate.)
        let size: CGFloat = 16
        let rect = CGRect(x: pt.x - size / 2, y: pt.y - size / 2, width: size, height: size)

        // Glow
        context.drawLayer { glow in
            glow.addFilter(.blur(radius: 6))
            glow.fill(Path(ellipseIn: rect.insetBy(dx: -4, dy: -4)),
                      with: .color(.yellow.opacity(0.35)))
        }

        // Body
        context.fill(Path(ellipseIn: rect), with: .color(.yellow))
        context.stroke(Path(ellipseIn: rect), with: .color(.orange), lineWidth: 1)

        // Label
        context.draw(
            Text("Sun").font(.system(size: 8, weight: .medium)).foregroundColor(.orange),
            at: CGPoint(x: pt.x, y: pt.y - size / 2 - 6)
        )
    }

    private func drawMoon(context: inout GraphicsContext, center: CGPoint, maxR: CGFloat) {
        guard let pos = moonPosition, pos.altitude > 0 else { return }

        let r = (90.0 - pos.altitude) / 90.0 * Double(maxR)
        let rad = pos.azimuth * .pi / 180.0
        let pt = CGPoint(x: center.x + r * sin(rad), y: center.y - r * cos(rad))

        let size: CGFloat = 9
        let rect = CGRect(x: pt.x - size / 2, y: pt.y - size / 2, width: size, height: size)

        // Brightness based on illumination
        let illumination = (1.0 - cos(moonPhase * 2 * .pi)) / 2.0
        let brightness = 0.35 + illumination * 0.55

        // Glow
        context.drawLayer { glow in
            glow.addFilter(.blur(radius: 4))
            glow.fill(Path(ellipseIn: rect.insetBy(dx: -2, dy: -2)),
                      with: .color(.white.opacity(0.15 + illumination * 0.15)))
        }

        // Body
        context.fill(Path(ellipseIn: rect), with: .color(Color(white: brightness)))
        context.stroke(Path(ellipseIn: rect), with: .color(.white.opacity(0.5)), lineWidth: 0.75)

        // Label
        let phaseName = shortMoonPhase(moonPhase)
        context.draw(
            Text(phaseName).font(.system(size: 7, weight: .medium)).foregroundColor(.gray),
            at: CGPoint(x: pt.x, y: pt.y - size / 2 - 6)
        )
    }

    // MARK: - Helpers

    private func polarPoint(_ sat: SatelliteInfo, center: CGPoint, maxR: CGFloat) -> CGPoint {
        let r = Double(90 - sat.elevation) / 90.0 * Double(maxR)
        let rad = Double(sat.azimuth) * .pi / 180.0
        return CGPoint(x: center.x + r * sin(rad), y: center.y - r * cos(rad))
    }

    private func shortMoonPhase(_ phase: Double) -> String {
        switch phase {
        case 0..<0.05, 0.95...1: return "New"
        case 0.05..<0.2:  return "Wax Cr"
        case 0.2..<0.3:   return "1st Qtr"
        case 0.3..<0.45:  return "Wax Gib"
        case 0.45..<0.55: return "Full"
        case 0.55..<0.7:  return "Wan Gib"
        case 0.7..<0.8:   return "3rd Qtr"
        case 0.8..<0.95:  return "Wan Cr"
        default: return "Moon"
        }
    }
}

// MARK: - Time Window Menu

/// Compact menu picker for filtering pass trails by recency.
private struct TimeWindowMenu: View {
    @Binding var selection: TimeWindow

    var body: some View {
        Menu {
            ForEach(TimeWindow.allCases) { w in
                Button {
                    selection = w
                } label: {
                    if w == selection {
                        Label(w.rawValue, systemImage: "checkmark")
                    } else {
                        Text(w.rawValue)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "clock")
                    .font(.system(size: 10))
                Text(selection.rawValue)
                    .font(.caption)
                    .monospacedDigit()
                    .frame(minWidth: 26)
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Filter trails by time window (\(selection.description))")
    }
}

// MARK: - Retention Menu

/// Picker for how long recorded passes persist on disk. Selecting a window
/// shorter than the data currently stored triggers a confirmation dialog
/// that quotes the exact number of passes that would be deleted — the user
/// must explicitly opt in before old data is lost. Picking a longer window
/// (or the same one) applies silently.
private struct RetentionMenu: View {
    @ObservedObject var trailStore: SkyTrailStore
    @State private var pendingRetention: RetentionWindow?

    var body: some View {
        Menu {
            ForEach(RetentionWindow.allCases) { w in
                Button {
                    attemptSet(w)
                } label: {
                    if w == trailStore.retention {
                        Label(w.displayName, systemImage: "checkmark")
                    } else {
                        Text(w.displayName)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "externaldrive")
                    .font(.system(size: 10))
                Text(trailStore.retention.rawValue)
                    .font(.caption)
                    .monospacedDigit()
                    .frame(minWidth: 22)
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("How long to keep recorded passes on disk (currently \(trailStore.retention.displayName))")
        .confirmationDialog(
            dialogTitle,
            isPresented: Binding(
                get: { pendingRetention != nil },
                set: { if !$0 { pendingRetention = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete older passes", role: .destructive) {
                if let w = pendingRetention { trailStore.retention = w }
                pendingRetention = nil
            }
            Button("Cancel", role: .cancel) { pendingRetention = nil }
        } message: {
            if let w = pendingRetention {
                Text(warningMessage(for: w))
            }
        }
    }

    private func attemptSet(_ w: RetentionWindow) {
        guard w != trailStore.retention else { return }
        let doomed = trailStore.passesThatWouldBePruned(by: w).count
        if doomed > 0 {
            pendingRetention = w
        } else {
            trailStore.retention = w
        }
    }

    private var dialogTitle: String {
        guard let w = pendingRetention else { return "" }
        let n = trailStore.passesThatWouldBePruned(by: w).count
        return "Delete \(n) older pass\(n == 1 ? "" : "es")?"
    }

    private func warningMessage(for w: RetentionWindow) -> String {
        let n = trailStore.passesThatWouldBePruned(by: w).count
        return "Setting retention to \(w.displayName) will permanently delete \(n) pass\(n == 1 ? "" : "es") older than that window. This cannot be undone."
    }
}

// MARK: - GPS Info Panel

private struct GPSInfoPanel: View {
    @ObservedObject var serialManager: SerialManager
    let now: Date

    private var sunTimes: SunTimes? {
        guard let lat = serialManager.gpsLatitude, let lon = serialManager.gpsLongitude else { return nil }
        return Astronomy.sunTimes(date: now, latitude: lat, longitude: lon)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // Position & fix quality
            GroupBox {
                Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 2) {
                    if let lat = serialManager.gpsLatitude, let lon = serialManager.gpsLongitude {
                        GridRow {
                            infoLabel("Position")
                            Text(formatCoordinate(lat: lat, lon: lon))
                                .font(.system(.caption2, design: .monospaced))
                        }
                        GridRow {
                            infoLabel("Grid")
                            Text(Astronomy.maidenhead(latitude: lat, longitude: lon))
                                .font(.system(.caption2, design: .monospaced))
                                .textSelection(.enabled)
                        }
                    }
                    if let alt = serialManager.gpsAltitude {
                        GridRow {
                            infoLabel("Alt")
                            Text(String(format: "%.1f m", alt))
                                .font(.system(.caption2, design: .monospaced))
                        }
                    }
                    GridRow {
                        infoLabel("Fix")
                        HStack(spacing: 4) {
                            Text(fixTypeLabel(serialManager.gpsFix))
                                .font(.caption2)
                            if serialManager.gpsSatellitesUsed > 0 {
                                Text("(\(serialManager.gpsSatellitesUsed))")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    if let hdop = serialManager.gpsHDOP {
                        GridRow {
                            infoLabel("HDOP")
                            HStack(spacing: 4) {
                                Text(String(format: "%.1f", hdop))
                                    .font(.system(.caption2, design: .monospaced))
                                Text(hdopQuality(hdop))
                                    .font(.system(size: 9))
                                    .padding(.horizontal, 3)
                                    .padding(.vertical, 1)
                                    .background(hdopColor(hdop).opacity(0.15))
                                    .foregroundStyle(hdopColor(hdop))
                                    .cornerRadius(3)
                            }
                        }
                    }
                    if let firstFix = serialManager.firstFixTime {
                        GridRow {
                            infoLabel("Fix age")
                            Text(fixDuration(since: firstFix))
                                .font(.system(.caption2, design: .monospaced))
                        }
                    }
                }
            } label: {
                Label("Position", systemImage: "location.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            // Sun times
            if let times = sunTimes {
                GroupBox {
                    Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 2) {
                        if let lat = serialManager.gpsLatitude, let lon = serialManager.gpsLongitude {
                            let sunPos = Astronomy.sunPosition(date: now, latitude: lat, longitude: lon)
                            GridRow {
                                infoLabel("Alt")
                                Text(String(format: "%.1f\u{00B0}", sunPos.altitude))
                                    .font(.system(.caption2, design: .monospaced))
                            }
                        }
                        GridRow {
                            infoLabel("Rise")
                            Text(formatTime(times.sunrise))
                                .font(.system(.caption2, design: .monospaced))
                        }
                        GridRow {
                            infoLabel("Noon")
                            Text(formatTime(times.solarNoon))
                                .font(.system(.caption2, design: .monospaced))
                        }
                        GridRow {
                            infoLabel("Set")
                            Text(formatTime(times.sunset))
                                .font(.system(.caption2, design: .monospaced))
                        }
                        GridRow {
                            infoLabel("Golden")
                            Text(formatTime(times.goldenHourStart))
                                .font(.system(.caption2, design: .monospaced))
                        }
                        GridRow {
                            infoLabel("Eq.T")
                            Text(String(format: "%+.1f min", Astronomy.equationOfTime(date: now)))
                                .font(.system(.caption2, design: .monospaced))
                        }
                    }
                } label: {
                    Label("Sun", systemImage: "sun.max.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }

            // Moon
            GroupBox {
                Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 2) {
                    let phase = Astronomy.moonPhase(date: now)
                    GridRow {
                        infoLabel("Phase")
                        HStack(spacing: 3) {
                            Text(moonPhaseEmoji(phase))
                                .font(.system(size: 9))
                            Text(String(format: "%.0f%%", moonIllumination(phase) * 100))
                                .font(.caption2)
                        }
                    }
                    GridRow {
                        infoLabel("")
                        Text(moonPhaseName(phase))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let lat = serialManager.gpsLatitude, let lon = serialManager.gpsLongitude {
                        let mPos = Astronomy.moonPosition(date: now, latitude: lat, longitude: lon)
                        GridRow {
                            infoLabel("Alt")
                            Text(String(format: "%.1f\u{00B0}", mPos.altitude))
                                .font(.system(.caption2, design: .monospaced))
                        }
                        GridRow {
                            infoLabel("Az")
                            Text(String(format: "%.0f\u{00B0} %@", mPos.azimuth, compassBearing(mPos.azimuth)))
                                .font(.system(.caption2, design: .monospaced))
                        }
                    }
                }
            } label: {
                Label("Moon", systemImage: "moon.fill")
                    .font(.caption2)
                    .foregroundStyle(.gray)
            }
        }
        .padding(.bottom, 4)
    }

    // MARK: - Helpers

    private func infoLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .frame(width: 48, alignment: .trailing)
    }

    private func formatCoordinate(lat: Double, lon: Double) -> String {
        let latDir = lat >= 0 ? "N" : "S"
        let lonDir = lon >= 0 ? "E" : "W"
        return String(format: "%.5f\u{00B0}%@ %.5f\u{00B0}%@", abs(lat), latDir, abs(lon), lonDir)
    }

    private func formatTime(_ date: Date) -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss"
        fmt.timeZone = .current
        return fmt.string(from: date)
    }

    private func fixTypeLabel(_ fix: Int) -> String {
        switch fix {
        case 1: return "GPS"
        case 2: return "DGPS"
        case 4: return "RTK Fixed"
        case 5: return "RTK Float"
        default: return "Fix \(fix)"
        }
    }

    private func hdopQuality(_ hdop: Double) -> String {
        switch hdop {
        case ..<1:  return "Ideal"
        case ..<2:  return "Excellent"
        case ..<5:  return "Good"
        case ..<10: return "Moderate"
        case ..<20: return "Fair"
        default:    return "Poor"
        }
    }

    private func hdopColor(_ hdop: Double) -> Color {
        switch hdop {
        case ..<2:  return .green
        case ..<5:  return .blue
        case ..<10: return .orange
        default:    return .red
        }
    }

    private func fixDuration(since start: Date) -> String {
        let s = Int(Date().timeIntervalSince(start))
        let h = s / 3600
        let m = (s % 3600) / 60
        let sec = s % 60
        if h > 0 { return String(format: "%d:%02d:%02d", h, m, sec) }
        return String(format: "%d:%02d", m, sec)
    }

    private func moonPhaseName(_ phase: Double) -> String {
        switch phase {
        case 0..<0.05, 0.95...1: return "New Moon"
        case 0.05..<0.2:  return "Waxing Crescent"
        case 0.2..<0.3:   return "First Quarter"
        case 0.3..<0.45:  return "Waxing Gibbous"
        case 0.45..<0.55: return "Full Moon"
        case 0.55..<0.7:  return "Waning Gibbous"
        case 0.7..<0.8:   return "Last Quarter"
        case 0.8..<0.95:  return "Waning Crescent"
        default: return "Moon"
        }
    }

    private func moonPhaseEmoji(_ phase: Double) -> String {
        switch phase {
        case 0..<0.05, 0.95...1: return "\u{1F311}"
        case 0.05..<0.2:  return "\u{1F312}"
        case 0.2..<0.3:   return "\u{1F313}"
        case 0.3..<0.45:  return "\u{1F314}"
        case 0.45..<0.55: return "\u{1F315}"
        case 0.55..<0.7:  return "\u{1F316}"
        case 0.7..<0.8:   return "\u{1F317}"
        case 0.8..<0.95:  return "\u{1F318}"
        default: return "\u{1F311}"
        }
    }

    private func moonIllumination(_ phase: Double) -> Double {
        (1.0 - cos(phase * 2 * .pi)) / 2.0
    }

    private func compassBearing(_ azimuth: Double) -> String {
        let bearings = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                        "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
        let index = Int((azimuth + 11.25).truncatingRemainder(dividingBy: 360) / 22.5)
        return bearings[index % 16]
    }
}

// MARK: - Signal Strength Bars

private struct SignalBars: View {
    let satellites: [SatelliteInfo]

    private var sorted: [SatelliteInfo] {
        satellites.sorted { a, b in
            let ai = SatConstellation.allCases.firstIndex(of: a.constellation) ?? 0
            let bi = SatConstellation.allCases.firstIndex(of: b.constellation) ?? 0
            if ai != bi { return ai < bi }
            return a.prn < b.prn
        }
    }

    var body: some View {
        GeometryReader { geo in
            let count = max(sorted.count, 1)
            let spacing: CGFloat = 2
            let barWidth = max(6, min(14, (geo.size.width - spacing * CGFloat(count - 1)) / CGFloat(count)))
            let showLabels = barWidth >= 10
            HStack(alignment: .bottom, spacing: spacing) {
                ForEach(sorted) { sat in
                    VStack(spacing: 1) {
                        if showLabels, let snr = sat.snr, snr > 0 {
                            Text("\(snr)")
                                .font(.system(size: 7))
                                .foregroundStyle(.secondary)
                        }
                        RoundedRectangle(cornerRadius: 1)
                            .fill(barColor(sat))
                            .frame(width: barWidth, height: barHeight(sat))
                        if showLabels {
                            Text(sat.id)
                                .font(.system(size: 6))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
    }

    private func barHeight(_ sat: SatelliteInfo) -> CGFloat {
        guard let snr = sat.snr, snr > 0 else { return 3 }
        return max(4, CGFloat(snr) * 1.2)
    }

    private func barColor(_ sat: SatelliteInfo) -> Color {
        guard let snr = sat.snr, snr > 0 else {
            return sat.constellation.color.opacity(0.15)
        }
        return SkyTrail.snrColor(sat.snr)
    }
}
