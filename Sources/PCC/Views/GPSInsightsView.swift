import SwiftUI
import FoundationModels

// MARK: - Mode

/// What kind of question the AI is being asked about the GPS reception.
///
/// Each mode has its own prompt and its own slice of the available data — all
/// running on Apple's on-device Foundation Models, no API key, no network.
///
/// Three modes, each leveraging the accumulated pass history in
/// `SkyTrailStore`. (A fourth "Now" mode was trialled and cut — it was LLM
/// paraphrase of data already on screen.)
///
/// - `.site`    — antenna-siting advice using the accumulated horizon mask.
/// - `.quality` — per-constellation diagnostics from completed passes.
/// - `.trends`  — last-24h vs. preceding-week delta to flag drift.
enum InsightMode: String, CaseIterable, Identifiable {
    case site    = "Site"
    case quality = "Quality"
    case trends  = "Trends"

    var id: Self { self }

    var icon: String {
        switch self {
        case .site:    return "antenna.radiowaves.left.and.right"
        case .quality: return "waveform.path.ecg"
        case .trends:  return "chart.line.uptrend.xyaxis"
        }
    }

    var title: String {
        switch self {
        case .site:    return "Antenna Siting"
        case .quality: return "Signal Quality"
        case .trends:  return "Trends"
        }
    }

    var blurb: String {
        switch self {
        case .site:    return "Where is the sky blocked? Should the antenna move?"
        case .quality: return "Which constellations are under-performing?"
        case .trends:  return "Has reception drifted over the last day?"
        }
    }
}

// MARK: - Insights view

