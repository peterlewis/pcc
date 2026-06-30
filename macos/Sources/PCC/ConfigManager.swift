import Foundation
import AppKit
import Combine

/// Manages reading, parsing, and writing config.txt from the CLOCK USB volume.
/// Preserves comments and formatting when writing back.
class ConfigManager: ObservableObject {
    @Published var rawText: String = ""
    @Published var values: [String: String] = [:]  // case-preserved keys → values
    @Published var isLoaded = false
    @Published var isDirty = false
    @Published var error: String?
    @Published var hasPreviousConfig = false
    @Published var configCorrupted = false

    private var lines: [ConfigLine] = []
    private var sessionSaveCount = 0

    static let configPath = "/Volumes/CLOCK/config.txt"

    private static var backupDir: URL {
        // Same defensive fallback as SkyTrailStore: on a normal install this
        // resolves to `~/Library/Application Support/PCC/config-backups`,
        // but rather than crashing if the search path is ever empty we
        // degrade to the temp dir (backups are a safety net, not critical
        // state).
        let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return appSupport.appendingPathComponent("PCC/config-backups")
    }
    private static let maxBackups = 10

    /// Represents a single line in config.txt, preserving structure for round-trip editing.
    struct ConfigLine {
        enum Kind {
            case comment(String)       // Full line including #
            case blank                 // Empty line
            case keyValue(key: String, value: String, commented: Bool)
        }
        var kind: Kind
        var originalText: String
    }

    /// Published (not computed per-access) so views react when the volume
    /// comes and goes; kept in sync by the workspace mount notifications.
    @Published var clockMounted = false

    /// Tokens for the NSWorkspace volume observers, removed in deinit.
    private var volumeObservers: [NSObjectProtocol] = []

    init() {
        clockMounted = FileManager.default.fileExists(atPath: Self.configPath)

        // load() runs once at launch, but every panel's Save is gated on
        // clockMounted, not isLoaded. Re-loading whenever the CLOCK volume
        // mounts makes that gate self-healing: launch without the clock,
        // plug it in later, and the panels save against the freshly read
        // device config instead of being refused (or, before save() grew
        // its isLoaded guard, rewriting config.txt from one panel's keys).
        let center = NSWorkspace.shared.notificationCenter
        volumeObservers.append(center.addObserver(
            forName: NSWorkspace.didMountNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.volumesDidChange()
        })
        volumeObservers.append(center.addObserver(
            forName: NSWorkspace.didUnmountNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.volumesDidChange()
        })
    }

    deinit {
        let center = NSWorkspace.shared.notificationCenter
        volumeObservers.forEach { center.removeObserver($0) }
    }

    /// Re-sync `clockMounted` after any volume mounts or unmounts. Keying off
    /// the config path (rather than parsing the volume name out of the
    /// notification's userInfo) also covers renamed or symlinked volumes.
    private func volumesDidChange() {
        let present = FileManager.default.fileExists(atPath: Self.configPath)
        let appeared = present && !clockMounted
        clockMounted = present
        // Re-read on every (re)appearance — the user may have plugged in a
        // different clock, or edited config.txt on another machine.
        if appeared { load() }
    }

    // MARK: - Read

    func load() {
        // Refresh the cached mount state so a direct call (e.g. at launch)
        // can't act on a stale value from before a notification arrived.
        clockMounted = FileManager.default.fileExists(atPath: Self.configPath)
        guard clockMounted else {
            error = "CLOCK volume not mounted"
            isLoaded = false
            return
        }
        do {
            let text = try String(contentsOfFile: Self.configPath, encoding: .utf8)
            if isConfigValid(text) {
                rawText = text
                parse(text)
                isLoaded = true
                isDirty = false
                error = nil
                configCorrupted = false
                stashLocalBackup(text)
            } else {
                // Config is corrupted (0 bytes, whitespace-only, etc.)
                configCorrupted = true
                isLoaded = false
                error = "config.txt appears corrupted (\(text.count) bytes)"
            }
        } catch {
            self.error = error.localizedDescription
            isLoaded = false
        }
    }

