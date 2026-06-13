import Foundation

struct FirmwareInfo {
    let buildDate: String
    let version: String

    static func read(from url: URL) -> FirmwareInfo? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { handle.closeFile() }

        let fileSize = handle.seekToEndOfFile()
        guard fileSize >= 64 else { return nil }
        handle.seek(toFileOffset: fileSize - 64)
        let tailData = handle.readData(ofLength: 64)

        // Keep only printable ASCII — firmware images have null padding and a binary CRC tail
        let cleaned = tailData.filter { $0 >= 0x20 && $0 < 0x7F }
        guard let tail = String(bytes: cleaned, encoding: .ascii), tail.contains("Build") else { return nil }

        // Parse "Build YYYY-MM-DDTHH:MM:SS Version X.X.X "
        var buildDate = ""
        var version = ""
        if let buildRange = tail.range(of: "Build ") {
            let after = tail[buildRange.upperBound...]
            buildDate = String(after.prefix(19))
        }
        if let verRange = tail.range(of: "Version ") {
            let after = tail[verRange.upperBound...]
            version = String(after.prefix(while: { $0 != " " && $0 != "\0" }))
        }
        return FirmwareInfo(buildDate: buildDate, version: version)
    }
}

struct ReleaseInfo {
    let tag: String
    let notes: String
    let zipURL: URL
    let fwtBuild: String
    let fwdBuild: String
    let tzVersion: String
}

/// Install-time failure with a user-facing message. UpdateManager surfaces
/// errors to the UI via `localizedDescription`, so the message IS the UI
/// string — each one carries the remediation, not just the diagnosis.
private struct InstallError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

class UpdateManager: ObservableObject {
    @Published var latestRelease: ReleaseInfo?
    @Published var installedFWT: FirmwareInfo?
    @Published var installedFWD: FirmwareInfo?
    @Published var installedTZDate: Date?
    @Published var clockMounted = false
    @Published var isChecking = false
    @Published var isInstalling = false
    @Published var installProgress = ""
    @Published var error: String?

    private static let clockVolume = "/Volumes/CLOCK"
    private static let apiURL = "https://api.github.com/repos/mitxela/clock4/releases/latest"

    func refresh() {
        checkClockMounted()
        if clockMounted {
            readInstalledVersions()
        }
    }

    func checkClockMounted() {
        clockMounted = FileManager.default.fileExists(atPath: Self.clockVolume)
    }

    func readInstalledVersions() {
        let vol = URL(fileURLWithPath: Self.clockVolume)
        installedFWT = FirmwareInfo.read(from: vol.appendingPathComponent("fwt.bin"))
        installedFWD = FirmwareInfo.read(from: vol.appendingPathComponent("fwd.bin"))

        if let attrs = try? FileManager.default.attributesOfItem(atPath: vol.appendingPathComponent("tzrules.bin").path),
           let modDate = attrs[.modificationDate] as? Date {
            installedTZDate = modDate
        }
    }

    func checkForUpdates() {
        isChecking = true
        error = nil
        // Static string, parses in practice — but avoid the force-unwrap so
        // a future edit that breaks the literal can't ship a crash to users.
        guard let apiURL = URL(string: Self.apiURL) else {
            error = "Invalid update API URL"
            isChecking = false
            return
        }
        Task {
            do {
                var req = URLRequest(url: apiURL)
                req.timeoutInterval = 15
                let (data, _) = try await URLSession.shared.data(for: req)
                guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let tag = json["tag_name"] as? String,
                      let body = json["body"] as? String,
                      let assets = json["assets"] as? [[String: Any]],
                      let zipAsset = assets.first(where: { ($0["name"] as? String)?.hasSuffix(".zip") == true }),
                      let urlStr = zipAsset["browser_download_url"] as? String,
                      let zipURL = URL(string: urlStr) else {
                    await MainActor.run {
                        self.error = "Could not parse release info"
                        self.isChecking = false
                    }
                    return
                }

                // Parse firmware build info from release notes
                var fwtBuild = ""
                var fwdBuild = ""
                var tzVer = ""
                for line in body.components(separatedBy: "\n") {
                    if line.contains("`fwt`") { fwtBuild = extractBacktickValue(line) }
                    if line.contains("`fwd`") { fwdBuild = extractBacktickValue(line) }
                    if line.contains("`tzmap`") || line.contains("`tzrules`") { tzVer = extractBacktickValue(line) }
                }

                let release = ReleaseInfo(tag: tag, notes: body, zipURL: zipURL,
                                          fwtBuild: fwtBuild, fwdBuild: fwdBuild, tzVersion: tzVer)
                await MainActor.run {
                    self.latestRelease = release
                    self.isChecking = false
                }
            } catch {
                await MainActor.run {
                    self.error = error.localizedDescription
                    self.isChecking = false
                }
            }
        }
    }

