import Foundation
import ORSSerial
import AppKit

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
    private(set) var satelliteTrackingEnabled = false
    private var satelliteTrackingCount = 0
    private var nmeaConsumerCount = 0
    private var gsvBuffer: [String: [SatelliteInfo]] = [:]
    private var satelliteUpdateTimer: Timer?

    private let portManager = ORSSerialPortManager.shared()
    private var lastConnectedPath: String?
    private var shouldAutoReconnect = false

    override init() {
        super.init()
        refreshPorts()

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(serialPortsChanged),
                       name: .init("ORSSerialPortsWereConnectedNotification"), object: nil)
        nc.addObserver(self, selector: #selector(serialPortsChanged),
                       name: .init("ORSSerialPortsWereDisconnectedNotification"), object: nil)
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
        if let current = connectedPort, current.isOpen {
            disconnect()
        }

        port.baudRate = 115200
        port.delegate = self
        port.open()
        connectedPort = port
        lastConnectedPath = port.path
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
            self?.connectedPort = nil
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

    /// Send text to the display. If > 10 chars, starts a marquee scroll.
    func sendScrollingText(_ value: String) {
        let newScrollText = value + "  "

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
            scrollWrapPosition = value.count
            scrollPosition = 0
            sendScrollFrame()
            scrollTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
                guard let self else { return }
                self.scrollPosition += 1
                // When the gap reaches the left edge of the display, leading blank
                // digits are invisible on 7-segment — skip those frames and restart.
                if self.scrollPosition >= self.scrollWrapPosition {
                    self.scrollPosition = 0
                }
                self.sendScrollFrame()
            }
        }
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
        sendCommand(nmeaConsumerCount > 0 ? "nmea = all" : "nmea = off")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.isConnected = true
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
    func requestNMEA() {
        nmeaConsumerCount += 1
        if nmeaConsumerCount == 1 {
            sendCommand("NMEA = all")
        }
    }

    func releaseNMEA() {
        nmeaConsumerCount = max(0, nmeaConsumerCount - 1)
        if nmeaConsumerCount == 0 {
            sendCommand("NMEA = off")
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
            gsvBuffer[bufferKey] = []
        }

        // Each satellite is 4 fields: PRN, elevation, azimuth, SNR
        var i = 4
        while i + 3 < fields.count {
            if let prn = Int(fields[i]),
               let elev = Int(fields[i + 1]),
               let azim = Int(fields[i + 2]) {
                let snr = fields[i + 3].isEmpty ? nil : Int(fields[i + 3])
                let sat = SatelliteInfo(prn: prn, constellation: constellation,
                                        elevation: elev, azimuth: azim, snr: snr)
                gsvBuffer[bufferKey, default: []].append(sat)
            }
            i += 4
        }

        if msgNum == numMsg {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.satelliteUpdateTimer?.invalidate()
                self.satelliteUpdateTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: false) { [weak self] _ in
                    guard let self else { return }
                    // Merge all buffer entries, dedup by satellite ID
                    // preferring entries with SNR data
                    var merged: [String: SatelliteInfo] = [:]
                    for (_, sats) in self.gsvBuffer {
                        for sat in sats {
                            if let existing = merged[sat.id] {
                                if existing.snr == nil && sat.snr != nil {
                                    merged[sat.id] = sat
                                }
                            } else {
                                merged[sat.id] = sat
                            }
                        }
                    }
                    self.satellites = Array(merged.values)
                }
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
        guard fields[2] == "A" else { return }  // A = active/valid

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
