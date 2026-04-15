import SwiftUI
import FoundationModels

/// On-device LLM analysis of GPS signal quality using Apple's Foundation Models framework.
/// Takes current satellite geometry, HDOP, fix data, and horizon mask information
/// and produces a plain-English assessment of signal quality and obstruction analysis.
struct GPSDiagnosticsView: View {
    @EnvironmentObject var serialManager: SerialManager
    @State private var analysis = ""
    @State private var isAnalysing = false
    @State private var errorMessage: String?

    private var hasData: Bool {
        !serialManager.satellites.isEmpty || serialManager.gpsFix > 0
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                GroupBox("GPS Signal Analysis") {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("On-device AI analysis of your current GPS reception.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button {
                                Task { await analyse() }
                            } label: {
                                Label(isAnalysing ? "Analysing\u{2026}" : "Analyse",
                                      systemImage: "sparkles")
                            }
                            .disabled(isAnalysing || !hasData)
                        }

                        if !hasData {
                            HStack {
                                Image(systemName: "satellite")
                                    .foregroundStyle(.secondary)
                                Text("Connect to the clock and wait for satellite data before running analysis.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                        }

                        if let error = errorMessage {
                            Label(error, systemImage: "exclamationmark.triangle")
                                .font(.caption)
                                .foregroundStyle(.red)
                        }

                        if !analysis.isEmpty {
                            Divider()
                            Text(analysis)
                                .font(.body)
                                .textSelection(.enabled)
                        }

                        if isAnalysing {
                            HStack {
                                ProgressView()
                                    .controlSize(.small)
                                Text("Running on-device model\u{2026}")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(4)
                }

                // Current data summary shown below for reference
                if hasData {
                    GroupBox("Current Data") {
                        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                            GridRow {
                                label("Fix Type")
                                Text(fixLabel)
                            }
                            GridRow {
                                label("Satellites")
                                Text(satelliteSummary)
                            }
                            if let hdop = serialManager.gpsHDOP {
                                GridRow {
                                    label("HDOP")
                                    Text(String(format: "%.1f", hdop))
                                }
                            }
                            if let lat = serialManager.gpsLatitude,
                               let lon = serialManager.gpsLongitude {
                                GridRow {
                                    label("Position")
                                    Text(String(format: "%.5f, %.5f", lat, lon))
                                }
                            }
                            if let alt = serialManager.gpsAltitude {
                                GridRow {
                                    label("Altitude")
                                    Text(String(format: "%.1f m", alt))
                                }
                            }
                            GridRow {
                                label("Constellations")
                                Text(constellationList)
                            }
                        }
                        .font(.system(.caption, design: .monospaced))
                        .padding(4)
                    }
                }
            }
            .padding()
        }
    }

    // MARK: - Foundation Models Analysis

    private func analyse() async {
        isAnalysing = true
        errorMessage = nil
        analysis = ""

        let prompt = buildPrompt()

        do {
            let session = LanguageModelSession()
            let response = try await session.respond(to: prompt)
            analysis = response.content
        } catch {
            errorMessage = "Analysis failed: \(error.localizedDescription)"
        }

        isAnalysing = false
    }

    private func buildPrompt() -> String {
        var parts = [String]()
        parts.append("You are a GPS signal quality analyst for a precision clock.")
        parts.append("Analyse the following GPS reception data and provide a concise assessment.")
        parts.append("Cover: overall signal quality, constellation diversity, potential obstructions,")
        parts.append("and any recommendations for improving reception.")
        parts.append("")
        parts.append("--- GPS DATA ---")
        parts.append("Fix type: \(fixLabel)")
        parts.append("Satellites used: \(serialManager.gpsSatellitesUsed)")

        if let hdop = serialManager.gpsHDOP {
            parts.append("HDOP: \(String(format: "%.1f", hdop))")
        }
        if let alt = serialManager.gpsAltitude {
            parts.append("Altitude: \(String(format: "%.1f m", alt))")
        }

        // Satellite details
        let tracked = serialManager.satellites.filter { ($0.snr ?? 0) > 0 }
        let acquiring = serialManager.satellites.filter { ($0.snr ?? 0) == 0 }
        parts.append("Tracked satellites: \(tracked.count)")
        parts.append("Acquiring: \(acquiring.count)")
        parts.append("Total in view: \(serialManager.satellites.count)")

        // Per-constellation breakdown
        for constellation in SatConstellation.allCases {
            let sats = serialManager.satellites.filter { $0.constellation == constellation }
            guard !sats.isEmpty else { continue }
            let withSignal = sats.filter { ($0.snr ?? 0) > 0 }
            let avgSNR = withSignal.isEmpty ? 0.0 :
                Double(withSignal.compactMap(\.snr).reduce(0, +)) / Double(withSignal.count)
            parts.append("\(constellation.rawValue): \(sats.count) in view, \(withSignal.count) tracked, avg SNR \(String(format: "%.0f", avgSNR))")
        }

        // Elevation distribution
        let highElev = serialManager.satellites.filter { $0.elevation > 60 }
        let midElev = serialManager.satellites.filter { $0.elevation > 20 && $0.elevation <= 60 }
        let lowElev = serialManager.satellites.filter { $0.elevation <= 20 }
        parts.append("Elevation distribution: \(highElev.count) high (>60\u{00B0}), \(midElev.count) mid (20-60\u{00B0}), \(lowElev.count) low (<20\u{00B0})")

        // Azimuth coverage
        let azimuths = serialManager.satellites.filter { ($0.snr ?? 0) > 0 }.map(\.azimuth)
        let quadrants = [
            "N": azimuths.filter { $0 >= 315 || $0 < 45 }.count,
            "E": azimuths.filter { $0 >= 45 && $0 < 135 }.count,
            "S": azimuths.filter { $0 >= 135 && $0 < 225 }.count,
            "W": azimuths.filter { $0 >= 225 && $0 < 315 }.count,
        ]
        parts.append("Azimuth coverage: N=\(quadrants["N"]!) E=\(quadrants["E"]!) S=\(quadrants["S"]!) W=\(quadrants["W"]!)")

        parts.append("--- END DATA ---")
        parts.append("")
        parts.append("Provide a brief, actionable analysis (3-5 sentences).")

        return parts.joined(separator: "\n")
    }

    // MARK: - Helpers

    private var fixLabel: String {
        switch serialManager.gpsFix {
        case 0: return "No fix"
        case 1: return "GPS"
        case 2: return "DGPS"
        case 4: return "RTK Fixed"
        case 5: return "RTK Float"
        default: return "Fix \(serialManager.gpsFix)"
        }
    }

    private var satelliteSummary: String {
        let tracked = serialManager.satellites.filter { ($0.snr ?? 0) > 0 }.count
        return "\(tracked) tracked, \(serialManager.satellites.count) in view"
    }

    private var constellationList: String {
        let present = Set(serialManager.satellites.map(\.constellation))
        return SatConstellation.allCases
            .filter { present.contains($0) }
            .map(\.rawValue)
            .joined(separator: ", ")
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(width: 90, alignment: .trailing)
    }
}
