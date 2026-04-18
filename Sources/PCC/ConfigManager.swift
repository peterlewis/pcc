import Foundation
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

    var clockMounted: Bool {
        FileManager.default.fileExists(atPath: Self.configPath)
    }

    // MARK: - Read

    func load() {
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
        return save()
    }

    // MARK: - Local Backups

    private func stashLocalBackup(_ text: String) {
        let fm = FileManager.default
        let dir = Self.backupDir
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

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
