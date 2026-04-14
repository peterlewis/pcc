import SwiftUI
import AppKit

// MARK: - Model

enum SatConstellation: String, CaseIterable, Hashable {
    case gps = "GPS"
    case glonass = "GLONASS"
    case galileo = "Galileo"
    case beidou = "BeiDou"

    var color: Color {
        switch self {
        case .gps:     return .blue
        case .glonass: return .red
        case .galileo: return .orange
        case .beidou:  return .teal
        }
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

// MARK: - Trail Renderer

/// Accumulates satellite positions into a bitmap over time.
/// Each tracked satellite leaves a dot colored by signal strength,
/// building up an antenna performance heatmap over hours.
/// Also tracks a horizon mask showing the minimum elevation seen per azimuth sector.
class SkyTrail: ObservableObject {
    @Published var trailImage: CGImage?
    @Published var horizonMask: [Double?] = Array(repeating: nil, count: 72)
    var startTime: Date?
    let renderScale: CGFloat = 2

    private var ctx: CGContext?
    private var plotSize: CGSize = .zero
    private var lastSampleTime: Date = .distantPast
    private let sampleInterval: TimeInterval = 10
    private let sectorCount = 72  // 5 degrees per sector

    var maxRadius: CGFloat { min(plotSize.width, plotSize.height) / 2 - 24 }
    var center: CGPoint { CGPoint(x: plotSize.width / 2, y: plotSize.height / 2) }

    func configure(size: CGSize) {
        guard size.width >= 10, size.height >= 10 else { return }
        guard size != plotSize || ctx == nil else { return }
        plotSize = size
        let w = Int(size.width * renderScale)
        let h = Int(size.height * renderScale)
        guard w > 0, h > 0, w < 8192, h < 8192 else { return }
        guard let newCtx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return }
        // Flip so origin is top-left, matching SwiftUI Canvas
        newCtx.translateBy(x: 0, y: CGFloat(h))
        newCtx.scaleBy(x: renderScale, y: -renderScale)
        ctx = newCtx
        trailImage = nil
    }

    func sample(_ satellites: [SatelliteInfo]) {
        guard let ctx else { return }
        let now = Date()
        guard now.timeIntervalSince(lastSampleTime) >= sampleInterval else { return }
        lastSampleTime = now
        if startTime == nil { startTime = now }

        for sat in satellites {
            guard let snr = sat.snr, snr > 0 else { continue }
            let pos = polarPoint(elevation: sat.elevation, azimuth: sat.azimuth)
            let (r, g, b) = Self.snrRGB(snr)
            let alpha = 0.25 + min(Double(snr) / 50.0, 1.0) * 0.25
            ctx.setFillColor(red: r, green: g, blue: b, alpha: CGFloat(alpha))
            ctx.fillEllipse(in: CGRect(x: pos.x - 1.5, y: pos.y - 1.5, width: 3, height: 3))

            // Update horizon mask — track minimum elevation with signal per sector
            guard sat.elevation > 0 else { continue }
            let sectorIndex = Int(Double(sat.azimuth) / (360.0 / Double(sectorCount))) % sectorCount
            let currentMin = horizonMask[sectorIndex] ?? 90
            if Double(sat.elevation) < currentMin {
                horizonMask[sectorIndex] = Double(sat.elevation)
            }
        }

        trailImage = ctx.makeImage()
    }

    func clear() {
        ctx = nil
        trailImage = nil
        startTime = nil
        lastSampleTime = .distantPast
        horizonMask = Array(repeating: nil, count: sectorCount)
        let size = plotSize
        plotSize = .zero
        configure(size: size)
    }

    private func polarPoint(elevation: Int, azimuth: Int) -> CGPoint {
        let r = Double(90 - elevation) / 90.0 * Double(maxRadius)
        let rad = Double(azimuth) * .pi / 180.0
        return CGPoint(
            x: center.x + CGFloat(r * sin(rad)),
            y: center.y - CGFloat(r * cos(rad))
        )
    }

    /// SNR to RGB: red (weak) -> yellow -> green -> cyan (strong)
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

// MARK: - Sky View

struct SkyView: View {
    @EnvironmentObject var serialManager: SerialManager
    @StateObject private var trail = SkyTrail()
    @State private var plotSize: CGSize = .zero
    @State private var now = Date()

    private let celestialTimer = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

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
            // Header
            HStack {
                if let start = trail.startTime {
                    Image(systemName: "record.circle")
                        .foregroundStyle(.red)
                        .font(.caption2)
                    Text(durationLabel(since: start))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if trail.trailImage != nil {
                    Button("Clear Trail") { trail.clear() }
                        .font(.caption)
                        .buttonStyle(.borderless)
                }
            }
            .padding(.horizontal)
            .padding(.top, 8)

            if serialManager.satellites.isEmpty && trail.trailImage == nil {
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
            } else {
                // Polar plot outside ScrollView to avoid layout crash during resize
                GeometryReader { geo in
                    ZStack {
                        if let cgImage = trail.trailImage {
                            Image(decorative: cgImage, scale: trail.renderScale)
                        }
                        SkyPlotCanvas(
                            satellites: serialManager.satellites,
                            sunPosition: sunPos,
                            moonPosition: moonPos,
                            moonPhase: Astronomy.moonPhase(date: now),
                            horizonMask: trail.horizonMask
                        )
                    }
                    .onAppear {
                        plotSize = geo.size
                        trail.configure(size: geo.size)
                    }
                    .onChange(of: geo.size) { _, newSize in
                        plotSize = newSize
                        trail.configure(size: newSize)
                    }
                }
                .aspectRatio(1, contentMode: .fit)
                .padding(.horizontal)
                .padding(.top, 4)
                .onChange(of: serialManager.satellites) { _, sats in
                    if plotSize.width > 0 {
                        trail.configure(size: plotSize)
                        trail.sample(sats)
                    }
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
        .onAppear {
            now = Date()
            serialManager.requestSatelliteTracking()
            serialManager.requestNMEA()
        }
        .onDisappear {
            serialManager.releaseSatelliteTracking()
            serialManager.releaseNMEA()
        }
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
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    let moonPhase: Double
    let horizonMask: [Double?]

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let maxR = min(size.width, size.height) / 2 - 24
            guard maxR > 10 else { return }

            drawHorizonMask(context: &context, center: center, maxR: maxR)
            drawGrid(context: &context, center: center, maxR: maxR)
            drawGlowLayer(context: &context, center: center, maxR: maxR)
            drawSatellites(context: &context, center: center, maxR: maxR)
            drawSun(context: &context, center: center, maxR: maxR)
            drawMoon(context: &context, center: center, maxR: maxR)
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
            context.draw(
                Text(sat.id).font(.system(size: 7, weight: .medium)).foregroundColor(.primary),
                at: CGPoint(x: pos.x, y: pos.y - 9)
            )
        }
    }

    // MARK: - Sun & Moon

    private func drawSun(context: inout GraphicsContext, center: CGPoint, maxR: CGFloat) {
        guard let pos = sunPosition, pos.altitude > 0 else { return }

        let r = (90.0 - pos.altitude) / 90.0 * Double(maxR)
        let rad = pos.azimuth * .pi / 180.0
        let pt = CGPoint(x: center.x + r * sin(rad), y: center.y - r * cos(rad))

        let size: CGFloat = 14
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

        let size: CGFloat = 12
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
