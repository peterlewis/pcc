import Foundation
import AppKit

// MARK: - Model

enum DataSourceType: String, Codable, CaseIterable, Identifiable {
    case restAPI = "REST API"
    case bashCommand = "Bash Command"
    var id: String { rawValue }
}

struct DataSource: Codable, Identifiable {
    var id: UUID
    var name: String
    var type: DataSourceType
    var endpoint: String          // URL for REST, shell command for bash
    var jsonKeyPath: String       // dot-separated path to extract from JSON response (REST only)
    var displayFormat: String     // e.g. "{v} stars" — {v} is replaced with the value
    var headers: String           // HTTP headers for REST, one per line as "Key: Value"
    var pollInterval: TimeInterval
    var isEnabled: Bool

    init(id: UUID = UUID(), name: String = "", type: DataSourceType = .restAPI,
         endpoint: String = "", jsonKeyPath: String = "", displayFormat: String = "",
         headers: String = "", pollInterval: TimeInterval = 60, isEnabled: Bool = true) {
        self.id = id
        self.name = name
        self.type = type
        self.endpoint = endpoint
        self.jsonKeyPath = jsonKeyPath
        self.displayFormat = displayFormat
        self.headers = headers
        self.pollInterval = pollInterval
        self.isEnabled = isEnabled
    }

    /// Parse the headers string into key-value pairs.
    var parsedHeaders: [(String, String)] {
        headers.components(separatedBy: .newlines).compactMap { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty,
                  let colonIndex = trimmed.firstIndex(of: ":") else { return nil }
            let key = trimmed[trimmed.startIndex..<colonIndex].trimmingCharacters(in: .whitespaces)
            let value = trimmed[trimmed.index(after: colonIndex)...].trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { return nil }
            return (key, value)
        }
    }
}

// MARK: - Manager

class DataSourceManager: NSObject, ObservableObject {
    @Published var dataSources: [DataSource] = []
    @Published var lastValues: [UUID: String] = [:]
    @Published var lastErrors: [UUID: String] = [:]
    @Published var isActive: Bool = false
    @Published var rotationInterval: TimeInterval = 10
    @Published var currentSourceIndex: Int = 0

    weak var serialManager: SerialManager?
    private var pollTimers: [UUID: Timer] = [:]
    private var rotationTimer: Timer?

    var enabledSources: [DataSource] {
        dataSources.filter { $0.isEnabled }
    }

    var currentDisplayedSource: DataSource? {
        let sources = enabledSources
        guard isActive, !sources.isEmpty else { return nil }
        return sources[currentSourceIndex % sources.count]
    }

    override init() {
        super.init()
        load()
        NotificationCenter.default.addObserver(
            self, selector: #selector(appWillTerminate),
            name: NSApplication.willTerminateNotification, object: nil)
    }

    @objc private func appWillTerminate() {
        stopAll()
    }

    /// Called after serialManager is wired up
    func activate() {
        if isActive { startAll() }
    }

    // MARK: Enable / disable

    /// Re-take the display when data sources are running but another mode overrode them.
    func resumeDisplay() {
        guard isActive, let sm = serialManager,
              let source = currentDisplayedSource,
              let value = lastValues[source.id] else { return }
        sm.activateDisplayMode(.dataSource)
        sm.sendCommand("mode_text = 1")
        sm.sendScrollingText(value)
    }

    func setEnabled(_ enabled: Bool) {
        isActive = enabled
        save()
        if enabled {
            startAll()
        } else {
            stopAll()
            if serialManager?.activeDisplayMode == .dataSource {
                serialManager?.activateDisplayMode(.none)
            }
        }
    }

    func setRotationInterval(_ interval: TimeInterval) {
        rotationInterval = interval
        save()
        if isActive { restartRotation() }
    }

    // MARK: CRUD

    func addSource(_ source: DataSource) {
        dataSources.append(source)
        save()
        if isActive && source.isEnabled {
            startPolling(for: source.id)
            restartRotation()
        }
    }

