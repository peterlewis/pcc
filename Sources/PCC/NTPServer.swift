import Foundation

/// Lightweight Stratum 1 NTP server that serves GPS-disciplined time.
/// Listens on a configurable UDP port using POSIX sockets and responds
/// to NTP client queries with time from NMEA RMC sentences.
///
/// Honesty rule: we only claim stratum 1 while we hold a *fresh* GPS fix.
/// With no fix (or a stale one) the reply switches to LI=3 / stratum 16
/// (unsynchronized) so chrony/ntpd mark us unusable instead of silently
/// disciplining the Mac's clock against the Mac's own clock.
class NTPServer: ObservableObject {
    @Published var isRunning = false
    @Published var queriesServed: Int = 0
    /// Replies sent as LI=3/stratum 16 because no fresh GPS fix was
    /// available. Counted separately so "queries served" can't masquerade
    /// as healthy service while every answer was actually "time unknown".
    @Published var unsyncRepliesServed: Int = 0
    @Published var timeOffset: Double?  // GPS time minus system time (seconds)
    @Published var port: UInt16 = 12321
    /// Why the last start() failed (socket/bind), nil while healthy. The UI
    /// shows this beside the toggle — without it a failed bind just looks
    /// like the switch snapping back for no reason.
    @Published var lastError: String?

    weak var serialManager: SerialManager? {
        didSet { if UserDefaults.standard.bool(forKey: "ntpServerEnabled") { start() } }
    }

    private var serverSocket: Int32 = -1
    private var readSource: DispatchSourceRead?
    private var offsetTimer: Timer?

    // NTP epoch offset: 1900-01-01 to 1970-01-01 = 2208988800 seconds.
    // Kept as Int64 so the seconds sum can exceed UInt32.max before the
    // deliberate era-wrap truncation in ntpTimestamp(for:).
    private let ntpEpochOffset: Int64 = 2_208_988_800

    /// How old a GPS fix may be and still be served as stratum 1. RMC
    /// sentences tick once a second; if nothing has arrived for this long
    /// the clock is unplugged or has lost its fix, and extrapolating the
    /// stale timestamp would quietly degrade into serving the Mac's own
    /// free-running clock labelled "GPS" — the exact failure mode an NTP
    /// client trusts a stratum 1 server not to have.
    private let maxFixAge: TimeInterval = 10

    func start() {
        guard !isRunning else { return }

        // Create UDP socket
        serverSocket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard serverSocket >= 0 else {
            lastError = "Could not create socket: \(String(cString: strerror(errno)))"
            print("NTP: Failed to create socket")
            return
        }

        // Deliberately NO SO_REUSEADDR here: on UDP it would let a second
        // copy of the app bind the same 127.0.0.1 port and split incoming
        // queries between two servers. A UDP listener has no TIME_WAIT to
        // work around, so reuse buys nothing — a hard EADDRINUSE surfaced
        // via lastError is the behaviour we want.

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
            let reason = String(cString: strerror(errno))
            lastError = "Bind to port \(port) failed: \(reason)"
            print("NTP: Bind failed: \(reason)")
            Darwin.close(serverSocket)
            serverSocket = -1
            return
        }

        // Dispatch source to handle incoming packets. The fd is captured by
        // VALUE in both handlers: the cancel handler runs asynchronously on
        // the ntp queue, and by the time it fires a quick stop()/start()
        // cycle may already have stored a NEW socket in `serverSocket` —
        // closing through self would then kill the fresh socket and leak
        // this one.
        let fd = serverSocket
        let source = DispatchSource.makeReadSource(fileDescriptor: fd,
                                                    queue: DispatchQueue(label: "ntp", qos: .userInteractive))
        source.setEventHandler { [weak self] in
            self?.handlePacket(on: fd)
        }
        source.setCancelHandler {
            Darwin.close(fd)
        }
        source.resume()
        readSource = source

        // Request NMEA data for RMC time sentences
        serialManager?.requestNMEA(consumer: "NTP Server")

