import Foundation
import AppKit

// MARK: - Active pass tracking

private struct ActivePass {
    var pass: SatPass
    var lastSeen: Date
    var lastRecorded: Date
}

// MARK: - Summary statistics

/// Aggregate stats derived from all recorded passes.
struct SkyStats {
    let totalPasses: Int
    let passesToday: Int
    let observations: Int
    let coveragePercent: Double   // 0–100
    let peakElevation: Int
    let longestPassSeconds: Int

    static let empty = SkyStats(totalPasses: 0, passesToday: 0, observations: 0,
                                 coveragePercent: 0, peakElevation: 0, longestPassSeconds: 0)
}

// MARK: - Persistent store

/// Records satellite passes with full per-observation detail.
/// Each satellite's continuous track is stored as one `SatPass`; observations
/// are ~6 bytes each. Passes persist to per-day JSON directories with a
/// configurable retention window.
class SkyTrailStore: ObservableObject {
    // MARK: Tunables

    static let maxHistoryDays = 30
    static let recordingInterval: TimeInterval = 6    // seconds between saved obs per PRN
    static let passTimeout: TimeInterval = 90         // seconds without signal → close pass
    static let passRejoinWindow: TimeInterval = 300   // same PRN reappearing within window resumes its prior pass
    static let minObservations = 3                    // shorter passes are discarded
    private static let isLoggingKey = "SkyTrailStore.isLogging"

    // MARK: Published state

    @Published var isLogging: Bool = false {
        didSet {
            UserDefaults.standard.set(isLogging, forKey: Self.isLoggingKey)
        }
    }
    @Published private(set) var passes: [SatPass] = []
    /// Minimum elevation observed per 5° azimuth sector (72 sectors).
    /// Incrementally maintained as observations arrive.
    @Published private(set) var horizonMask: [Double?] = Array(repeating: nil, count: 72)

    // MARK: Private state

    private var active: [String: ActivePass] = [:]
    private var timeoutTimer: Timer?
    private let passesDir: URL

    // MARK: Derived collections

    /// Completed + currently-recording passes (newest first).
    var allPasses: [SatPass] {
        (passes + active.values.map(\.pass)).sorted { $0.startTime > $1.startTime }
    }

    /// PRNs of satellites currently being tracked.
    var activePRNs: Set<String> { Set(active.keys) }

    /// Passes whose endTime falls within the given window.
    func filtered(by window: TimeWindow, now: Date = Date()) -> [SatPass] {
        guard let cutoff = window.cutoff(from: now) else { return allPasses }
        return allPasses.filter { $0.endTime >= cutoff }
    }

    // MARK: Summary stats

    var stats: SkyStats {
        let all = allPasses
        if all.isEmpty { return .empty }
        let now = Date()
        let todayCutoff = now.addingTimeInterval(-86_400)
        let occupiedSectors = horizonMask.lazy.compactMap({ $0 }).count
        let peak = all.lazy.map(\.peakElevation).max() ?? 0
        let longest = all.lazy.map(\.duration).max() ?? 0
        let todayCount = all.lazy.filter { $0.endTime >= todayCutoff }.count
        let obsCount = all.reduce(0) { $0 + $1.observations.count }
        return SkyStats(
            totalPasses: all.count,
            passesToday: todayCount,
            observations: obsCount,
            coveragePercent: Double(occupiedSectors) / 72.0 * 100,
            peakElevation: peak,
            longestPassSeconds: Int(longest)
        )
    }

    var dataSummary: String {
        let s = stats
        if s.totalPasses == 0 { return "No data" }
        let passStr = s.totalPasses == 1 ? "pass" : "passes"
        return "\(s.totalPasses) \(passStr), \(formatCount(s.observations)) obs"
    }