    func updateSource(_ source: DataSource) {
        guard let i = dataSources.firstIndex(where: { $0.id == source.id }) else { return }
        dataSources[i] = source
        save()
        stopPolling(for: source.id)
        if isActive && source.isEnabled {
            startPolling(for: source.id)
        }
        restartRotation()
    }

    func deleteSource(id: UUID) {
        stopPolling(for: id)
        dataSources.removeAll { $0.id == id }
        lastValues.removeValue(forKey: id)
        lastErrors.removeValue(forKey: id)
        // Remove the source's Keychain item too, or the deleted source's
        // token would linger in the Keychain forever.
        try? KeychainHelper.delete(forKey: Self.headersKeychainKey(for: id))
        save()
        if isActive { restartRotation() }
    }

    // MARK: Polling

    private func startAll() {
        for source in enabledSources {
            startPolling(for: source.id)
        }
        restartRotation()
    }

    func stopAll() {
        pollTimers.values.forEach { $0.invalidate() }
        pollTimers.removeAll()
        rotationTimer?.invalidate()
        rotationTimer = nil
        serialManager?.stopScrolling()
    }

    private func startPolling(for id: UUID) {
        guard let source = dataSources.first(where: { $0.id == id }) else { return }
        stopPolling(for: id)
        fetchValue(for: id)
        // Registered in .common (not scheduledTimer's .default-only) so
        // polling keeps firing while the status-bar menu is open or a modal
        // runs — .default-mode timers are suspended during menu/event
        // tracking, freezing updates exactly when the user is looking.
        let timer = Timer(timeInterval: source.pollInterval, repeats: true) { [weak self] _ in
            self?.fetchValue(for: id)
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimers[id] = timer
    }

    private func stopPolling(for id: UUID) {
        pollTimers[id]?.invalidate()
        pollTimers.removeValue(forKey: id)
    }

    // MARK: Rotation

    private func restartRotation() {
        rotationTimer?.invalidate()
        rotationTimer = nil

        let sources = enabledSources
        guard !sources.isEmpty else {
            if serialManager?.activeDisplayMode == .dataSource {
                serialManager?.activateDisplayMode(.none)
            }
            return
        }

        currentSourceIndex = currentSourceIndex % sources.count
        displayCurrentSource()

        guard sources.count > 1 else { return }
        // .common mode for the same reason as the poll timers above: rotation
        // must not stall while the menu is being tracked.
        let timer = Timer(timeInterval: rotationInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            let sources = self.enabledSources
            guard !sources.isEmpty else { return }
            self.currentSourceIndex = (self.currentSourceIndex + 1) % sources.count
            self.displayCurrentSource()
        }
        RunLoop.main.add(timer, forMode: .common)
        rotationTimer = timer
    }

    private func displayCurrentSource() {
        guard let source = currentDisplayedSource else { return }
        if let value = lastValues[source.id] {
            sendToDisplay(value)
        }
    }

    // MARK: Fetching

    func fetchValue(for id: UUID) {
        guard let source = dataSources.first(where: { $0.id == id }) else { return }
        switch source.type {
        case .restAPI:  fetchREST(source: source)
        case .bashCommand: fetchBash(source: source)
        }
    }

    private func fetchREST(source: DataSource) {
        guard let url = URL(string: source.endpoint) else {
            DispatchQueue.main.async { self.lastErrors[source.id] = "Invalid URL" }
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        for (key, value) in source.parsedHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                    let msg: String
                    if http.statusCode == 429 || (http.statusCode == 403 && http.value(forHTTPHeaderField: "X-RateLimit-Remaining") == "0") {
                        msg = "Rate limited (HTTP \(http.statusCode))"
                    } else {
                        msg = "HTTP \(http.statusCode)"
                    }
                    await MainActor.run { self.lastErrors[source.id] = msg }
                    return
                }
                let result = Self.extractValue(from: data, keyPath: source.jsonKeyPath)
                await MainActor.run { self.processResult(result, for: source.id) }
            } catch {
                await MainActor.run { self.lastErrors[source.id] = error.localizedDescription }
            }
        }
    }

    /// Extract a value from response data. If keyPath is non-empty, parse as JSON
    /// and traverse the dot-separated path. Otherwise return the first line of text.
    static func extractValue(from data: Data, keyPath: String) -> String? {
        let trimmedPath = keyPath.trimmingCharacters(in: .whitespaces)

        if trimmedPath.isEmpty {
            // Plain text mode: return first line
            let body = String(data: data, encoding: .utf8) ?? ""
            return body.trimmingCharacters(in: .whitespacesAndNewlines)
                .components(separatedBy: .newlines).first
        }

        // JSON mode: parse and traverse key path
        guard let json = try? JSONSerialization.jsonObject(with: data) else {
            return nil
        }

        let keys = trimmedPath.components(separatedBy: ".")
        var current: Any = json

        for key in keys {
            if let dict = current as? [String: Any], let next = dict[key] {
                current = next
            } else if let arr = current as? [Any], let idx = Int(key), idx >= 0, idx < arr.count {
                current = arr[idx]
            } else {
                return nil
            }
        }

        // Convert the final value to a display string
        if let num = current as? NSNumber {
            // Avoid printing ".0" for integers
            if CFNumberIsFloatType(num) {
                return "\(num.doubleValue)"
            }
            return "\(num.intValue)"
        }
        return "\(current)"
    }

    private func fetchBash(source: DataSource) {
        // Cap at the poll interval (or 30s, whichever is smaller) so a user
        // command that hangs — `ping` with no route, `sleep`, a wedged ssh —
        // doesn't pin a GCD worker thread indefinitely and doesn't overlap
        // the next scheduled fetch. Previously an unresponsive command
        // could leak threads one-per-poll until the app was relaunched.
        let timeout = min(max(source.pollInterval, 2), 30)
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let process = Process()
            let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = ["-c", source.endpoint]
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                try process.run()
            } catch {
                DispatchQueue.main.async { self?.lastErrors[source.id] = error.localizedDescription }
                return
            }

            // Fire a watchdog on a background queue — if the process is
            // still running when the timeout elapses, terminate it. This
            // stays within the Process API (SIGTERM via `terminate()`)
            // rather than a raw `kill(pid, SIGKILL)`: between an isRunning
            // check and a raw kill the PID can be recycled, SIGKILLing an
            // unrelated process. No SIGKILL escalation is needed — with
            // output drained below the hung-pipe failure mode is gone, and
            // a child that ignores SIGTERM is the same wedge `timeout(1)`
            // accepts by default.
            let watchdog = DispatchWorkItem {
                if process.isRunning { process.terminate() }
            }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout,
                                                            execute: watchdog)

            // Drain output BEFORE waiting for exit. A pipe buffers ~64 KiB:
            // a child emitting more blocks on write while waitUntilExit()
            // blocks on the child — a deadlock the watchdog then "resolved"
            // by killing a command that was actually succeeding.
            // readDataToEndOfFile() consumes as the child writes and
            // returns at EOF, after which the wait completes immediately.
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            watchdog.cancel()
            let output = String(data: data, encoding: .utf8) ?? ""
            let firstLine = output.trimmingCharacters(in: .whitespacesAndNewlines)
                .components(separatedBy: .newlines).first

            // If we timed out, surface that rather than handing a stale /
            // empty tail to the display. `terminationReason == .uncaughtSignal`
            // is the watchdog's SIGTERM (bash doesn't trap it by default).
            if process.terminationReason == .uncaughtSignal {
                DispatchQueue.main.async {
                    self?.lastErrors[source.id] = "Command timed out after \(Int(timeout))s"
                }
                return
            }

            DispatchQueue.main.async { self?.processResult(firstLine, for: source.id) }
        }
    }

    private func processResult(_ value: String?, for id: UUID) {
        if let value = value, !value.isEmpty {
            let source = dataSources.first { $0.id == id }
            let formatted = Self.applyFormat(value, format: source?.displayFormat ?? "")
            lastValues[id] = formatted
            lastErrors.removeValue(forKey: id)
            // Update display immediately if this source is currently shown
            if isActive, let current = currentDisplayedSource, current.id == id {
                sendToDisplay(formatted)
            }
        } else {
            lastErrors[id] = "Empty response"
        }
    }

    private func sendToDisplay(_ value: String) {
        guard let sm = serialManager else { return }
        // Don't override if another mode (text, countdown) is explicitly active
        let current = sm.activeDisplayMode
        guard current == .dataSource || current == .none else { return }
        sm.activateDisplayMode(.dataSource)
        sm.sendCommand("mode_text = 1")
        sm.sendScrollingText(value)
    }

    static func applyFormat(_ value: String, format: String) -> String {
        let trimmed = format.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return value }
        return trimmed.replacingOccurrences(of: "{v}", with: value)
    }

    // MARK: Persistence

    // Headers are the one secret-bearing field (their whole point is
    // `Authorization: Bearer ...`), so they live in the Keychain — one item
    // per source, keyed by the source's UUID — while everything non-secret
    // stays in the UserDefaults blob. The `DataSource.headers` property is
    // unchanged for callers; only where it persists differs.
    private static func headersKeychainKey(for id: UUID) -> String {
        "dataSource-headers-\(id.uuidString)"
    }

    /// Decodes one array element, swallowing its failure instead of failing
    /// the whole array. Persistence here must be element-wise tolerant: an
    /// all-or-nothing `[DataSource]` decode means one future incompatible
    /// field turns load() into `[]`, and the next save() then permanently
    /// wipes every source the user configured.
    ///
    /// Convention for future stored properties on `DataSource`: make them
    /// optional, or default them via `decodeIfPresent`, so blobs written by
    /// older versions keep decoding.
    private struct TolerantElement<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) {
            value = try? T(from: decoder)
        }
    }

    private func save() {
        var sanitized = dataSources
        for i in sanitized.indices {
            do {
                // Empty headers delete the Keychain item, so a cleared field
                // doesn't leave a stale token behind.
                try KeychainHelper.set(sanitized[i].headers,
                                       forKey: Self.headersKeychainKey(for: sanitized[i].id))
                sanitized[i].headers = ""
            } catch {
                // Keychain write failed: keep the plaintext copy in the blob
                // rather than stripping it — degrading to the old plaintext
                // behaviour beats silently losing the user's tokens.
            }
        }
        if let data = try? JSONEncoder().encode(sanitized) {
            UserDefaults.standard.set(data, forKey: "dataSources")
        }
        UserDefaults.standard.set(isActive, forKey: "dataSourcesActive")
        UserDefaults.standard.set(rotationInterval, forKey: "dataSourceRotationInterval")
    }

    private func load() {
        if let data = UserDefaults.standard.data(forKey: "dataSources"),
           let decoded = try? JSONDecoder().decode([TolerantElement<DataSource>].self, from: data) {
            var sources = decoded.compactMap(\.value)
            for i in sources.indices {
                let key = Self.headersKeychainKey(for: sources[i].id)
                do {
                    if let secret = try KeychainHelper.get(forKey: key) {
                        sources[i].headers = secret
                    } else if !sources[i].headers.isEmpty {
                        // Pre-Keychain blob: headers are still plaintext in
                        // UserDefaults. Migrate them into the Keychain now;
                        // the next save() strips them from the defaults copy.
                        try KeychainHelper.set(sources[i].headers, forKey: key)
                    }
                } catch {
                    // Keychain unavailable: fall back to whatever the blob
                    // carried (possibly empty) so the source still works.
                }
            }
            dataSources = sources
        }
        isActive = UserDefaults.standard.bool(forKey: "dataSourcesActive")
        let interval = UserDefaults.standard.double(forKey: "dataSourceRotationInterval")
        rotationInterval = interval > 0 ? interval : 10
    }
}