        // Track time offset every second. Added in .common mode so the
        // readout keeps ticking while the status-item menu or a popover is
        // tracking — that runs the run loop in a non-default mode and would
        // stall a plain scheduledTimer (which registers in .default only).
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            self?.updateTimeOffset()
        }
        RunLoop.main.add(timer, forMode: .common)
        offsetTimer = timer

        UserDefaults.standard.set(true, forKey: "ntpServerEnabled")
        lastError = nil
        // Synchronous on purpose (start/stop only run on main): bouncing the
        // flag through DispatchQueue.main.async let a fast OFF→ON toggle hit
        // the `guard !isRunning` above before the pending `false` landed,
        // silently dropping the restart.
        isRunning = true
    }

    func stop() {
        readSource?.cancel()  // the cancel handler closes the captured fd
        readSource = nil
        serverSocket = -1     // fd now owned by the cancelled source, not us
        offsetTimer?.invalidate()
        offsetTimer = nil
        serialManager?.releaseNMEA(consumer: "NTP Server")
        UserDefaults.standard.set(false, forKey: "ntpServerEnabled")
        isRunning = false  // synchronous for the same reason as in start()
    }

    private func updateTimeOffset() {
        // Runs on main (Timer callback), so @Published assignment is direct.
        guard let ref = freshGPSReference() else {
            timeOffset = nil
            return
        }
        timeOffset = extrapolatedGPSTime(ref).timeIntervalSinceNow
    }

    // MARK: - GPS reference

    /// One thread-safe snapshot of the latest GPS fix, or nil when there is
    /// no fix or it is older than `maxFixAge`. `gpsTimeReference` hands back
    /// utc + receivedAt as a single struct, so the pair can't tear the way
    /// two separate property reads could when a fresh RMC sentence landed
    /// between them on another thread.
    private func freshGPSReference() -> GPSTimeReference? {
        guard let ref = serialManager?.gpsTimeReference,
              Date().timeIntervalSince(ref.receivedAt) <= maxFixAge else {
            return nil
        }
        return ref
    }

    /// GPS time extrapolated to "now": the RMC timestamp plus the system
    /// clock time elapsed since it arrived. This removes the ~200-500ms
    /// serial latency from the whole-second RMC timestamps; over the
    /// ≤`maxFixAge` extrapolation window, system-clock drift is negligible.
    private func extrapolatedGPSTime(_ ref: GPSTimeReference) -> Date {
        ref.utc.addingTimeInterval(Date().timeIntervalSince(ref.receivedAt))
    }

    // MARK: - Packet Handling

    private func handlePacket(on fd: Int32) {
        var buffer = [UInt8](repeating: 0, count: 48)
        var clientAddr = sockaddr_in()
        var addrLen = socklen_t(MemoryLayout<sockaddr_in>.size)

        let bytesRead = withUnsafeMutablePointer(to: &clientAddr) { addrPtr in
            addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                recvfrom(fd, &buffer, buffer.count, 0, sockPtr, &addrLen)
            }
        }

        guard bytesRead >= 48 else { return }

        let clientData = Data(buffer[0..<48])

        // Snapshot the GPS reference ONCE per packet so every timestamp in
        // the reply derives from the same fix.
        let reference = freshGPSReference()
        let response: Data
        if let reference {
            response = buildResponse(clientPacket: clientData, reference: reference)
        } else {
            response = buildUnsynchronizedResponse(clientPacket: clientData)
        }
        let synced = reference != nil

        _ = response.withUnsafeBytes { responsePtr in
            withUnsafePointer(to: &clientAddr) { addrPtr in
                addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    sendto(fd, responsePtr.baseAddress, response.count, 0,
                           sockPtr, addrLen)
                }
            }
        }

        DispatchQueue.main.async { [weak self] in
            self?.queriesServed += 1
            if !synced { self?.unsyncRepliesServed += 1 }
        }
    }

    // MARK: - NTP Response

    /// Stratum 1 reply, built from a fresh GPS fix.
    private func buildResponse(clientPacket: Data, reference: GPSTimeReference) -> Data {
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
        // Bytes 8-11: Root dispersion ~15ms for serial latency.
        // NTP short format is 16.16 fixed point: 0.015s × 65536 ≈ 983 = 0x03D7.
        response[8] = 0; response[9] = 0; response[10] = 0x03; response[11] = 0xD7

        // Bytes 12-15: Reference ID = "GPS\0"
        response[12] = 0x47; response[13] = 0x50; response[14] = 0x53; response[15] = 0x00

        // Bytes 16-23: Reference timestamp — when we last disciplined against
        // GPS (the arrival of the current fix), NOT "now". Clients read this
        // field as "how fresh is this server's reference", so stamping the
        // current time would overstate it.
        writeTimestamp(ntpTimestamp(for: reference.receivedAt), to: &response, at: 16)

        // Bytes 24-31: Origin timestamp (client's transmit timestamp)
        response.replaceSubrange(24..<32, with: clientPacket[40..<48])

        // Bytes 32-39 / 40-47: Receive and transmit timestamps — GPS time
        // extrapolated to the moment of each call. The microseconds of
        // processing time between the two stamps are real, so take two
        // readings rather than reusing one.
        writeTimestamp(ntpTimestamp(for: extrapolatedGPSTime(reference)), to: &response, at: 32)
        writeTimestamp(ntpTimestamp(for: extrapolatedGPSTime(reference)), to: &response, at: 40)

        return response
    }

    /// Reply sent when there is no fresh GPS fix. Per RFC 5905, a server
    /// that cannot be trusted for time signals leap=3 (alarm condition /
    /// clock unsynchronized) with an out-of-range stratum (16); reference ID
    /// and all timestamps stay zeroed EXCEPT the origin timestamp, which
    /// must still echo the client's transmit time or the reply gets dropped
    /// as bogus before the client even inspects LI/stratum. chrony and ntpd
    /// mark such a source unusable and fall back to other servers — instead
    /// of the old behaviour here, which stamped `Date()` as stratum 1 "GPS"
    /// and let chrony discipline the Mac's clock against itself.
    private func buildUnsynchronizedResponse(clientPacket: Data) -> Data {
        var response = Data(count: 48)

        // Byte 0: LI=3 (unsynchronized), VN=4 (NTPv4), Mode=4 (server)
        response[0] = 0b11_100_100

        // Byte 1: Stratum 16 (unsynchronized; only 1-15 are valid strata)
        response[1] = 16

        // Byte 2: Poll interval (copy from client)
        response[2] = clientPacket[2]

        // Bytes 24-31: Origin timestamp (client's transmit timestamp).
        // Everything else — root delay/dispersion, refid, reference/receive/
        // transmit timestamps — is deliberately left zero.
        response.replaceSubrange(24..<32, with: clientPacket[40..<48])

        return response
    }

    private func ntpTimestamp(for date: Date) -> (seconds: UInt32, fraction: UInt32) {
        let unix = date.timeIntervalSince1970
        // Era wrap, not a bug: NTP's 32-bit seconds overflow on 2036-02-07
        // and simply wrap into era 1; clients disambiguate eras as long as
        // their own clock is within ~68 years of the server (RFC 5905 §6).
        // Truncation is therefore the *specified* behaviour — checked
        // `UInt32(...)` arithmetic would instead crash the server at the
        // rollover instant.
        let secs = UInt32(truncatingIfNeeded: Int64(unix) + ntpEpochOffset)
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
