import Foundation
import ORSSerial
import AppKit
import os

/// A GPS time fix paired with the local receipt timestamp, snapshotted
/// together so a reader can never see a fresh fix with a stale receipt
/// time (or vice versa).
struct GPSTimeReference {
    let utc: Date
    let receivedAt: Date
}

enum DisplayMode: String {
    case none = "None"
    case text = "Text mode"
    case weather = "Weather mode"
    case countdown = "Countdown"
    case dataSource = "Data source"
}

class SerialManager: NSObject, ObservableObject {
    @Published var availablePorts: [ORSSerialPort] = []
    @Published var connectedPort: ORSSerialPort?
    @Published var isConnected = false
    @Published var statusMessage = "Disconnected"
    @Published var lastError: String?
    @Published var activeDisplayMode: DisplayMode = .none

    /// Switch display mode, cleaning up the previous mode on the clock first.
    func activateDisplayMode(_ mode: DisplayMode) {
        guard mode != activeDisplayMode else { return }
        // Tear down previous mode
        switch activeDisplayMode {
        case .text, .dataSource, .weather:
            stopScrolling()
            sendCommand("mode_text = 0")
        case .countdown:
            sendCommand("mode_countdown = 0")
        case .none:
            break
        }
        activeDisplayMode = mode
    }

    // Serial monitor
    @Published var serialLog: String = ""
    var serialLogEnabled = false
    private var serialLineBuffer = Data()

    // Satellite tracking
    @Published var satellites: [SatelliteInfo] = []
    @Published var gpsLatitude: Double?
    @Published var gpsLongitude: Double?
    @Published var gpsAltitude: Double?
    @Published var gpsFix: Int = 0   // 0=none, 1=GPS, 2=DGPS
    @Published var gpsHDOP: Double?
    @Published var gpsSatellitesUsed: Int = 0
    @Published var firstFixTime: Date?
    @Published var gpsUTCTime: Date?  // Parsed from RMC (date + time)
    var gpsUTCTimeReceived: Date?     // System time when RMC was received
    /// Lock-guarded pair behind `gpsTimeReference`. The two properties above
    /// feed the UI on the main thread; the NTP packet path reads GPS time
    /// off-main, and reading two independent properties from there could
    /// tear — a fresh fix paired with a stale receipt time is worth up to
    /// ~1 s of served-time error (on top of being a data race).
    private let gpsTimeLock = OSAllocatedUnfairLock<GPSTimeReference?>(initialState: nil)
    /// Thread-safe snapshot of the latest GPS fix. Safe from any queue —
    /// the NTP packet path reads this off-main.
    var gpsTimeReference: GPSTimeReference? { gpsTimeLock.withLock { $0 } }
    private(set) var satelliteTrackingEnabled = false
    private var satelliteTrackingCount = 0
    @Published private(set) var nmeaActive = false
    @Published private(set) var nmeaConsumers: [String] = []
    private var nmeaConsumerCount = 0
    /// Per-(talker, signal) GSV accumulation, stamped with the time of the
    /// last write. A key is only reset when *its* msgNum == 1 arrives again,
    /// which never happens once a talker goes quiet — so without the
    /// timestamp, a constellation that stops broadcasting would be merged
    /// into `satellites` forever. Stale entries are dropped at merge time.
    private var gsvBuffer: [String: (satellites: [SatelliteInfo], updatedAt: Date)] = [:]
    private var satelliteUpdateTimer: Timer?

    private let portManager = ORSSerialPortManager.shared()
    private var lastConnectedPath: String?
    private var shouldAutoReconnect = false

