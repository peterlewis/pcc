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
        guard let tail = String(data: tailData, encoding: .ascii) else { return nil }

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
        Task {
            do {
                let (data, _) = try await URLSession.shared.data(from: URL(string: Self.apiURL)!)
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
                let (zipData, _) = try await URLSession.shared.data(from: release.zipURL)

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

                let flashDir = tmpDir.appendingPathComponent("flash")
                let clockVol = URL(fileURLWithPath: Self.clockVolume)

                if firmware {
                    await MainActor.run { self.installProgress = "Copying firmware (this may be slow)..." }
                    for file in ["fwt.bin", "fwd.bin"] {
                        let src = flashDir.appendingPathComponent(file)
                        let dst = clockVol.appendingPathComponent(file)
                        if FileManager.default.fileExists(atPath: src.path) {
                            try? FileManager.default.removeItem(at: dst)
                            try FileManager.default.copyItem(at: src, to: dst)
                        }
                    }
                }

                if timezone {
                    await MainActor.run { self.installProgress = "Copying timezone data (this may be slow)..." }
                    for file in ["tzrules.bin", "tzmap.bin"] {
                        let src = flashDir.appendingPathComponent(file)
                        let dst = clockVol.appendingPathComponent(file)
                        if FileManager.default.fileExists(atPath: src.path) {
                            try? FileManager.default.removeItem(at: dst)
                            try FileManager.default.copyItem(at: src, to: dst)
                        }
                    }
                }

                await MainActor.run {
                    self.installProgress = "Done. Eject or reconnect the clock to apply."
                    self.isInstalling = false
                    self.readInstalledVersions()
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

    private func extractBacktickValue(_ line: String) -> String {
        // Extract value between second pair of backticks: `fwt` is `Build ...`
        let parts = line.components(separatedBy: "`")
        if parts.count >= 4 {
            return parts[3].trimmingCharacters(in: .whitespaces)
        }
        return ""
    }
}
