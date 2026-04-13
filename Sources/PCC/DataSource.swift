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
    var pollInterval: TimeInterval
    var isEnabled: Bool

    init(id: UUID = UUID(), name: String = "", type: DataSourceType = .restAPI,
         endpoint: String = "", pollInterval: TimeInterval = 60, isEnabled: Bool = true) {
        self.id = id
        self.name = name
        self.type = type
        self.endpoint = endpoint
        self.pollInterval = pollInterval
        self.isEnabled = isEnabled
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

    func setEnabled(_ enabled: Bool) {
        isActive = enabled
        save()
        if enabled {
            startAll()
        } else {
            stopAll()
            serialManager?.sendCommand("mode_text = 0")
            serialManager?.activeDisplayMode = .none
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
    }

    private func startPolling(for id: UUID) {
        guard let source = dataSources.first(where: { $0.id == id }) else { return }
        stopPolling(for: id)
        fetchValue(for: id)
        let timer = Timer.scheduledTimer(withTimeInterval: source.pollInterval, repeats: true) { [weak self] _ in
            self?.fetchValue(for: id)
        }
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
            serialManager?.sendCommand("mode_text = 0")
            serialManager?.activeDisplayMode = .none
            return
        }

        currentSourceIndex = currentSourceIndex % sources.count
        displayCurrentSource()

        guard sources.count > 1 else { return }
        rotationTimer = Timer.scheduledTimer(withTimeInterval: rotationInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            let sources = self.enabledSources
            guard !sources.isEmpty else { return }
            self.currentSourceIndex = (self.currentSourceIndex + 1) % sources.count
            self.displayCurrentSource()
        }
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
        Task {
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                let body = String(data: data, encoding: .utf8) ?? ""
                let firstLine = body.trimmingCharacters(in: .whitespacesAndNewlines)
                    .components(separatedBy: .newlines).first
                await MainActor.run { self.processResult(firstLine, for: source.id) }
            } catch {
                await MainActor.run { self.lastErrors[source.id] = error.localizedDescription }
            }
        }
    }

    private func fetchBash(source: DataSource) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let process = Process()
            let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = ["-c", source.endpoint]
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                try process.run()
                process.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8) ?? ""
                let firstLine = output.trimmingCharacters(in: .whitespacesAndNewlines)
                    .components(separatedBy: .newlines).first
                DispatchQueue.main.async { self?.processResult(firstLine, for: source.id) }
            } catch {
                DispatchQueue.main.async { self?.lastErrors[source.id] = error.localizedDescription }
            }
        }
    }

    private func processResult(_ value: String?, for id: UUID) {
        if let value = value, !value.isEmpty {
            lastValues[id] = value
            lastErrors.removeValue(forKey: id)
            // Update display immediately if this source is currently shown
            if isActive, let current = currentDisplayedSource, current.id == id {
                sendToDisplay(value)
            }
        } else {
            lastErrors[id] = "Empty response"
        }
    }

    private func sendToDisplay(_ value: String) {
        let truncated = String(value.prefix(10))
        serialManager?.sendCommand("text = \(truncated)")
        serialManager?.sendCommand("mode_text = 1")
        serialManager?.activeDisplayMode = .dataSource
    }

    // MARK: Persistence

    private func save() {
        if let data = try? JSONEncoder().encode(dataSources) {
            UserDefaults.standard.set(data, forKey: "dataSources")
        }
        UserDefaults.standard.set(isActive, forKey: "dataSourcesActive")
        UserDefaults.standard.set(rotationInterval, forKey: "dataSourceRotationInterval")
    }

    private func load() {
        if let data = UserDefaults.standard.data(forKey: "dataSources"),
           let sources = try? JSONDecoder().decode([DataSource].self, from: data) {
            dataSources = sources
        }
        isActive = UserDefaults.standard.bool(forKey: "dataSourcesActive")
        let interval = UserDefaults.standard.double(forKey: "dataSourceRotationInterval")
        rotationInterval = interval > 0 ? interval : 10
    }
}