    override init() {
        super.init()
        refreshPorts()

        let nc = NotificationCenter.default
        // Use the constants imported from ORSSerial, NOT string literals of
        // their names: the constants' runtime VALUES differ from their names
        // (ORSSerialPortsWereConnectedNotification is defined as
        // "ORSSerialPortWasConnectedNotification" — note Were vs Was — in
        // ORSSerialPortManager.m). A hand-typed literal of the constant
        // *name* subscribes to a notification that is never posted, silently
        // breaking hotplug detection.
        nc.addObserver(self, selector: #selector(serialPortsChanged),
                       name: .ORSSerialPortsWereConnected, object: nil)
        nc.addObserver(self, selector: #selector(serialPortsChanged),
                       name: .ORSSerialPortsWereDisconnected, object: nil)
        nc.addObserver(self, selector: #selector(appWillTerminate),
                       name: NSApplication.willTerminateNotification, object: nil)

        autoConnect()
    }

    private func autoConnect() {
        guard let savedPath = UserDefaults.standard.string(forKey: "lastSerialPort"),
              !savedPath.isEmpty,
              let port = availablePorts.first(where: { $0.path == savedPath }) else { return }
        connect(to: port)
    }

    func refreshPorts() {
        availablePorts = portManager.availablePorts.filter {
            $0.path.contains("cu.usbmodem")
        }
    }

    @objc private func serialPortsChanged() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.refreshPorts()

            // Check if connected port disappeared
            if let port = self.connectedPort,
               !self.availablePorts.contains(where: { $0.path == port.path }) {
                self.isConnected = false
                self.statusMessage = "Device removed"
                self.connectedPort = nil
                self.activeDisplayMode = .none
            }

