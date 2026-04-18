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
    /// How long completed passes are kept on disk. Changing this re-runs the
    /// prune pass — if the new window is shorter the extra data is deleted,
    /// which is why the UI layer wraps changes in a confirmation dialog when
    /// shrinking. Persisted to UserDefaults so the choice survives relaunch.
    @Published var retention: RetentionWindow = .d30 {
        didSet {
            guard oldValue != retention else { return }
            UserDefaults.standard.set(retention.rawValue, forKey: RetentionWindow.defaultsKey)
            pruneOldPasses()
            objectWillChange.send()
        }
    }
    @Published private(set) var passes: [SatPass] = []
    /// Minimum elevation observed per 5° azimuth sector (72 sectors).
    /// Incrementally maintained as observations arrive.
    @Published private(set) var horizonMask: [Double?] = Array(repeating: nil, count: 72)
    /// Peak SNR observed per (azimuth × elevation) 5° cell — 72 az × 18 el
    /// bins covering the whole sky hemisphere. Populated from the same stream
    /// of NMEA observations as `horizonMask` and rebuilt from disk on launch.
    /// Renders as a u-center-style sky-view heatmap on the polar plot.
    /// Row index is azimuth / 5 (0..<72), column index is elevation / 5
    /// (0..<18, i.e. 0°–90° in 5° steps); nil means "never seen".
    @Published private(set) var sectorHeatmap: [[Int?]] = Array(
        repeating: Array(repeating: nil, count: 18),
        count: 72
    )

    // MARK: Private state

    private var active: [String: ActivePass] = [:]
    private var timeoutTimer: Timer?
    private let passesDir: URL
    /// Serial background queue used for per-observation pass writes. Keeps
    /// the main thread responsive during bursty NMEA updates (one write per
    /// tracked satellite every ~6 s — up to ~20 writes back-to-back on a
    /// good sky). Serial because JSON encoding + atomic writes to the same
    /// path must not interleave; last-writer-wins is fine because each pass
    /// is keyed by UUID and writes are append-only within a pass's lifetime.
    private let saveQueue = DispatchQueue(label: "is.peterlew.pcc.skyTrailStore.save",
                                          qos: .utility)

    // MARK: Derived collections

    /// Completed + currently-recording passes (newest first).
    var allPasses: [SatPass] {
        (passes + active.values.map(\.pass)).sorted { $0.startTime > $1.startTime }
    }

    /// PRNs of satellites currently being tracked.
    var activePRNs: Set<String> { Set(active.keys) }

    /// Passes with observations inside the given window. The previous
    /// implementation only filtered on `endTime >= cutoff`, which kept the
    /// *entire* arc of any live or recently-ended pass — so the "5 m" view
    /// still showed a 20-minute arc for an active satellite. This version
    /// additionally trims each pass's observation array to the subset whose
    /// absolute time is >= cutoff, giving a true "last N" render across all
    /// windows. Trimmed passes retain their original `startTime` so the
    /// internal `t` offsets remain meaningful.
    func filtered(by window: TimeWindow, now: Date = Date()) -> [SatPass] {
        guard let cutoff = window.cutoff(from: now) else { return allPasses }
        return allPasses.compactMap { pass in
            guard pass.endTime >= cutoff else { return nil }
            let cutoffOffset = cutoff.timeIntervalSince(pass.startTime)
            // Entire arc is already inside the window — no trimming needed.
            if cutoffOffset <= 0 { return pass }
            let cutoffT = max(0, Int(cutoffOffset.rounded()))
            guard let firstIdx = pass.observations.firstIndex(where: { Int($0.t) >= cutoffT }) else {
                return nil
            }
            // Need at least two samples to render a line segment; skip the
            // pass entirely if trimming leaves us with a single point.
            guard pass.observations.count - firstIdx >= 2 else { return nil }
            var trimmed = pass
            trimmed.observations = Array(pass.observations[firstIdx...])
            return trimmed
        }
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
        // ~/Library/Application Support on a normal install. Fall back to
        // the temp directory for the pathological case where the user's
        // app-support search path is empty — the app still runs, we just
        // lose persistence across relaunch instead of crashing on boot.
        let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        passesDir = appSupport
            .appendingPathComponent("Precision Clock Companion", isDirectory: true)
            .appendingPathComponent("passes", isDirectory: true)
        try? FileManager.default.createDirectory(at: passesDir, withIntermediateDirectories: true)
        // Respect the user's previous recording choice (default off for new users).
        isLogging = UserDefaults.standard.bool(forKey: Self.isLoggingKey)
        // Direct init-time assignment skips didSet — we run the prune once
        // explicitly below after everything's in place.
        retention = RetentionWindow.current
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
            updateSectorHeatmap(az: sat.azimuth, el: sat.elevation, snr: sat.snr ?? 0)
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

    /// Records peak SNR per 5°×5° sky cell. Max (not mean) so strong signals
    /// stay visible even after a low-SNR drag-through later — the u-center
    /// sky-view it's modelled on shows best-observed strength per cell.
    private func updateSectorHeatmap(az: Int, el: Int, snr: Int) {
        guard el >= 0, el <= 90, snr > 0 else { return }
        let azBin = ((az % 360) + 360) % 360 / 5
        let elBin = min(17, max(0, el / 5))
        guard azBin >= 0, azBin < 72 else { return }
        let current = sectorHeatmap[azBin][elBin] ?? 0
        if snr > current {
            sectorHeatmap[azBin][elBin] = snr
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
        // Snapshot keys first — `closePass` mutates `active`, which is UB if
        // we're still iterating `active.keys` (a live view, not a copy). The
        // same loop previously also force-unwrapped `active[prn]!` in the
        // where clause, which would crash if the entry somehow vanished
        // between key enumeration and the lookup.
        let stalePRNs = active.compactMap { (prn, entry) -> String? in
            now.timeIntervalSince(entry.lastSeen) >= Self.passTimeout ? prn : nil
        }
        for prn in stalePRNs {
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
        sectorHeatmap = Array(repeating: Array(repeating: nil, count: 18), count: 72)
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
        // Encode on the caller's thread (cheap — <1kB typical) but send the
        // atomic disk write to a serial background queue so we don't stall
        // the main run loop during bursty NMEA frames. The pass URL is
        // resolved synchronously so it reflects the pass's current startTime
        // rather than re-querying on the queue.
        let url = passFileURL(for: pass)
        guard let data = try? JSONEncoder().encode(pass) else { return }
        saveQueue.async {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func deletePassFile(_ pass: SatPass) {
        let url = passFileURL(for: pass)
        saveQueue.async {
            try? FileManager.default.removeItem(at: url)
        }
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

        // Rebuild horizon mask and sector heatmap from loaded observations in
        // a single pass. Both are derived state — cheap to reconstruct — so
        // there's no need to persist them separately alongside the raw passes.
        var mask = [Double?](repeating: nil, count: 72)
        var heat: [[Int?]] = Array(repeating: Array(repeating: nil, count: 18), count: 72)
        for pass in passes {
            for obs in pass.observations {
                let az = Int(obs.az)
                let el = Int(obs.el)
                let snr = Int(obs.snr)
                let azBin = ((az % 360) + 360) % 360 / 5
                guard azBin >= 0, azBin < 72 else { continue }
                if el > 1 {
                    let current = mask[azBin] ?? 90
                    if Double(el) < current { mask[azBin] = Double(el) }
                }
                if el >= 0, el <= 90, snr > 0 {
                    let elBin = min(17, max(0, el / 5))
                    let best = heat[azBin][elBin] ?? 0
                    if snr > best { heat[azBin][elBin] = snr }
                }
            }
        }
        horizonMask = mask
        sectorHeatmap = heat
    }

    /// Passes that a given retention window would delete right now. Used by
    /// the UI to warn before shrinking retention — we count how many will be
    /// permanently lost so the dialog can quote a real number.
    func passesThatWouldBePruned(by retention: RetentionWindow, at now: Date = Date()) -> [SatPass] {
        guard let secs = retention.seconds else { return [] }
        let cutoff = now.addingTimeInterval(-secs)
        return allPasses.filter { $0.endTime < cutoff }
    }

    private func pruneOldPasses() {
        guard let secs = retention.seconds else {
            // Unlimited: nothing to delete.
            return
        }
        let now = Date()
        let cutoff = now.addingTimeInterval(-secs)

        // In-memory drop (completed passes whose endTime precedes the cutoff).
        let doomed = passes.filter { $0.endTime < cutoff }
        if !doomed.isEmpty {
            for p in doomed { deletePassFile(p) }
            passes.removeAll { $0.endTime < cutoff }
        }

        // Disk cleanup: remove day-directories whose name precedes the cutoff
        // day entirely. Anything partial-day gets handled above.
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withFullDate, .withDashSeparatorInDate]
        let cutoffDay = Calendar(identifier: .gregorian).startOfDay(for: cutoff)
        let fm = FileManager.default
        guard let dayDirs = try? fm.contentsOfDirectory(at: passesDir, includingPropertiesForKeys: nil) else { return }
        for dayDir in dayDirs {
            if let date = fmt.date(from: dayDir.lastPathComponent), date < cutoffDay {
                try? fm.removeItem(at: dayDir)
            } else if let contents = try? fm.contentsOfDirectory(at: dayDir, includingPropertiesForKeys: nil),
                      contents.isEmpty {
                // Clean up any day-dirs emptied by the in-memory pass pruning above.
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