    func installUpdate(firmware: Bool, timezone: Bool) {
        guard let release = latestRelease else { return }
        isInstalling = true
        installProgress = "Downloading..."
        error = nil

        Task {
            do {
                var dlReq = URLRequest(url: release.zipURL)
                dlReq.timeoutInterval = 60
                let (zipData, _) = try await URLSession.shared.data(for: dlReq)

                let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: tmpDir) }

                let zipPath = tmpDir.appendingPathComponent("release.zip")
                try zipData.write(to: zipPath)

                await MainActor.run { self.installProgress = "Extracting..." }

                let unzip = Process()
                unzip.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
                unzip.arguments = ["-o", zipPath.path, "-d", tmpDir.path]
                unzip.standardOutput = nil
                unzip.standardError = nil
                try unzip.run()
                unzip.waitUntilExit()
                // A damaged archive still "extracts" whatever it can; unzip
                // only reports the breakage via its exit status. Ignoring it
                // used to let a truncated download fall through to the copy
                // step and install half a release with a green "Done.".
                guard unzip.terminationStatus == 0 else {
                    throw InstallError("Extracting the release archive failed (unzip exit code \(unzip.terminationStatus)). The download may be corrupt — try again.")
                }

                // Extraction/copy design note: the fixed-name scheme below
                // IS the zip-slip protection. Only flash/{fwt,fwd,tzrules,
                // tzmap}.bin are ever read out of the extraction directory,
                // each addressed by an exact path we construct ourselves —
                // no filename from inside the archive is ever enumerated or
                // trusted. Don't "simplify" this into copying the whole
                // extracted folder onto the clock.
                let flashDir = tmpDir.appendingPathComponent("flash")
                let clockVol = URL(fileURLWithPath: Self.clockVolume)

                // Validate everything BEFORE writing anything. fwt/fwd are
                // two halves of one firmware build (and tzrules/tzmap of one
                // tzdb build): the old "skip whatever's missing" loop could
                // overwrite one half, leave the other stale, and still
                // report success — a mismatched pair is worse for the clock
                // than not installing at all.
                if firmware { try Self.validateFirmwarePair(in: flashDir) }
                if timezone { try Self.validateTimezonePair(in: flashDir) }

                if firmware {
                    await MainActor.run { self.installProgress = "Copying firmware (this may be slow)..." }
                    for file in ["fwt.bin", "fwd.bin"] {
                        try Self.copyVerified(flashDir.appendingPathComponent(file),
                                              to: clockVol.appendingPathComponent(file))
                    }
                }

                if timezone {
                    await MainActor.run { self.installProgress = "Copying timezone data (this may be slow)..." }
                    for file in ["tzrules.bin", "tzmap.bin"] {
                        try Self.copyVerified(flashDir.appendingPathComponent(file),
                                              to: clockVol.appendingPathComponent(file))
                    }
                }

                // Eject via diskutil — this issues a SCSI STOP UNIT to the
                // mass-storage device, which forces macOS to flush any
                // buffered writes before the volume unmounts. Relying on
                // the user to pull the cable (or on the clock's `reboot`
                // serial command) can truncate the last few kB of the
                // firmware image if the cache hasn't been committed yet,
                // which mitxela flagged as a real-world cause of bricked
                // updates. On failure we fall through to the old advisory
                // message rather than hard-erroring: the files were copied
                // successfully, the user just needs to eject manually.
                await MainActor.run { self.installProgress = "Ejecting CLOCK volume…" }
                let ejected = Self.ejectClockVolume()

                await MainActor.run {
                    self.installProgress = ejected
                        ? "Done. Clock ejected — reconnect to apply."
                        : "Done. Eject or reconnect the clock to apply."
                    self.isInstalling = false
                    // The eject usually just unmounted the volume: re-check
                    // before reading versions so we don't parse a dead path
                    // while `clockMounted` (and the live Install buttons)
                    // stay stale-true until the next manual refresh.
                    self.checkClockMounted()
                    if self.clockMounted {
                        self.readInstalledVersions()
                    }
                }
            } catch {
                await MainActor.run {
                    self.error = error.localizedDescription
                    self.isInstalling = false
                    self.installProgress = ""
                }
            }
        }
    }

    /// Pre-flight for a firmware install: both halves must be present in the
    /// extracted archive AND parse as firmware (the "Build … Version …" tail
    /// FirmwareInfo reads must be intact) before we overwrite EITHER on the
    /// clock. Throws with a message naming the offending file.
    private static func validateFirmwarePair(in flashDir: URL) throws {
        for name in ["fwt.bin", "fwd.bin"] {
            let url = flashDir.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw InstallError("Release archive is missing flash/\(name) — firmware not installed.")
            }
            guard FirmwareInfo.read(from: url) != nil else {
                throw InstallError("flash/\(name) in the release archive doesn't parse as firmware (no build/version tail) — the download may be corrupt. Firmware not installed.")
            }
        }
    }

    /// Same all-or-nothing pre-flight for the timezone pair. tzrules/tzmap
    /// carry no parseable version tail, so presence is the strongest check
    /// available before copying.
    private static func validateTimezonePair(in flashDir: URL) throws {
        for name in ["tzrules.bin", "tzmap.bin"] {
            let url = flashDir.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw InstallError("Release archive is missing flash/\(name) — timezone data not installed.")
            }
        }
    }

    /// Copy one file onto the clock and read it straight back to confirm
    /// the bytes actually landed. The CLOCK volume is a microcontroller
    /// emulating USB mass storage, and writes there can fail silently —
    /// `copyItem` returning is no guarantee the flash holds the image.
    /// `contentsEqual` does a full byte-compare of source vs destination.
    /// The mismatch message matters: with a half-written firmware image the
    /// one thing the user must NOT do is power-cycle the clock.
    private static func copyVerified(_ src: URL, to dst: URL) throws {
        if FileManager.default.fileExists(atPath: dst.path) {
            try FileManager.default.removeItem(at: dst)
        }
        try FileManager.default.copyItem(at: src, to: dst)
        guard FileManager.default.contentsEqual(atPath: src.path, andPath: dst.path) else {
            throw InstallError("Verification failed: \(dst.lastPathComponent) on the clock doesn't match the downloaded copy. Do not power-cycle the clock — retry the install.")
        }
    }

    /// Ejects `/Volumes/CLOCK` via `diskutil eject`, which flushes the
    /// mass-storage write cache (SCSI STOP UNIT) before unmounting. Returns
    /// `true` if the volume is gone afterwards. Callers treat a `false`
    /// return as non-fatal — the files are already on disk, eject is just a
    /// courtesy so the user doesn't have to do it manually.
    private static func ejectClockVolume() -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/diskutil")
        task.arguments = ["eject", clockVolume]
        task.standardOutput = nil
        task.standardError = nil
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            return false
        }
        return !FileManager.default.fileExists(atPath: clockVolume)
    }

    private func extractBacktickValue(_ line: String) -> String {
        // Extract the last backtick-enclosed value: `key` is `value` or `a` and `b` are `value`
        let parts = line.components(separatedBy: "`")
        // Odd-indexed parts are inside backticks; take the last one
        if parts.count >= 4, let last = parts.dropFirst().enumerated().filter({ $0.offset % 2 == 0 }).last {
            return last.element.trimmingCharacters(in: .whitespaces)
        }
        return ""
    }
}