            // Auto-reconnect after reboot
            if self.shouldAutoReconnect,
               let path = self.lastConnectedPath,
               let port = self.availablePorts.first(where: { $0.path == path }) {
                self.shouldAutoReconnect = false
                self.connect(to: port)
            }
        }
    }

    @objc private func appWillTerminate() {
        guard isConnected, let port = connectedPort, port.isOpen else { return }
        sendCommand("mode_text = 0")
        sendCommand("mode_countdown = 0")
        sendCommand("nmea = all")
        Thread.sleep(forTimeInterval: 0.2)
        port.close()
    }

    func connect(to port: ORSSerialPort) {
        // Already connected to this exact port — nothing to do. Without this
        // guard, the disconnect() below would schedule a delayed close of the
        // very port we are about to reopen.
        if port === connectedPort && port.isOpen { return }

        if let current = connectedPort, current.isOpen {
            disconnect()
        }

        port.baudRate = 115200
        port.delegate = self
        port.open()
        connectedPort = port
        lastConnectedPath = port.path
        // This write site is the sole owner of the "lastSerialPort" default;
        // other code (autoConnect, ConnectView) only reads the key.
        UserDefaults.standard.set(port.path, forKey: "lastSerialPort")
    }

    func disconnect() {
        activeDisplayMode = .none

        guard let port = connectedPort, port.isOpen else {
            connectedPort = nil
            isConnected = false
            statusMessage = "Disconnected"
            return
        }

        sendCommand("mode_text = 0")
        sendCommand("mode_countdown = 0")
        sendCommand("nmea = all")

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            port.close()
            // Only clear if nothing reconnected during the 0.2 s grace
            // period — connect(to:) may have already installed a new (or
            // re-opened) port, and clobbering it here would strand a live
            // connection with `connectedPort == nil`.
            if self?.connectedPort === port {
                self?.connectedPort = nil
            }
        }
    }

    func sendCommand(_ command: String) {
        guard let port = connectedPort, port.isOpen else { return }
        // Strip control characters (except space) to prevent protocol injection
        let sanitised = command.unicodeScalars
            .filter { $0 == " " || ($0.value >= 0x20 && $0.value < 0x7F) }
            .map { Character($0) }
        guard let data = (String(sanitised) + "\r\n").data(using: .utf8) else { return }
        port.send(data)
    }

    // MARK: - Scroll

    private var scrollTimer: Timer?
    private var scrollText: String = ""
    private var scrollPosition: Int = 0
    private var scrollWrapPosition: Int = 0
    /// Current seconds-per-shift for the marquee scroll. Mirrored from
    /// `AppSettings.scrollInterval` via `setScrollInterval(_:)` so SerialManager
    /// doesn't need its own reference to AppSettings.
    private var scrollInterval: TimeInterval = 0.40

    /// Send text to the display. If > 10 chars, starts a marquee scroll.
    /// Uses underscore as separator — visible on 7-segment at any position,
    /// unlike spaces which are invisible at the leading digit.
    func sendScrollingText(_ value: String) {
        let newScrollText = value + "_"

        // Don't restart scroll if already scrolling the same text
        if scrollTimer != nil && scrollText == newScrollText {
            return
        }

        scrollTimer?.invalidate()
        scrollTimer = nil

        if value.count <= 10 {
            scrollText = ""
            sendCommand("text = \(value)")
        } else {
            scrollText = newScrollText
            scrollWrapPosition = newScrollText.count
            scrollPosition = 0
            sendScrollFrame()
            scrollTimer = scheduledScrollTimer()
        }
    }

    /// Update the marquee interval. If a scroll is currently running, the
    /// existing timer is torn down and re-scheduled at the new rate while
    /// preserving the current position/text so the user sees the speed change
    /// take effect on the next tick without a visible reset.
    func setScrollInterval(_ interval: TimeInterval) {
        let clamped = max(0.05, min(2.0, interval))
        guard abs(clamped - scrollInterval) > 0.001 else { return }
        scrollInterval = clamped
        if scrollTimer != nil {
            scrollTimer?.invalidate()
            scrollTimer = scheduledScrollTimer()
        }
    }

    /// Factory for the marquee timer — one body, used both for a fresh scroll
    /// and for the live-reload restart. Registered in `.common` run-loop mode:
    /// `.default`-mode timers pause while the status-bar menu is open or a
    /// window is being dragged, which would visibly freeze the marquee.
    private func scheduledScrollTimer() -> Timer {
        let timer = Timer(timeInterval: scrollInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.scrollPosition += 1
            if self.scrollPosition >= self.scrollWrapPosition {
                self.scrollPosition = 0
            }
            self.sendScrollFrame()
        }
        RunLoop.main.add(timer, forMode: .common)
        return timer
    }

    func stopScrolling() {
        scrollTimer?.invalidate()
        scrollTimer = nil
    }

    private func sendScrollFrame() {
        let doubled = scrollText + scrollText
        let start = doubled.index(doubled.startIndex, offsetBy: scrollPosition)
        let end = doubled.index(start, offsetBy: 10)
        sendCommand("text = \(String(doubled[start..<end]))")
    }

    func rebootClock() {
        shouldAutoReconnect = true
        sendCommand("reboot")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.isConnected = false
            self?.connectedPort = nil
            self?.activeDisplayMode = .none
            self?.statusMessage = "Rebooting..."
        }
    }
}

// MARK: - ORSSerialPortDelegate

extension SerialManager: ORSSerialPortDelegate {