    var durationSummary: String? {
        guard let oldest = passes.map(\.startTime).min() else { return nil }
        let seconds = Int(Date().timeIntervalSince(oldest))
        if seconds < 60 { return "< 1 min" }
        let h = seconds / 3600, m = (seconds % 3600) / 60
        if h >= 24 { let d = h / 24; return "\(d)d \(h % 24)h" }
        if h > 0   { return "\(h)h \(m)m" }
        return "\(m)m"
    }

    // MARK: Lifecycle

    init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        passesDir = appSupport
            .appendingPathComponent("Precision Clock Companion", isDirectory: true)
            .appendingPathComponent("passes", isDirectory: true)
        try? FileManager.default.createDirectory(at: passesDir, withIntermediateDirectories: true)
        // Respect the user's previous recording choice (default off for new users).
        isLogging = UserDefaults.standard.bool(forKey: Self.isLoggingKey)
        pruneOldPasses()
        loadPasses()
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            self?.flushActivePasses()
        }
    }

    // MARK: Recording

    /// Ingest a batch of satellite observations. Updates/creates active passes
    /// and incrementally maintains the horizon mask.
    func update(satellites: [SatelliteInfo]) {
        guard isLogging else { return }
        let now = Date()

        for sat in satellites where (sat.snr ?? 0) > 0 {
            updateHorizonMask(az: sat.azimuth, el: sat.elevation)
            appendObservation(for: sat, at: now)
        }

        ensureTimeoutTimerRunning()
        objectWillChange.send()
    }

    private func updateHorizonMask(az: Int, el: Int) {
        guard el > 1 else { return }
        let sector = ((az % 360) + 360) % 360 / 5
        guard sector >= 0, sector < 72 else { return }
        let current = horizonMask[sector] ?? 90
        if Double(el) < current {
            horizonMask[sector] = Double(el)
        }
    }

    private func appendObservation(for sat: SatelliteInfo, at now: Date) {
        let prn = sat.id
        let az = Int16(clamping: sat.azimuth)
        let el = Int8(clamping: sat.elevation)
        let snr = Int8(clamping: sat.snr ?? 0)

        if var entry = active[prn] {
            entry.lastSeen = now
            if now.timeIntervalSince(entry.lastRecorded) >= Self.recordingInterval {
                let tOffset = UInt16(clamping: Int(now.timeIntervalSince(entry.pass.startTime)))
                entry.pass.observations.append(SatObservation(az: az, el: el, snr: snr, t: tOffset))
                entry.lastRecorded = now
                active[prn] = entry
                savePass(entry.pass)   // durable write on every new observation
            } else {
                active[prn] = entry
            }
        } else if let idx = recentPassIndex(for: prn, at: now) {
            // Drop-outs shorter than `passRejoinWindow` are treated as brief
            // signal interruptions (obstruction, multipath null, unlock) rather
            // than horizon events — resume the prior pass so the trail stays
            // continuous across momentary losses.
            var revived = passes.remove(at: idx)
            let tOffset = UInt16(clamping: Int(now.timeIntervalSince(revived.startTime)))
            revived.observations.append(SatObservation(az: az, el: el, snr: snr, t: tOffset))
            active[prn] = ActivePass(pass: revived, lastSeen: now, lastRecorded: now)
            savePass(revived)
        } else {
            let firstObs = SatObservation(az: az, el: el, snr: snr, t: 0)
            let pass = SatPass(id: UUID(), prn: prn, constellation: sat.constellation,
                               startTime: now, observations: [firstObs])
            active[prn] = ActivePass(pass: pass, lastSeen: now, lastRecorded: now)
            savePass(pass)            // persist from the first observation
        }
    }

    /// Most-recent closed pass for this PRN that ended within `passRejoinWindow`.
    /// `passes` is sorted newest-first, so `firstIndex` returns the most recent match.
    private func recentPassIndex(for prn: String, at now: Date) -> Int? {
        let cutoff = now.addingTimeInterval(-Self.passRejoinWindow)
        return passes.firstIndex { $0.prn == prn && $0.endTime >= cutoff }
    }

    private func ensureTimeoutTimerRunning() {
        guard timeoutTimer == nil else { return }
        timeoutTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.timeoutStalePasses()
        }
    }

    private func timeoutStalePasses() {
        let now = Date()
        for prn in active.keys where now.timeIntervalSince(active[prn]!.lastSeen) >= Self.passTimeout {
            closePass(prn)
        }
        if active.isEmpty {
            timeoutTimer?.invalidate()
            timeoutTimer = nil
        }
    }

    private func closePass(_ prn: String) {
        guard let entry = active.removeValue(forKey: prn) else { return }
        // Pass was already persisted on each observation append. On close we
        // either promote the in-memory copy or delete the file for trivially
        // short passes that don't meet the min-obs threshold.
        if entry.pass.observations.count >= Self.minObservations {
            passes.append(entry.pass)
            passes.sort { $0.startTime > $1.startTime }
        } else {
            deletePassFile(entry.pass)
        }
    }

    private func flushActivePasses() {
        Array(active.keys).forEach { closePass($0) }
    }

    // MARK: External control

    func clear() {
        flushActivePasses()
        active.removeAll()
        passes.removeAll()
        horizonMask = Array(repeating: nil, count: 72)
        timeoutTimer?.invalidate()
        timeoutTimer = nil
        try? FileManager.default.removeItem(at: passesDir)
        try? FileManager.default.createDirectory(at: passesDir, withIntermediateDirectories: true)
    }

    // MARK: Persistence

    private func passFileURL(for pass: SatPass) -> URL {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withFullDate, .withDashSeparatorInDate]
        let dayKey = fmt.string(from: pass.startTime)
        let dayDir = passesDir.appendingPathComponent(dayKey)
        try? FileManager.default.createDirectory(at: dayDir, withIntermediateDirectories: true)
        return dayDir.appendingPathComponent("\(pass.id).json")
    }

    private func savePass(_ pass: SatPass) {
        guard let data = try? JSONEncoder().encode(pass) else { return }
        try? data.write(to: passFileURL(for: pass), options: .atomic)
    }

    private func deletePassFile(_ pass: SatPass) {
        try? FileManager.default.removeItem(at: passFileURL(for: pass))
    }

    private func loadPasses() {
        let fm = FileManager.default
        guard let dayDirs = try? fm.contentsOfDirectory(at: passesDir, includingPropertiesForKeys: nil) else { return }
        var loaded: [SatPass] = []
        for dayDir in dayDirs {
            guard let files = try? fm.contentsOfDirectory(at: dayDir, includingPropertiesForKeys: nil) else { continue }
            for file in files where file.pathExtension == "json" {
                guard let data = try? Data(contentsOf: file),
                      let pass = try? JSONDecoder().decode(SatPass.self, from: data) else { continue }
                loaded.append(pass)
            }
        }
        passes = loaded.sorted { $0.startTime > $1.startTime }

        // Rebuild horizon mask from loaded observations.
        var mask = [Double?](repeating: nil, count: 72)
        for pass in passes {
            for obs in pass.observations where obs.el > 1 {
                let sector = ((Int(obs.az) % 360) + 360) % 360 / 5
                guard sector >= 0, sector < 72 else { continue }
                let current = mask[sector] ?? 90
                if Double(obs.el) < current { mask[sector] = Double(obs.el) }
            }
        }
        horizonMask = mask
    }

    private func pruneOldPasses() {
        let cutoff = Date().addingTimeInterval(-Double(Self.maxHistoryDays) * 86_400)
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withFullDate, .withDashSeparatorInDate]
        let fm = FileManager.default
        guard let dayDirs = try? fm.contentsOfDirectory(at: passesDir, includingPropertiesForKeys: nil) else { return }
        for dayDir in dayDirs {
            if let date = fmt.date(from: dayDir.lastPathComponent), date < cutoff {
                try? fm.removeItem(at: dayDir)
            }
        }
    }

    // MARK: Helpers

    private func formatCount(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000     { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }
}
