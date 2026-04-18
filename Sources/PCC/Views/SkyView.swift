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
        .onReceive(celestialTimer) { now = $0 }
        .onReceive(liveTimer) { _ in
            // Refresh `now` every second while any satellite is being tracked
            // so the comet-head and time filter stay live without wasting work when idle.
            if !trailStore.activePRNs.isEmpty { now = Date() }
        }
        .onChange(of: serialManager.satellites) { _, sats in
            trailStore.update(satellites: sats)
        }
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
    let satellites: [SatelliteInfo]
    let passes: [SatPass]
    let activePRNs: Set<String>
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    let moonPhase: Double
    let horizonMask: [Double?]
    /// 72 az × 18 el grid of peak SNR per 5°×5° sky cell, nil when unseen.
    let sectorHeatmap: [[Int?]]
    let now: Date
    var showLabels: Bool = true

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let maxR = min(size.width, size.height) / 2 - 24
            guard maxR > 10 else { return }

            // Heatmap goes below everything so the red horizon-mask tint,
            // grid lines, and trails all sit visibly on top of the coloured
            // cells.
            drawSectorHeatmap(context: &context, center: center, maxR: maxR)
            drawHorizonMask(context: &context, center: center, maxR: maxR)
            drawGrid(context: &context, center: center, maxR: maxR)
            drawTrails(context: &context, center: center, maxR: maxR)
            drawGlowLayer(context: &context, center: center, maxR: maxR)
            drawSatellites(context: &context, center: center, maxR: maxR)
            drawSun(context: &context, center: center, maxR: maxR)
            drawMoon(context: &context, center: center, maxR: maxR)
        }
    }

    // MARK: - Trails

    private func drawTrails(context: inout GraphicsContext, center: CGPoint, maxR: CGFloat) {
        // Draw oldest first so fresh passes layer on top.
        let ordered = passes.sorted { $0.endTime < $1.endTime }
        for pass in ordered {
            let isLive = activePRNs.contains(pass.prn)
            let age = now.timeIntervalSince(pass.endTime)
            // Every real observation — previously decimated to `tier.maxPoints`
            // which produced visible beading on the stroke at today/week tiers.
            // The Canvas renderer handles even long passes fine at 6-second
            // observation cadence.
            let obs = pass.observations
            guard obs.count >= 2 else { continue }

            var path = Path()
            for (i, o) in obs.enumerated() {
                let pt = polarPoint(az: Int(o.az), el: Int(o.el), center: center, maxR: maxR)
                if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
            }
            let alpha = PassAgeTier.opacity(endAge: age, isLive: isLive)
            let stroke = PassAgeTier.strokeWidth(endAge: age, isLive: isLive)
            let baseColor = pass.constellation.color.opacity(alpha)
            context.stroke(path, with: .color(baseColor),
                           style: StrokeStyle(lineWidth: stroke, lineCap: .round, lineJoin: .round))

            // Live comet-head: a glowing dot at the current position.
            if isLive, let last = obs.last {
                let pt = polarPoint(az: Int(last.az), el: Int(last.el), center: center, maxR: maxR)
                let glowRect = CGRect(x: pt.x - 5, y: pt.y - 5, width: 10, height: 10)
                context.drawLayer { ctx in
                    ctx.addFilter(.blur(radius: 2.5))
                    ctx.fill(Path(ellipseIn: glowRect),
                             with: .color(pass.constellation.color.opacity(0.5)))
                }
            }
        }
    }

    private func polarPoint(az: Int, el: Int, center: CGPoint, maxR: CGFloat) -> CGPoint {
        let r = Double(90 - el) / 90.0 * Double(maxR)
        let rad = Double(az) * .pi / 180.0
        return CGPoint(x: center.x + CGFloat(r * sin(rad)),
                       y: center.y - CGFloat(r * cos(rad)))
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

        for azBin in 0..<azBins {
            for elBin in 0..<elBins {
                guard let snr = sectorHeatmap[azBin][elBin] else { continue }

                // Elevation → radius: 0° at outer edge, 90° at center.
                let elLo = Double(elBin) * elStepDeg
                let elHi = elLo + elStepDeg
                let rOuter = (90.0 - elLo) / 90.0 * Double(maxR)
                let rInner = (90.0 - elHi) / 90.0 * Double(maxR)

                // Azimuth → angle: 0° north, clockwise. Two radian endpoints.
                let azStart = Double(azBin) * sectorWidthDeg * .pi / 180.0
                let azEnd = (Double(azBin) + 1) * sectorWidthDeg * .pi / 180.0

                // Build wedge: outer arc clockwise, then inner arc counter-
                // clockwise. Sampled at 3 intermediate angles because the
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

                context.fill(path, with: .color(snrHeatColor(snr: snr)))
            }
        }
    }

    /// SNR → heatmap colour. Matches u-center's blue→purple→red ramp
    /// roughly: low SNR is a cool cyan/blue, mid is purple, strong signal is
    /// warm magenta/red. Opacity is capped so bright cells don't swamp the
    /// satellite dots and trails overlaid on top.
    private func snrHeatColor(snr: Int) -> Color {
        // Clamp into the 10–50 dBHz band that matters for GPS.
        let lo = 10.0, hi = 50.0
        let t = min(1.0, max(0.0, (Double(snr) - lo) / (hi - lo)))

        // Two-stop ramp through purple: navy → purple → warm red.
        // Values picked to echo the u-center colour wheel without being a
        // direct lift.
        let r, g, b: Double
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

        // Opacity ramps up a bit with SNR so weaker cells are visible but
        // strong cells really stand out.
        let alpha = 0.25 + 0.25 * t
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