    func serialPortWasOpened(_ serialPort: ORSSerialPort) {
        let nmeaOn = nmeaConsumerCount > 0
        sendCommand(nmeaOn ? "nmea = all" : "nmea = off")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.isConnected = true
            self?.nmeaActive = nmeaOn
            self?.statusMessage = "Connected to \(serialPort.name)"
            self?.lastError = nil
        }
    }

    func serialPortWasClosed(_ serialPort: ORSSerialPort) {
        DispatchQueue.main.async { [weak self] in
            self?.isConnected = false
            self?.statusMessage = "Disconnected"
        }
    }

    func serialPortWasRemovedFromSystem(_ serialPort: ORSSerialPort) {
        DispatchQueue.main.async { [weak self] in
            self?.isConnected = false
            self?.connectedPort = nil
            self?.statusMessage = "Device removed"
            self?.lastError = "Clock was disconnected"
            self?.activeDisplayMode = .none
        }
    }

    func serialPort(_ serialPort: ORSSerialPort, didEncounterError error: Error) {
        DispatchQueue.main.async { [weak self] in
            self?.lastError = error.localizedDescription
            self?.statusMessage = "Error"
        }
    }

    /// Request NMEA data output from the clock. Reference counted so multiple
    /// consumers (Sky View, NTP server) can independently request/release.
    ///
    /// Must be called on the main thread — `nmeaConsumerCount` and
    /// `nmeaConsumers` are read-modify-written without synchronisation, so
    /// off-main callers would race with each other (and with the `@Published`
    /// `nmeaConsumers`, which must be mutated on main anyway). Every known
    /// caller today is main-thread (SwiftUI `.onAppear`/`.onDisappear`,
    /// `NTPServer.start/stop` invoked from SwiftUI state flips), and the
    /// precondition makes any regression crash loudly in debug rather than
    /// silently dropping consumer-count transitions.
    func requestNMEA(consumer: String = "Unknown") {
        dispatchPrecondition(condition: .onQueue(.main))
        nmeaConsumerCount += 1
        nmeaConsumers.append(consumer)
        if nmeaConsumerCount == 1 {
            sendCommand("NMEA = all")
            nmeaActive = true
        }
    }

    func releaseNMEA(consumer: String = "Unknown") {
        dispatchPrecondition(condition: .onQueue(.main))
        nmeaConsumerCount = max(0, nmeaConsumerCount - 1)
        if let idx = nmeaConsumers.firstIndex(of: consumer) {
            nmeaConsumers.remove(at: idx)
        }
        if nmeaConsumerCount == 0 {
            sendCommand("NMEA = off")
            nmeaActive = false
        }
    }

    func requestSatelliteTracking() {
        satelliteTrackingCount += 1
        satelliteTrackingEnabled = true
    }

    func releaseSatelliteTracking() {
        satelliteTrackingCount = max(0, satelliteTrackingCount - 1)
        if satelliteTrackingCount == 0 {
            satelliteTrackingEnabled = false
        }
    }

    func serialPort(_ serialPort: ORSSerialPort, didReceive data: Data) {
        serialLineBuffer.append(data)

        while let newlineIndex = serialLineBuffer.firstIndex(of: 0x0A) {
            let lineData = serialLineBuffer[serialLineBuffer.startIndex...newlineIndex]
            if let line = String(data: lineData, encoding: .utf8) {
                if serialLogEnabled {
                    DispatchQueue.main.async { [weak self] in
                        guard let self else { return }
                        self.serialLog.append(line)
                        if self.serialLog.count > 50_000 {
                            self.serialLog = String(self.serialLog.suffix(40_000))
                        }
                    }
                }
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                // Always parse position and time (lightweight, needed by map + NTP)
                if trimmed.contains("GGA,") {
                    parseGGA(trimmed)
                } else if trimmed.contains("RMC,") {
                    parseRMC(trimmed)
                } else if satelliteTrackingEnabled && trimmed.contains("GSV,") {
                    parseGSV(trimmed)
                }
            }
            serialLineBuffer.removeSubrange(serialLineBuffer.startIndex...newlineIndex)
        }

        // Cap the residual buffer. The `cu.usbmodem` port filter matches ANY
        // USB CDC device, not just the clock — a device that streams bytes
        // without ever sending a newline would otherwise grow this buffer
        // without bound. Real NMEA/clock lines are well under 100 bytes, so
        // anything past 64 KiB with no line break is garbage; drop it.
        if serialLineBuffer.count > 64 * 1024 {
            serialLineBuffer.removeAll(keepingCapacity: false)
        }
    }

    // MARK: - GSV Parser

    private func parseGSV(_ line: String) {
        let stripped = line.split(separator: "*").first.map(String.init) ?? line
        let fields = stripped.split(separator: ",", omittingEmptySubsequences: false).map(String.init)

        guard fields.count >= 4, fields[0].hasSuffix("GSV") else { return }

        let talkerId = String(fields[0].prefix(3))
        guard let constellation = SatConstellation(talkerId: talkerId) else { return }

        guard let numMsg = Int(fields[1]),
              let msgNum = Int(fields[2]) else { return }

        // NMEA 4.10+ appends a signal ID as the last field (e.g. ,1 for L1 C/A)
        // This means multiple GSV sets per constellation per cycle.
        // Key the buffer by talker + signal ID to prevent sets overwriting each other.
        let dataFields = fields.count - 4
        let signalId = (dataFields > 0 && dataFields % 4 == 1) ? (fields.last ?? "") : ""
        let bufferKey = "\(talkerId)_\(signalId)"

        if msgNum == 1 {
            gsvBuffer[bufferKey] = (satellites: [], updatedAt: Date())
        }

        // Each satellite is 4 fields: PRN, elevation, azimuth, SNR
        var parsed: [SatelliteInfo] = []
        var i = 4
        while i + 3 < fields.count {
            if let prn = Int(fields[i]),
               let elev = Int(fields[i + 1]),
               let azim = Int(fields[i + 2]) {
                let snr = fields[i + 3].isEmpty ? nil : Int(fields[i + 3])
                parsed.append(SatelliteInfo(prn: prn, constellation: constellation,
                                            elevation: elev, azimuth: azim, snr: snr))
            }
            i += 4
        }

        // Stamp the entry on every page of the set (not just page 1) so an
        // actively broadcasting talker is always considered live, even when
        // a page carries zero parseable satellites.
        var entry = gsvBuffer[bufferKey] ?? (satellites: [], updatedAt: Date())
        entry.satellites.append(contentsOf: parsed)
        entry.updatedAt = Date()
        gsvBuffer[bufferKey] = entry

        if msgNum == numMsg {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.satelliteUpdateTimer?.invalidate()
                let timer = Timer(timeInterval: 0.1, repeats: false) { [weak self] _ in
                    guard let self else { return }
                    // Merge all live buffer entries, dedup by satellite ID
                    // preferring entries with SNR data. Entries not written
                    // for ~5 s belong to constellations that stopped
                    // broadcasting — remove them, or their satellites would
                    // be re-merged (and shown) forever.
                    let cutoff = Date().addingTimeInterval(-5.0)
                    var merged: [String: SatelliteInfo] = [:]
                    for (key, entry) in self.gsvBuffer {
                        guard entry.updatedAt >= cutoff else {
                            self.gsvBuffer.removeValue(forKey: key)
                            continue
                        }
                        for sat in entry.satellites {
                            if let existing = merged[sat.id] {
                                if existing.snr == nil && sat.snr != nil {
                                    merged[sat.id] = sat
                                }
                            } else {
                                merged[sat.id] = sat
                            }
                        }
                    }
                    // Sort before publishing: `merged.values` is in
                    // dictionary order, which shuffles between otherwise
                    // identical updates and makes Equatable-based onChange
                    // observers fire for content that hasn't changed.
                    self.satellites = merged.values.sorted { $0.id < $1.id }
                }
                // `.common` mode so the debounce doesn't stall while the
                // status-bar menu is open or a window is being dragged
                // (`.default`-mode timers pause during those run-loop modes).
                RunLoop.main.add(timer, forMode: .common)
                self.satelliteUpdateTimer = timer
            }
        }
    }

    // MARK: - GGA Parser

    private func parseGGA(_ line: String) {
        // $GNGGA,123456.00,5124.258,N,00219.404,W,1,12,0.8,45.2,M,47.0,M,,*xx
        let stripped = line.split(separator: "*").first.map(String.init) ?? line
        let fields = stripped.split(separator: ",", omittingEmptySubsequences: false).map(String.init)

        guard fields.count >= 10, fields[0].hasSuffix("GGA") else { return }

        guard let fix = Int(fields[6]), fix > 0 else {
            DispatchQueue.main.async { [weak self] in
                self?.gpsFix = 0
            }
            return
        }

        // Parse latitude: DDMM.MMMM
        guard let rawLat = Double(fields[2]), !fields[3].isEmpty else { return }
        let latDeg = floor(rawLat / 100)
        let latMin = rawLat - latDeg * 100
        var lat = latDeg + latMin / 60
        if fields[3] == "S" { lat = -lat }

        // Parse longitude: DDDMM.MMMM
        guard let rawLon = Double(fields[4]), !fields[5].isEmpty else { return }
        let lonDeg = floor(rawLon / 100)
        let lonMin = rawLon - lonDeg * 100
        var lon = lonDeg + lonMin / 60
        if fields[5] == "W" { lon = -lon }

        let alt = Double(fields[9])
        let satsUsed = Int(fields[7]) ?? 0
        let hdop = Double(fields[8])

        DispatchQueue.main.async { [weak self] in
            self?.gpsLatitude = lat
            self?.gpsLongitude = lon
            self?.gpsAltitude = alt
            self?.gpsFix = fix
            self?.gpsSatellitesUsed = satsUsed
            self?.gpsHDOP = hdop
            if self?.firstFixTime == nil && fix > 0 {
                self?.firstFixTime = Date()
            }
        }
    }

    // MARK: - RMC Parser

    private func parseRMC(_ line: String) {
        // $GNRMC,123456.00,A,5124.258,N,00219.404,W,0.0,0.0,140426,,,A*xx
        let stripped = line.split(separator: "*").first.map(String.init) ?? line
        let fields = stripped.split(separator: ",", omittingEmptySubsequences: false).map(String.init)

        guard fields.count >= 10, fields[0].hasSuffix("RMC") else { return }
        guard fields[2] == "A" else {  // A = active/valid
            // Status "V" (void) means the receiver has lost its fix. Clear
            // the snapshot so the NTP server can detect GPS loss instead of
            // serving an ever-staler time reference.
            gpsTimeLock.withLock { $0 = nil }
            return
        }

        // Parse time HHMMSS.ss and date DDMMYY
        guard fields[1].count >= 6, fields[9].count == 6 else { return }

        let timeStr = fields[1]
        let dateStr = fields[9]

        guard let hh = Int(timeStr.prefix(2)),
              let mm = Int(timeStr.dropFirst(2).prefix(2)),
              let ss = Double(timeStr.dropFirst(4)),
              let day = Int(dateStr.prefix(2)),
              let mon = Int(dateStr.dropFirst(2).prefix(2)),
              let yr = Int(dateStr.dropFirst(4).prefix(2)) else { return }

        var comps = DateComponents()
        comps.timeZone = TimeZone(identifier: "UTC")
        comps.year = 2000 + yr
        comps.month = mon
        comps.day = day
        comps.hour = hh
        comps.minute = mm
        comps.second = Int(ss)
        comps.nanosecond = Int((ss - floor(ss)) * 1_000_000_000)

        guard let utcDate = Calendar(identifier: .gregorian).date(from: comps) else { return }

        let receivedAt = Date()
        // Snapshot the pair atomically for off-main readers (the NTP packet
        // path) — and do it here, synchronously, so `receivedAt` is paired
        // with `utcDate` at the moment of receipt rather than after a hop
        // through the main queue.
        gpsTimeLock.withLock { $0 = GPSTimeReference(utc: utcDate, receivedAt: receivedAt) }
        // The @Published mirrors stay main-thread-only for the UI.
        DispatchQueue.main.async { [weak self] in
            self?.gpsUTCTime = utcDate
            self?.gpsUTCTimeReceived = receivedAt
        }
    }

    func clearSerialLog() {
        serialLog = ""
        serialLineBuffer.removeAll()
    }
}