/// On-device AI insights about GPS reception, presented as a sheet from the
/// Sky panel. Runs Apple's Foundation Models locally so the analysis is
/// private and offline.
///
/// The mode picker at the top selects which question the user is asking;
/// each mode feeds the model a purpose-built prompt built from the accumulated
/// pass history in `SkyTrailStore`. Results are cached per mode within a
/// single sheet lifetime so flipping tabs doesn't throw away a previous
/// answer — hitting Analyse re-runs the current mode in-place.
struct GPSInsightsView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var trailStore: SkyTrailStore
    @Environment(\.dismiss) private var dismiss

    @State private var mode: InsightMode = .site
    @State private var resultsByMode: [InsightMode: String] = [:]
    @State private var isAnalysing = false
    @State private var errorMessage: String?

    private var currentResult: String { resultsByMode[mode] ?? "" }

    /// Each mode has its own minimum-data threshold; without it the prompt
    /// would be hot air and the model would hallucinate. Returning `nil`
    /// means "ready to run"; a non-nil string is shown to the user as the
    /// reason the button is disabled.
    private var blockingReason: String? {
        switch mode {
        case .site:
            let filled = trailStore.horizonMask.compactMap({ $0 }).count
            if filled < 12 {
                return "Need more recorded passes to map the horizon (\(filled) of 72 sectors filled)."
            }
            return nil
        case .quality:
            let completed = trailStore.allPasses.count
            if completed < 6 {
                return "Need more recorded passes to diagnose signal quality (\(completed) so far)."
            }
            return nil
        case .trends:
            let all = trailStore.allPasses
            guard let oldest = all.map(\.startTime).min() else {
                return "No recorded passes yet."
            }
            let hours = Date().timeIntervalSince(oldest) / 3600
            if hours < 36 {
                return "Need at least 36 hours of recording to see trends (\(String(format: "%.0f", hours))h so far)."
            }
            return nil
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Title bar — sheet needs its own chrome since there's no sidebar
            // parent. Done button on the trailing edge is the canonical macOS
            // sheet-dismiss affordance.
            HStack {
                Label("GPS Insights", systemImage: "sparkles")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding()

            Divider()

            VStack(alignment: .leading, spacing: 12) {
                Picker("Mode", selection: $mode) {
                    ForEach(InsightMode.allCases) { m in
                        Label(m.title, systemImage: m.icon).tag(m)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                Text(mode.blurb)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(spacing: 8) {
                    Button {
                        Task { await analyse() }
                    } label: {
                        Label(isAnalysing ? "Analysing\u{2026}" : "Analyse",
                              systemImage: "sparkles")
                    }
                    .disabled(isAnalysing || blockingReason != nil)

                    if isAnalysing {
                        ProgressView().controlSize(.small)
                        Text("Running on-device model\u{2026}")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Spacer()
                }

                if let error = errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else if let reason = blockingReason, currentResult.isEmpty {
                    Label(reason, systemImage: "hourglass")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !currentResult.isEmpty {
                    Divider()
                    ScrollView {
                        Text(currentResult)
                            .font(.body)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 360)
                }
            }
            .padding()
        }
        .frame(minWidth: 520)
    }

    // MARK: - Analyse

    private func analyse() async {
        isAnalysing = true
        errorMessage = nil

        let prompt = buildPrompt(for: mode)

        do {
            let session = LanguageModelSession()
            let response = try await session.respond(to: prompt)
            resultsByMode[mode] = response.content
        } catch {
            errorMessage = "Analysis failed: \(error.localizedDescription)"
        }

        isAnalysing = false
    }

    // MARK: - Prompt dispatch

    private func buildPrompt(for mode: InsightMode) -> String {
        switch mode {
        case .site:    return buildSitePrompt()
        case .quality: return buildQualityPrompt()
        case .trends:  return buildTrendsPrompt()
        }
    }

    // MARK: - Site prompt

    private func buildSitePrompt() -> String {
        var parts: [String] = []
        parts.append("You are a GPS antenna-siting analyst. The user has a stationary antenna and")
        parts.append("wants to know whether the sky is obstructed and where they should re-site it.")
        parts.append("")

        let mask = trailStore.horizonMask
        let sectorWidth = 5
        let filledCount = mask.compactMap({ $0 }).count
        let stats = trailStore.stats

        parts.append("--- HORIZON MASK ---")
        parts.append("\(filledCount) of 72 azimuth sectors have been observed.")
        parts.append("Each sector is \(sectorWidth)\u{00B0} of azimuth. 'min el' is the lowest elevation")
        parts.append("at which a satellite has been seen in that sector — lower is better (open sky).")
        parts.append("A high min-elevation means something is blocking the lower sky there.")
        parts.append("")
        parts.append("Sector (azimuth range): min elevation observed")
        for (i, el) in mask.enumerated() {
            guard let e = el else { continue }
            let azStart = i * sectorWidth
            let azEnd = azStart + sectorWidth
            let card = cardinalForAz(Double(azStart + sectorWidth / 2))
            parts.append("  \(String(format: "%03d", azStart))\u{00B0}-\(String(format: "%03d", azEnd))\u{00B0} (\(card)): min el \(String(format: "%2.0f", e))\u{00B0}")
        }
        parts.append("")

        // Quadrant pass counts — where are passes actually being seen, vs where
        // they're statistically missing? An NE quadrant with only 2 passes in
        // a week's recording is a strong signal of obstruction.
        let allPasses = trailStore.allPasses
        var quadPasses = ["N": 0, "E": 0, "S": 0, "W": 0]
        for p in allPasses {
            let peakAz = p.observations.max(by: { $0.el < $1.el })?.az ?? 0
            let az = Double(peakAz)
            if az >= 315 || az < 45        { quadPasses["N"]! += 1 }
            else if az < 135               { quadPasses["E"]! += 1 }
            else if az < 225               { quadPasses["S"]! += 1 }
            else                           { quadPasses["W"]! += 1 }
        }

        parts.append("--- PASSES BY QUADRANT ---")
        parts.append("Total completed + active passes: \(allPasses.count)")
        parts.append("  N: \(quadPasses["N"]!)  E: \(quadPasses["E"]!)  S: \(quadPasses["S"]!)  W: \(quadPasses["W"]!)")
        parts.append("")

        parts.append("--- OVERALL ---")
        parts.append("Sky coverage: \(String(format: "%.0f", stats.coveragePercent))% of azimuth sectors populated")
        parts.append("Peak elevation ever observed: \(stats.peakElevation)\u{00B0}")
        let longestMin = stats.longestPassSeconds / 60
        let longestSec = stats.longestPassSeconds % 60
        parts.append("Longest continuous pass: \(longestMin)m \(longestSec)s")
        parts.append("--- END DATA ---")
        parts.append("")
        parts.append("Identify specific obstructed azimuth ranges (e.g. \"NE between 030-070\u{00B0} blocks")
        parts.append("below 35\u{00B0} elevation\") and suggest concrete antenna-siting actions. Mention")
        parts.append("the northern sky bias if relevant — a northern-hemisphere antenna naturally sees")
        parts.append("fewer passes due north than due south, so a quiet N quadrant is only suspicious")
        parts.append("if it's paired with a high min-elevation there. Keep it practical, 4-6 sentences.")

        return parts.joined(separator: "\n")
    }

    // MARK: - Quality prompt

    private func buildQualityPrompt() -> String {
        var parts: [String] = []
        parts.append("You are a GNSS receiver quality analyst. Compare how the four constellations")
        parts.append("are performing for this user and diagnose any that are under-performing.")
        parts.append("GPS is the usual reference — if another constellation is systematically weaker")
        parts.append("or has shorter passes, that suggests an antenna band cut, firmware filter, or")
        parts.append("RF interference on that band.")
        parts.append("")

        let all = trailStore.allPasses

        parts.append("--- PER-CONSTELLATION STATS (from \(all.count) passes) ---")
        for c in SatConstellation.allCases {
            let group = all.filter { $0.constellation == c }
            guard !group.isEmpty else { continue }
            let peakSNRs = group.map(\.peakSNR)
            let durations = group.map(\.duration)
            let reached30 = group.filter { $0.peakElevation >= 30 }.count
            let reached60 = group.filter { $0.peakElevation >= 60 }.count
            let medSNR = median(peakSNRs)
            let medDur = median(durations)
            parts.append("\(c.rawValue):")
            parts.append("  passes:        \(group.count)")
            parts.append("  median peak SNR: \(String(format: "%.0f", medSNR)) dB")
            parts.append("  median duration: \(String(format: "%.0f", medDur / 60))m \(String(format: "%.0f", medDur.truncatingRemainder(dividingBy: 60)))s")
            parts.append("  reached \u{2265}30\u{00B0} elev: \(reached30) (\(percent(reached30, of: group.count)))")
            parts.append("  reached \u{2265}60\u{00B0} elev: \(reached60) (\(percent(reached60, of: group.count)))")
        }
        parts.append("")

        parts.append("--- CURRENT FIX ---")
        parts.append("Fix type: \(fixLabel)")
        if let hdop = serialManager.gpsHDOP {
            parts.append("HDOP: \(String(format: "%.1f", hdop))")
        }
        parts.append("Satellites used: \(serialManager.gpsSatellitesUsed) / \(serialManager.satellites.count) in view")
        parts.append("--- END DATA ---")
        parts.append("")
        parts.append("Call out constellations that are materially worse than GPS (e.g. 'GLONASS is 4 dB")
        parts.append("lower and its passes end 40% earlier') and give the most likely physical cause.")
        parts.append("If everything is roughly balanced say so. Keep it concrete: name the constellation,")
        parts.append("the delta, and the suspected cause. 4-6 sentences.")
        return parts.joined(separator: "\n")
    }

    // MARK: - Trends prompt

    private func buildTrendsPrompt() -> String {
        var parts: [String] = []
        parts.append("You are a GPS reception trend analyst. Decide whether reception has changed")
        parts.append("materially in the last 24 hours compared with the preceding week.")
        parts.append("")

        let now = Date()
        let day = now.addingTimeInterval(-86_400)
        let week = now.addingTimeInterval(-7 * 86_400)

        let all = trailStore.allPasses
        let recent = all.filter { $0.endTime >= day }
        let prior  = all.filter { $0.endTime < day && $0.endTime >= week }

        parts.append("--- LAST 24 HOURS ---")
        appendBucketStats(&parts, passes: recent)
        parts.append("")

        parts.append("--- PRECEDING 6 DAYS ---")
        appendBucketStats(&parts, passes: prior)
        parts.append("--- END DATA ---")
        parts.append("")
        parts.append("If reception has changed materially (>20% pass-count swing, >2 dB SNR median")
        parts.append("swing, or a new constellation dropping off), call it out and speculate on a")
        parts.append("likely cause (antenna moved, nearby RF, weather). If stable, say so briefly.")
        parts.append("3-5 sentences.")
        return parts.joined(separator: "\n")
    }

    private func appendBucketStats(_ parts: inout [String], passes: [SatPass]) {
        parts.append("Passes: \(passes.count)")
        if passes.isEmpty { return }
        let peaks = passes.map(\.peakSNR)
        let durations = passes.map(\.duration)
        let peakElevs = passes.map(\.peakElevation)
        parts.append("Median peak SNR: \(String(format: "%.0f", median(peaks))) dB")
        parts.append("Median duration: \(String(format: "%.0f", median(durations) / 60))m")
        parts.append("Median peak elevation: \(String(format: "%.0f", median(peakElevs)))\u{00B0}")
        for c in SatConstellation.allCases {
            let sub = passes.filter { $0.constellation == c }
            guard !sub.isEmpty else { continue }
            parts.append("  \(c.rawValue): \(sub.count) passes, median peak SNR \(String(format: "%.0f", median(sub.map(\.peakSNR)))) dB")
        }
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

    private func cardinalForAz(_ az: Double) -> String {
        // 16-point compass — more specific than N/E/S/W without being fussy.
        let labels = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                      "S","SSW","SW","WSW","W","WNW","NW","NNW"]
        let idx = Int(((az.truncatingRemainder(dividingBy: 360) + 360)
                       .truncatingRemainder(dividingBy: 360) / 22.5).rounded()) % 16
        return labels[idx]
    }

    private func median<T: BinaryInteger>(_ xs: [T]) -> Double {
        guard !xs.isEmpty else { return 0 }
        let sorted = xs.sorted()
        let n = sorted.count
        if n % 2 == 1 { return Double(sorted[n / 2]) }
        return (Double(sorted[n / 2 - 1]) + Double(sorted[n / 2])) / 2
    }

    private func median(_ xs: [TimeInterval]) -> Double {
        guard !xs.isEmpty else { return 0 }
        let sorted = xs.sorted()
        let n = sorted.count
        if n % 2 == 1 { return sorted[n / 2] }
        return (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    }

    private func percent(_ num: Int, of denom: Int) -> String {
        guard denom > 0 else { return "0%" }
        return "\(Int((Double(num) / Double(denom) * 100).rounded()))%"
    }
}
