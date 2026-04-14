import Foundation

/// Lightweight Stratum 1 NTP server that serves GPS-disciplined time.
/// Listens on a configurable UDP port using POSIX sockets and responds
/// to NTP client queries with time from NMEA RMC sentences.
class NTPServer: ObservableObject {
    @Published var isRunning = false
    @Published var queriesServed: Int = 0
    @Published var timeOffset: Double?  // GPS time minus system time (seconds)
    @Published var port: UInt16 = 12321

    weak var serialManager: SerialManager? {
        didSet { if UserDefaults.standard.bool(forKey: "ntpServerEnabled") { start() } }
    }

    private var serverSocket: Int32 = -1
    private var readSource: DispatchSourceRead?
    private var offsetTimer: Timer?

    // NTP epoch offset: 1900-01-01 to 1970-01-01 = 2208988800 seconds
    private let ntpEpochOffset: UInt32 = 2_208_988_800

    func start() {
        guard !isRunning else { return }

        // Create UDP socket
        serverSocket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard serverSocket >= 0 else {
            print("NTP: Failed to create socket")
            return
        }

        // Allow address reuse
        var yes: Int32 = 1
        setsockopt(serverSocket, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        // Bind to localhost on configured port
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(serverSocket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        guard bindResult == 0 else {
            print("NTP: Bind failed: \(String(cString: strerror(errno)))")
            Darwin.close(serverSocket)
            serverSocket = -1
            return
        }

        // Dispatch source to handle incoming packets
        let source = DispatchSource.makeReadSource(fileDescriptor: serverSocket,
                                                    queue: DispatchQueue(label: "ntp", qos: .userInteractive))
        source.setEventHandler { [weak self] in
            self?.handlePacket()
        }
        source.setCancelHandler { [weak self] in
            guard let self, self.serverSocket >= 0 else { return }
            Darwin.close(self.serverSocket)
            self.serverSocket = -1
        }
        source.resume()
        readSource = source

        // Request NMEA data for RMC time sentences
        serialManager?.requestNMEA()

        // Track time offset every second
        offsetTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.updateTimeOffset()
        }

        UserDefaults.standard.set(true, forKey: "ntpServerEnabled")
        DispatchQueue.main.async { self.isRunning = true }
    }

    func stop() {
        readSource?.cancel()
        readSource = nil
        offsetTimer?.invalidate()
        offsetTimer = nil
        serialManager?.releaseNMEA()
        UserDefaults.standard.set(false, forKey: "ntpServerEnabled")
        DispatchQueue.main.async { self.isRunning = false }
    }

    private func updateTimeOffset() {
        guard let gpsTime = serialManager?.gpsUTCTime,
              let receivedAt = serialManager?.gpsUTCTimeReceived else {
            DispatchQueue.main.async { self.timeOffset = nil }
            return
        }
        // Extrapolated GPS time vs system time
        let elapsed = Date().timeIntervalSince(receivedAt)
        let extrapolated = gpsTime.addingTimeInterval(elapsed)
        let offset = extrapolated.timeIntervalSince(Date())
        DispatchQueue.main.async { self.timeOffset = offset }
    }

    // MARK: - Packet Handling

    private func handlePacket() {
        var buffer = [UInt8](repeating: 0, count: 48)
        var clientAddr = sockaddr_in()
        var addrLen = socklen_t(MemoryLayout<sockaddr_in>.size)

        let bytesRead = withUnsafeMutablePointer(to: &clientAddr) { addrPtr in
            addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                recvfrom(serverSocket, &buffer, buffer.count, 0, sockPtr, &addrLen)
            }
        }

        guard bytesRead >= 48 else { return }

        let clientData = Data(buffer[0..<48])
        let response = buildResponse(clientPacket: clientData)

        _ = response.withUnsafeBytes { responsePtr in
            withUnsafePointer(to: &clientAddr) { addrPtr in
                addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    sendto(serverSocket, responsePtr.baseAddress, response.count, 0,
                           sockPtr, addrLen)
                }
            }
        }

        DispatchQueue.main.async { [weak self] in
            self?.queriesServed += 1
        }
    }

    // MARK: - NTP Response

    private func buildResponse(clientPacket: Data) -> Data {
        var response = Data(count: 48)

        // Byte 0: LI=0 (no warning), VN=4 (NTPv4), Mode=4 (server)
        response[0] = 0b00_100_100

        // Byte 1: Stratum 1 (primary GPS reference)
        response[1] = 1

        // Byte 2: Poll interval (copy from client)
        response[2] = clientPacket[2]

        // Byte 3: Precision (-18 = ~4 microseconds, conservative for serial)
        response[3] = UInt8(bitPattern: -18)

        // Bytes 4-7: Root delay (0)
        // Bytes 8-11: Root dispersion (~15ms for serial latency)
        response[8] = 0; response[9] = 0; response[10] = 0x0F; response[11] = 0x00

        // Bytes 12-15: Reference ID = "GPS\0"
        response[12] = 0x47; response[13] = 0x50; response[14] = 0x53; response[15] = 0x00

        let now = currentNTPTimestamp()

        // Bytes 16-23: Reference timestamp
        writeTimestamp(now, to: &response, at: 16)

        // Bytes 24-31: Origin timestamp (client's transmit timestamp)
        response.replaceSubrange(24..<32, with: clientPacket[40..<48])

        // Bytes 32-39: Receive timestamp
        writeTimestamp(now, to: &response, at: 32)

        // Bytes 40-47: Transmit timestamp
        writeTimestamp(currentNTPTimestamp(), to: &response, at: 40)

        return response
    }

    private func currentNTPTimestamp() -> (seconds: UInt32, fraction: UInt32) {
        // Extrapolate GPS time forward using system clock elapsed since receipt.
        // This removes the ~200-500ms serial latency from stale RMC timestamps.
        let time: Date
        if let gpsTime = serialManager?.gpsUTCTime,
           let receivedAt = serialManager?.gpsUTCTimeReceived {
            let elapsed = Date().timeIntervalSince(receivedAt)
            time = gpsTime.addingTimeInterval(elapsed)
        } else {
            time = Date()
        }

        let unix = time.timeIntervalSince1970
        let secs = UInt32(unix) + ntpEpochOffset
        let frac = UInt32((unix - floor(unix)) * Double(UInt32.max))
        return (secs, frac)
    }

    private func writeTimestamp(_ ts: (seconds: UInt32, fraction: UInt32),
                                to data: inout Data, at offset: Int) {
        data[offset]     = UInt8((ts.seconds >> 24) & 0xFF)
        data[offset + 1] = UInt8((ts.seconds >> 16) & 0xFF)
        data[offset + 2] = UInt8((ts.seconds >> 8) & 0xFF)
        data[offset + 3] = UInt8(ts.seconds & 0xFF)
        data[offset + 4] = UInt8((ts.fraction >> 24) & 0xFF)
        data[offset + 5] = UInt8((ts.fraction >> 16) & 0xFF)
        data[offset + 6] = UInt8((ts.fraction >> 8) & 0xFF)
        data[offset + 7] = UInt8(ts.fraction & 0xFF)
    }
}