    private func isConfigValid(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty
    }

    private func parse(_ text: String) {
        lines = []
        values = [:]
        for rawLine in text.components(separatedBy: "\n") {
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                lines.append(ConfigLine(kind: .blank, originalText: rawLine))
            } else if trimmed.hasPrefix("#") {
                // Check if it's a commented-out key=value (e.g. #ZONE_OVERRIDE = ...)
                let afterHash = String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)
                if let (key, value) = parseKeyValue(afterHash) {
                    lines.append(ConfigLine(kind: .keyValue(key: key, value: value, commented: true),
                                            originalText: rawLine))
                } else {
                    lines.append(ConfigLine(kind: .comment(rawLine), originalText: rawLine))
                }
            } else if let (key, value) = parseKeyValue(trimmed) {
                lines.append(ConfigLine(kind: .keyValue(key: key, value: value, commented: false),
                                        originalText: rawLine))
                values[key] = value
            } else {
                lines.append(ConfigLine(kind: .comment(rawLine), originalText: rawLine))
            }
        }
    }

    private func parseKeyValue(_ text: String) -> (String, String)? {
        guard let eqRange = text.range(of: "=") else { return nil }
        let key = text[..<eqRange.lowerBound].trimmingCharacters(in: .whitespaces)
        let value = text[eqRange.upperBound...].trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty, key.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
        return (key, value)
    }

    // MARK: - Modify

    /// Update a value in the parsed config. If the key exists (even commented out), update it.
    /// If commented out, uncomment it. If the key doesn't exist, append it.
    func setValue(_ key: String, to value: String) {
        // Find existing line (prefer uncommented, fall back to commented)
        if let idx = lines.firstIndex(where: {
            if case .keyValue(let k, _, let commented) = $0.kind { return k.caseInsensitiveCompare(key) == .orderedSame && !commented }
            return false
        }) {
            lines[idx] = ConfigLine(kind: .keyValue(key: key, value: value, commented: false),
                                    originalText: "\(key) = \(value)")
        } else if let idx = lines.firstIndex(where: {
            if case .keyValue(let k, _, let commented) = $0.kind { return k.caseInsensitiveCompare(key) == .orderedSame && commented }
            return false
        }) {
            lines[idx] = ConfigLine(kind: .keyValue(key: key, value: value, commented: false),
                                    originalText: "\(key) = \(value)")
        } else {
            lines.append(ConfigLine(kind: .keyValue(key: key, value: value, commented: false),
                                    originalText: "\(key) = \(value)"))
        }
        values[key] = value
        isDirty = true
        rebuildRawText()
    }

    /// Comment out a key (effectively disabling it).
    func commentOut(_ key: String) {
        if let idx = lines.firstIndex(where: {
            if case .keyValue(let k, _, let commented) = $0.kind { return k.caseInsensitiveCompare(key) == .orderedSame && !commented }
            return false
        }) {
            if case .keyValue(let k, let v, _) = lines[idx].kind {
                lines[idx] = ConfigLine(kind: .keyValue(key: k, value: v, commented: true),
                                        originalText: "#\(k) = \(v)")
            }
        }
        values.removeValue(forKey: key)
        isDirty = true
        rebuildRawText()
    }

    private func rebuildRawText() {
        rawText = lines.map { line in
            switch line.kind {
            case .comment(let text): return text
            case .blank: return ""
            case .keyValue(let key, let value, let commented):
                return commented ? "#\(key) = \(value)" : "\(key) = \(value)"
            }
        }.joined(separator: "\n")
    }

    // MARK: - Write

    func save() -> Bool {
        guard clockMounted else {
            error = "CLOCK volume not mounted"
            return false
        }
        // Never write a config that was never successfully read: the panels'
        // Save buttons gate on clockMounted (a live mount check), so without
        // this a launch-without-clock → plug in → Save would rebuild
        // config.txt from that one panel's keys alone, wiping every other
        // device setting. The mount observer re-load()s when the volume
        // appears, so a healthy clock passes this guard by the time the user
        // can click Save.
        guard isLoaded else {
            error = "config.txt has not been read from the clock yet — refusing to overwrite it"
            return false
        }
        do {
            // Stash current on-disk config locally before overwriting
            let onDisk = try? String(contentsOfFile: Self.configPath, encoding: .utf8)
            if let onDisk, isConfigValid(onDisk) {
                stashLocalBackup(onDisk)
            }
            try rawText.write(toFile: Self.configPath, atomically: true, encoding: .utf8)
            sessionSaveCount += 1
            hasPreviousConfig = true
            isDirty = false
            error = nil
            // The on-disk file is now whatever we just wrote, so recompute
            // the corruption flag from it — pasting a good config into the
            // raw editor recovers from corruption without a re-load().
            configCorrupted = !isConfigValid(rawText)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Restore the most recent local backup to config.txt.
    func restorePrevious() -> Bool {
        guard clockMounted else { return false }
        guard let backup = localBackups().last else { return false }
        do {
            let text = try String(contentsOf: backup, encoding: .utf8)
            guard isConfigValid(text) else { return false }
            rawText = text
            parse(text)
            try rawText.write(toFile: Self.configPath, atomically: true, encoding: .utf8)
            // Remove the backup we just restored so the next undo goes further back
            try? FileManager.default.removeItem(at: backup)
            sessionSaveCount = max(0, sessionSaveCount - 1)
            hasPreviousConfig = sessionSaveCount > 0
            configCorrupted = false
            isLoaded = true
            isDirty = false
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Save from raw text (used by the raw editor).
    func saveRaw(_ text: String) -> Bool {
        rawText = text
        parse(text)
        // The raw editor supplies the complete file contents the user can
        // see, so the partial-rewrite hazard save()'s isLoaded guard exists
        // for doesn't apply — and this must keep working when load() failed
        // (e.g. corrupted config.txt) because pasting a known-good config
        // into the editor is the manual recovery path.
        isLoaded = true
        return save()
    }

    // MARK: - Local Backups

    private func stashLocalBackup(_ text: String) {
        let fm = FileManager.default
        let dir = Self.backupDir
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        // Skip the stash when nothing changed: load() stashes on every
        // launch, so without this check ten no-edit launches would rotate
        // every meaningful pre-edit backup out of the maxBackups window in
        // favour of identical copies (and two stashes within the same second
        // would silently overwrite each other — the timestamp below has
        // one-second resolution).
        if let newest = localBackups().last,
           let existing = try? String(contentsOf: newest, encoding: .utf8),
           existing == text {
            return
        }

        let timestamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let file = dir.appendingPathComponent("config-\(timestamp).txt")
        try? text.write(to: file, atomically: true, encoding: .utf8)

        pruneBackups()
    }

    /// Returns local backups sorted oldest-first (last = most recent).
    func localBackups() -> [URL] {
        let fm = FileManager.default
        let dir = Self.backupDir
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey],
                                                       options: .skipsHiddenFiles) else { return [] }
        return files
            .filter { $0.pathExtension == "txt" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private func pruneBackups() {
        let backups = localBackups()
        guard backups.count > Self.maxBackups else { return }
        let toRemove = backups.prefix(backups.count - Self.maxBackups)
        for file in toRemove {
            try? FileManager.default.removeItem(at: file)
        }
    }

    // MARK: - Convenience getters

    func bool(forKey key: String) -> Bool? {
        guard let v = value(forKey: key)?.lowercased() else { return nil }
        switch v {
        case "1", "on", "enabled": return true
        case "0", "off", "disabled": return false
        default: return nil
        }
    }

    func value(forKey key: String) -> String? {
        values.first(where: { $0.key.caseInsensitiveCompare(key) == .orderedSame })?.value
    }

    func intPair(forKey key: String) -> (Int, Int)? {
        guard let v = value(forKey: key) else { return nil }
        let parts = v.components(separatedBy: ",")
        guard parts.count == 2,
              let a = Int(parts[0].trimmingCharacters(in: .whitespaces)),
              let b = Int(parts[1].trimmingCharacters(in: .whitespaces)) else { return nil }
        return (a, b)
    }
}
