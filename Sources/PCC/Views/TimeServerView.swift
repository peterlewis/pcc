import SwiftUI

struct TimeServerView: View {
    @EnvironmentObject var ntpServer: NTPServer
    @EnvironmentObject var serialManager: SerialManager
    @State private var now = Date()
    @State private var testResult: String?
    @State private var testRunning = false

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
    private var portStr: String { String(ntpServer.port) }

    var body: some View {
        Form {
            // Status section
            Section {
                HStack {
                    Circle()
                        .fill(ntpServer.isRunning ? .green : .gray)
                        .frame(width: 8, height: 8)
                    Text(ntpServer.isRunning ? "Running on port \(portStr)" : "Stopped")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Toggle("", isOn: Binding(
                        get: { ntpServer.isRunning },
                        set: { $0 ? ntpServer.start() : ntpServer.stop() }
                    ))
                    .toggleStyle(.switch)
                    .labelsHidden()
                }

                if ntpServer.isRunning {
                    HStack {
                        Text("Queries served")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("\(ntpServer.queriesServed)")
                            .font(.system(.caption, design: .monospaced))
                    }
                }
            } header: {
                Label("NTP Server", systemImage: "clock.badge.checkmark")
            } footer: {
                Text("Stratum 1 NTP server using GPS-disciplined time from your clock.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            // Time offset section
            Section("System Clock") {
                if let gpsTime = serialManager.gpsUTCTime,
                   let receivedAt = serialManager.gpsUTCTimeReceived {
                    HStack {
                        Text("GPS time (UTC)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(formatUTC(gpsTime.addingTimeInterval(Date().timeIntervalSince(receivedAt))))
                            .font(.system(.caption, design: .monospaced))
                    }
                }

                HStack {
                    Text("System time (UTC)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(formatUTC(Date()))
                        .font(.system(.caption, design: .monospaced))
                }

                if let offset = ntpServer.timeOffset {
                    HStack {
                        Text("Offset")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(formatOffset(offset))
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(offsetColor(offset))
                    }
                } else if serialManager.gpsUTCTime == nil {
                    HStack {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                            .font(.caption)
                        Text("Waiting for GPS time (RMC sentence)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // Test query
            if ntpServer.isRunning {
                Section {
                    HStack {
                        Button(testRunning ? "Querying\u{2026}" : "Send Test Query") {
                            runTestQuery()
                        }
                        .disabled(testRunning)
                        .font(.caption)
                        Spacer()
                        if let result = testResult {
                            Text(result)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(result.contains("OK") ? .green : .red)
                        }
                    }
                } header: {
                    Text("Test")
                } footer: {
                    Text("Sends an NTP query to the local server and checks the response.")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            // Continuous sync with chrony
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    step("1", "Install chrony")
                    codeBlock("brew install chrony")

                    step("2", "Edit config file")
                    codeBlock("nano /opt/homebrew/etc/chrony.conf")
                    Text("Add this line:")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    codeBlock("server 127.0.0.1 port \(portStr) iburst prefer")

                    step("3", "Start chronyd")
                    codeBlock("sudo mkdir -p /var/run/chrony && sudo /opt/homebrew/sbin/chronyd -f /opt/homebrew/etc/chrony.conf")

                    step("4", "Check sync status")
                    codeBlock("chronyc tracking")
                }
            } header: {
                Text("Continuous sync (chrony)")
            } footer: {
                Text("Keeps your Mac's clock continuously disciplined to GPS time. Requires sudo to adjust the system clock. Intel Macs: use /usr/local/ paths instead of /opt/homebrew/.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .formStyle(.grouped)
        .onReceive(ticker) { now = $0 }
    }

    private func runTestQuery() {
        testRunning = true
        testResult = nil
        DispatchQueue.global(qos: .userInitiated).async {
            let sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
            guard sock >= 0 else {
                DispatchQueue.main.async { testResult = "Socket error"; testRunning = false }
                return
            }
            defer { Darwin.close(sock) }

            // 2-second timeout
            var tv = timeval(tv_sec: 2, tv_usec: 0)
            setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

            // Build NTP client packet (mode 3)
            var packet = [UInt8](repeating: 0, count: 48)
            packet[0] = 0x23  // LI=0, VN=4, Mode=3

            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = ntpServer.port.bigEndian
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")

            let sent = withUnsafePointer(to: &addr) { addrPtr in
                addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    sendto(sock, &packet, 48, 0, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard sent == 48 else {
                DispatchQueue.main.async { testResult = "Send failed"; testRunning = false }
                return
            }

            var response = [UInt8](repeating: 0, count: 48)
            let received = recv(sock, &response, 48, 0)

            DispatchQueue.main.async {
                if received >= 48 {
                    let stratum = response[1]
                    let refID = String(bytes: response[12..<16], encoding: .ascii)?
                        .trimmingCharacters(in: .controlCharacters) ?? "?"
                    testResult = "OK \u{2014} Stratum \(stratum), ref \(refID)"
                } else {
                    testResult = "No response"
                }
                testRunning = false
            }
        }
    }

    private func codeBlock(_ text: String) -> some View {
        HStack(spacing: 4) {
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            } label: {
                Image(systemName: "doc.on.doc")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
        }
        .padding(6)
        .background(.quaternary.opacity(0.5))
        .cornerRadius(4)
    }

    private func step(_ number: String, _ label: String) -> some View {
        HStack(spacing: 6) {
            Text(number)
                .font(.system(.caption2, design: .rounded, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 16, height: 16)
                .background(.blue)
                .clipShape(Circle())
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func formatUTC(_ date: Date) -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss.SS"
        fmt.timeZone = TimeZone(identifier: "UTC")
        return fmt.string(from: date)
    }

    private func formatOffset(_ offset: Double) -> String {
        let ms = offset * 1000
        if abs(ms) < 1 {
            return String(format: "%+.3f ms", ms)
        } else if abs(ms) < 1000 {
            return String(format: "%+.1f ms", ms)
        } else {
            return String(format: "%+.2f s", offset)
        }
    }

    private func offsetColor(_ offset: Double) -> Color {
        let ms = abs(offset * 1000)
        if ms < 10 { return .green }
        if ms < 50 { return .blue }
        if ms < 200 { return .orange }
        return .red
    }
}
