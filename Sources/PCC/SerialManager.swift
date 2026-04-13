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
        guard let port = connectedPort, port.isOpen,
              let data = "\(command)\r\n".data(using: .utf8) else { return }
        port.send(data)
    }

    // MARK: - Scroll

    private var scrollTimer: Timer?
    private var scrollText: String = ""
    private var scrollPosition: Int = 0

    /// Send text to the display. If > 10 chars, starts a marquee scroll.
    func sendScrollingText(_ value: String) {
        scrollTimer?.invalidate()
        scrollTimer = nil

        if value.count <= 10 {
            sendCommand("text = \(value)")
        } else {
            scrollText = value + "      "
            scrollPosition = 0
            sendScrollFrame()
            scrollTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
                guard let self else { return }
                self.scrollPosition = (self.scrollPosition + 1) % self.scrollText.count
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
        sendCommand("nmea = off")
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

    func serialPort(_ serialPort: ORSSerialPort, didReceive data: Data) {
        // Not processing incoming data for now
    }
}
