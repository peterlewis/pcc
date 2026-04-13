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
class SkyTrail: ObservableObject {
    @Published var trailImage: CGImage?
    var startTime: Date?
    let renderScale: CGFloat = 2

    private var ctx: CGContext?
    private var plotSize: CGSize = .zero
    private var lastSampleTime: Date = .distantPast
    private let sampleInterval: TimeInterval = 10

    var maxRadius: CGFloat { min(plotSize.width, plotSize.height) / 2 - 24 }
    var center: CGPoint { CGPoint(x: plotSize.width / 2, y: plotSize.height / 2) }

    func configure(size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        guard size != plotSize || ctx == nil else { return }
        plotSize = size
        let w = Int(size.width * renderScale)
        let h = Int(size.height * renderScale)
        ctx = CGContext(
            data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
        // Flip so origin is top-left, matching SwiftUI Canvas
        ctx?.translateBy(x: 0, y: CGFloat(h))
        ctx?.scaleBy(x: renderScale, y: -renderScale)
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
        }

        trailImage = ctx.makeImage()
    }

    func clear() {
        ctx = nil
        trailImage = nil
        startTime = nil
        lastSampleTime = .distantPast
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
                // Polar plot with trail
                GeometryReader { geo in
                    ZStack {
                        // Trail bitmap layer
                        if let cgImage = trail.trailImage {
                            Image(decorative: cgImage, scale: trail.renderScale)
                        }
                        // Live grid + satellites
                        SkyPlotCanvas(satellites: serialManager.satellites)
                    }
                    .onAppear {
                        plotSize = geo.size
                        trail.configure(size: geo.size)
                    }
                    .onChange(of: geo.size) { newSize in
                        plotSize = newSize
                        trail.configure(size: newSize)
                    }
                }
                .aspectRatio(1, contentMode: .fit)
                .padding(.horizontal)
                .padding(.top, 4)
                .onChange(of: serialManager.satellites) { sats in
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
        .onAppear {
            serialManager.satelliteTrackingEnabled = true
            serialManager.sendCommand("NMEA = all")
        }
        .onDisappear {
            serialManager.satelliteTrackingEnabled = false
            serialManager.sendCommand("NMEA = off")
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

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let maxR = min(size.width, size.height) / 2 - 24

            drawGrid(context: &context, center: center, maxR: maxR)
            drawGlowLayer(context: &context, center: center, maxR: maxR)
            drawSatellites(context: &context, center: center, maxR: maxR)
        }
    }

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

    private func polarPoint(_ sat: SatelliteInfo, center: CGPoint, maxR: CGFloat) -> CGPoint {
        let r = Double(90 - sat.elevation) / 90.0 * Double(maxR)
        let rad = Double(sat.azimuth) * .pi / 180.0
        return CGPoint(x: center.x + r * sin(rad), y: center.y - r * cos(rad))
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
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(sorted) { sat in
                    VStack(spacing: 1) {
                        if let snr = sat.snr, snr > 0 {
                            Text("\(snr)")
                                .font(.system(size: 7))
                                .foregroundStyle(.secondary)
                        }
                        RoundedRectangle(cornerRadius: 1)
                            .fill(barColor(sat))
                            .frame(width: 14, height: barHeight(sat))
                        Text(sat.id)
                            .font(.system(size: 6))
                            .foregroundStyle(.secondary)
                    }
                }
            }
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
