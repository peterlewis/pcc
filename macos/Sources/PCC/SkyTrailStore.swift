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
    /// Hard cap on a single pass's duration. The persisted time offset is a
    /// UInt16 (clamps at 65 535 s ≈ 18.2 h); a continuously-visible GEO/IGSO
    /// satellite would hit that clamp and then pile every further observation
    /// onto the same frozen timestamp — `endTime` stops being truthful and
    /// the pass (and its file) never ends. Passes are force-closed and
    /// chained at 12 h instead: comfortably under the clamp, far longer than
    /// any real LEO/MEO pass.
    static let maxPassDuration: TimeInterval = 43_200 // 12 h
    /// Cadence of the batched dirty-pass flush (see `flushDirtyPasses`).
    static let flushInterval: TimeInterval = 15
    private static let isLoggingKey = "SkyTrailStore.isLogging"
    /// Subdirectory of `passesDir` where undecodable pass files are
    /// quarantined (see `scanPasses`). Lives inside `passesDir` so `clear()`
    /// wipes it too; the load scan and prune sweep both skip it.
    private static let quarantineDirName = "unreadable"

    // MARK: Published state

    @Published var isLogging: Bool = false {
        didSet {
            UserDefaults.standard.set(isLogging, forKey: Self.isLoggingKey)
            // Stopping recording is a flush point for the batched pass
            // writes — the user's expectation when hitting Stop is that what
            // they recorded is on disk. (Init-time assignment doesn't run
            // didSet, so this never fires before the store is fully set up.)
            if !isLogging {
                flushDirtyPasses()
            }
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
    /// Passes awaiting a batched disk write, keyed by id so repeated appends
    /// to the same pass within a flush interval coalesce into one write
    /// (see `markDirty`). The value is the latest full snapshot to persist.
    private var dirtyPasses: [UUID: SatPass] = [:]
    private var flushTimer: Timer?
    private var pruneTimer: Timer?
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
        // Direct init-time assignment skips didSet (we prune explicitly below).
        retention = RetentionWindow.current
        // Load history off the main thread, then prune. Order matters: the
        // previous code pruned BEFORE loading, so the in-memory drop saw an
        // empty array and sub-day-expired passes survived until the next
        // sweep. Pruning in the load completion fixes that, and the periodic
        // timer below keeps a long-lived menu-bar process from accumulating
        // past its retention window between launches.
        loadPasses { [weak self] in
            self?.pruneOldPasses()
        }
        ensurePruneTimerRunning()
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            self?.flushActivePasses()
            // Synchronously drain pending writes so a clean quit loses none
            // of the batched (not-yet-flushed) observations.
            self?.flushDirtyPasses(wait: true)
        }
    }

    private func ensurePruneTimerRunning() {
        guard pruneTimer == nil else { return }
        let timer = Timer(timeInterval: 3_600, repeats: true) { [weak self] _ in
            self?.pruneOldPasses()
        }
        // `.common` so the sweep still fires while a menu/drag holds the main
        // run loop in event-tracking mode.
        RunLoop.main.add(timer, forMode: .common)
        pruneTimer = timer
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
            // Force-close and chain a fresh pass before this one reaches the
            // UInt16 `t` clamp. Without it a continuously-visible GEO/IGSO
            // satellite (or one kept alive indefinitely by the rejoin window)
            // would, past ~18 h, pile every further observation onto a frozen
            // maximum `t`: `endTime` would stop advancing, the time-window
            // filter would drop a still-live pass, and its file would grow
            // without bound. 12 h is far longer than any real LEO/MEO pass.
            if now.timeIntervalSince(entry.pass.startTime) >= Self.maxPassDuration {
                closePass(prn)
                startNewPass(prn: prn, az: az, el: el, snr: snr,
                             constellation: sat.constellation, at: now)
                return
            }
            entry.lastSeen = now
            if now.timeIntervalSince(entry.lastRecorded) >= Self.recordingInterval {
                let tOffset = UInt16(clamping: Int(now.timeIntervalSince(entry.pass.startTime)))
                entry.pass.observations.append(SatObservation(az: az, el: el, snr: snr, t: tOffset))
                entry.lastRecorded = now
                active[prn] = entry
                markDirty(entry.pass)   // batched durable write
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
            markDirty(revived)
        } else {
            startNewPass(prn: prn, az: az, el: el, snr: snr,
                         constellation: sat.constellation, at: now)
        }
    }

    /// Begins a fresh active pass for `prn` with its first observation at t=0.
    private func startNewPass(prn: String, az: Int16, el: Int8, snr: Int8,
                              constellation: SatConstellation, at now: Date) {
        let firstObs = SatObservation(az: az, el: el, snr: snr, t: 0)
        let pass = SatPass(id: UUID(), prn: prn, constellation: constellation,
                           startTime: now, observations: [firstObs])
        active[prn] = ActivePass(pass: pass, lastSeen: now, lastRecorded: now)
        markDirty(pass)            // persist from the first observation
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
        dirtyPasses.removeAll()          // discard pending writes — we're wiping the store
        horizonMask = Array(repeating: nil, count: 72)
        sectorHeatmap = Array(repeating: Array(repeating: nil, count: 18), count: 72)
        timeoutTimer?.invalidate()
        timeoutTimer = nil
        flushTimer?.invalidate()
        flushTimer = nil
        // Serialize the wipe behind any in-flight writes so a pending async
        // write/delete can't recreate a file under the freshly cleared dir.
        saveQueue.sync {
            try? FileManager.default.removeItem(at: passesDir)
            try? FileManager.default.createDirectory(at: passesDir, withIntermediateDirectories: true)
        }
    }

    // MARK: Persistence

    private func passFileURL(for pass: SatPass) -> URL {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withFullDate, .withDashSeparatorInDate]
        let dayKey = fmt.string(from: pass.startTime)
        let dayDir = passesDir.appendingPathComponent(dayKey)
        try? FileManager.default.createDirectory(at: dayDir, withIntermediateDirectories: true)
        return dayDir.appendingPathComponent("\(pass.id).pcc")
    }

    /// Marks a pass for persistence on the next batched flush rather than
    /// writing it immediately. The previous design re-encoded and atomically
    /// re-wrote a pass's ENTIRE file on every 6-second observation — for a
    /// 12 h pass that's thousands of whole-file rewrites of steadily growing
    /// data (hundreds-fold write amplification, and on a busy sky several
    /// writes per second across all tracked PRNs). Batching coalesces all of
    /// a pass's appends within `flushInterval` into a single write while
    /// keeping whole-file atomicity — so crash safety is unchanged (`.atomic`
    /// swaps the file in one rename; a torn write can never corrupt a pass).
    /// The only exposure is that up to `flushInterval` of the most recent
    /// observations are lost on a hard kill; a clean quit flushes synchronously
    /// (see the terminate observer) and Stop flushes too.
    private func markDirty(_ pass: SatPass) {
        dirtyPasses[pass.id] = pass
        ensureFlushTimerRunning()
    }

    private func ensureFlushTimerRunning() {
        guard flushTimer == nil else { return }
        let timer = Timer(timeInterval: Self.flushInterval, repeats: true) { [weak self] _ in
            self?.flushDirtyPasses()
        }
        // `.common` so flushing isn't starved while a menu/drag holds the main
        // run loop in event-tracking mode.
        RunLoop.main.add(timer, forMode: .common)
        flushTimer = timer
    }

    /// Writes every pending pass to disk. Runs on the flush timer, when
    /// recording stops, and at termination. Encoding is cheap and stays on
    /// the caller's (main) thread; the atomic writes go to the serial save
    /// queue. When `wait` is true (termination) we block on the queue so the
    /// data is durable before the process exits.
    private func flushDirtyPasses(wait: Bool = false) {
        let batch = dirtyPasses
        dirtyPasses.removeAll()
        for (_, pass) in batch {
            let url = passFileURL(for: pass)
            let data = pass.binaryEncoded()   // compact binary (~6× smaller than JSON)
            saveQueue.async {
                try? data.write(to: url, options: .atomic)
            }
        }
        // Stop the timer once nothing is pending and no pass is open — it
        // restarts on the next `markDirty`.
        if dirtyPasses.isEmpty && active.isEmpty {
            flushTimer?.invalidate()
            flushTimer = nil
        }
        if wait { saveQueue.sync {} }   // barrier: let queued writes complete
    }

    private func deletePassFile(_ pass: SatPass) {
        // Drop any pending write first so a just-deleted (e.g. sub-minimum)
        // pass can't be resurrected by the next flush.
        dirtyPasses.removeValue(forKey: pass.id)
        let url = passFileURL(for: pass)
        // Also clear any not-yet-migrated legacy JSON sibling.
        let legacy = url.deletingPathExtension().appendingPathExtension("json")
        saveQueue.async {
            try? FileManager.default.removeItem(at: url)
            try? FileManager.default.removeItem(at: legacy)
        }
    }

    /// Loads persisted passes off the main thread (a deep history with long
    /// retention can be thousands of files — decoding them synchronously in
    /// `init` would stall first paint), then hops back to main to publish the
    /// result and run `completion`. Any passes that arrived live during the
    /// load window are merged in by id rather than clobbered.
    private func loadPasses(completion: @escaping () -> Void) {
        saveQueue.async { [weak self] in
            guard let self else { return }
            let (loaded, mask, heat) = self.scanPassesFromDisk()
            DispatchQueue.main.async {
                // Merge by id: a pass closed live during the load window is
                // already in `self.passes`; keep whichever copy has more
                // observations so we never drop freshly recorded data.
                var byID: [UUID: SatPass] = [:]
                for p in loaded { byID[p.id] = p }
                for p in self.passes {
                    if let existing = byID[p.id] {
                        if p.observations.count > existing.observations.count { byID[p.id] = p }
                    } else {
                        byID[p.id] = p
                    }
                }
                self.passes = byID.values.sorted { $0.startTime > $1.startTime }
                self.mergeDerived(mask: mask, heat: heat)
                completion()
            }
        }
    }

    /// Disk scan + decode, safe to run off-main: touches only FileManager,
    /// the immutable `passesDir`, and static constants. Quarantines files it
    /// can't decode (so a schema change doesn't make them re-scanned forever
    /// or silently deleted), deletes sub-minimum stubs (a hard kill before a
    /// pass closes can leave 1–2-observation files that would otherwise reload
    /// as permanent ghost passes), and rebuilds the derived mask/heatmap.
    private func scanPassesFromDisk() -> (passes: [SatPass], mask: [Double?], heat: [[Int?]]) {
        let fm = FileManager.default
        let emptyMask = [Double?](repeating: nil, count: 72)
        let emptyHeat: [[Int?]] = Array(repeating: Array(repeating: nil, count: 18), count: 72)
        guard let dayDirs = try? fm.contentsOfDirectory(at: passesDir, includingPropertiesForKeys: nil) else {
            return ([], emptyMask, emptyHeat)
        }
        let quarantineDir = passesDir.appendingPathComponent(Self.quarantineDirName, isDirectory: true)
        var loaded: [SatPass] = []
        for dayDir in dayDirs where dayDir.lastPathComponent != Self.quarantineDirName {
            guard let files = try? fm.contentsOfDirectory(at: dayDir, includingPropertiesForKeys: nil) else { continue }
            // Ids already present as binary, so a legacy JSON sibling can be
            // dropped without re-migrating (e.g. after a crash mid-migration).
            let binIds = Set(files.filter { $0.pathExtension == "pcc" }
                .map { $0.deletingPathExtension().lastPathComponent })
            for file in files {
                switch file.pathExtension {
                case "pcc":
                    guard let data = try? Data(contentsOf: file) else { continue }
                    guard let pass = SatPass(binary: data) else {
                        quarantineFile(file, into: quarantineDir, fm: fm)
                        continue
                    }
                    guard pass.observations.count >= Self.minObservations else {
                        try? fm.removeItem(at: file)
                        continue
                    }
                    loaded.append(pass)
                case "json":
                    // Legacy format: decode, write the compact binary sibling,
                    // then drop the JSON. Binary is written BEFORE the JSON is
                    // removed, so a crash mid-migration leaves the JSON intact
                    // to retry; if both exist, the binary wins (handled above)
                    // and the redundant JSON is discarded here.
                    let id = file.deletingPathExtension().lastPathComponent
                    if binIds.contains(id) { try? fm.removeItem(at: file); continue }
                    guard let data = try? Data(contentsOf: file) else { continue }
                    guard let pass = try? JSONDecoder().decode(SatPass.self, from: data) else {
                        quarantineFile(file, into: quarantineDir, fm: fm)
                        continue
                    }
                    guard pass.observations.count >= Self.minObservations else {
                        try? fm.removeItem(at: file)
                        continue
                    }
                    let binURL = file.deletingPathExtension().appendingPathExtension("pcc")
                    try? pass.binaryEncoded().write(to: binURL, options: .atomic)
                    try? fm.removeItem(at: file)
                    loaded.append(pass)
                default:
                    continue
                }
            }
        }

        var mask = emptyMask
        var heat = emptyHeat
        for pass in loaded {
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
        return (loaded.sorted { $0.startTime > $1.startTime }, mask, heat)
    }

    /// Moves an undecodable pass file into the quarantine subdirectory so it
    /// stops being re-read on every launch, without destroying it (it may be
    /// useful for diagnosing a schema regression).
    private func quarantineFile(_ file: URL, into dir: URL, fm: FileManager) {
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(file.lastPathComponent)
        try? fm.removeItem(at: dest)
        try? fm.moveItem(at: file, to: dest)
    }

    /// Folds disk-derived mask/heatmap into whatever live observations have
    /// already populated (min elevation per sector, max SNR per cell) so the
    /// async load doesn't wipe data recorded during the load window.
    private func mergeDerived(mask: [Double?], heat: [[Int?]]) {
        for i in 0..<min(horizonMask.count, mask.count) {
            if let m = mask[i] {
                let current = horizonMask[i] ?? 90
                if m < current { horizonMask[i] = m }
            }
        }
        for a in 0..<min(sectorHeatmap.count, heat.count) {
            for e in 0..<min(sectorHeatmap[a].count, heat[a].count) {
                if let h = heat[a][e] {
                    let current = sectorHeatmap[a][e] ?? 0
                    if h > current { sectorHeatmap[a][e] = h }
                }
            }
        }
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
        // Day directories are named with a UTC date (`passFileURL`'s ISO8601
        // formatter defaults to UTC), so the cutoff day must be UTC too. The
        // previous local-calendar `startOfDay` could, in a timezone offset
        // from UTC, delete a whole day directory whose passes were still
        // inside the retention window (over-deletion by up to the tz offset
        // plus a pass duration).
        var utcCal = Calendar(identifier: .gregorian)
        utcCal.timeZone = TimeZone(secondsFromGMT: 0) ?? utcCal.timeZone
        let cutoffDay = utcCal.startOfDay(for: cutoff)
        let fm = FileManager.default
        guard let dayDirs = try? fm.contentsOfDirectory(at: passesDir, includingPropertiesForKeys: nil) else { return }
        for dayDir in dayDirs where dayDir.lastPathComponent != Self.quarantineDirName {
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
