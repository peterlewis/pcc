import SwiftUI
import Darwin

struct PortProcess: Identifiable {
    let id = UUID()
    let command: String
    let pid: Int
    let user: String
}

struct ConnectView: View {
    @EnvironmentObject var serialManager: SerialManager
    @State private var selectedPortPath = ""
    @State private var portProcesses: [PortProcess] = []
    @State private var hasCheckedPort = false
    @State private var showKillConfirmation = false
    @State private var processToKill: PortProcess?

    var body: some View {
        Form {
            Section("Serial Port") {
                HStack {
                    Picker("Port", selection: $selectedPortPath) {
                        Text("Select a port...").tag("")
                        ForEach(serialManager.availablePorts, id: \.path) { port in
                            Text(port.path).tag(port.path)
                        }
                    }

                    Button {
                        serialManager.refreshPorts()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .help("Refresh port list")
                }

                HStack {
                    if serialManager.isConnected {
                        Button("Disconnect", role: .destructive) {
                            serialManager.disconnect()
                        }
                    } else {
                        Button("Connect") {
                            guard let port = serialManager.availablePorts
                                .first(where: { $0.path == selectedPortPath }) else { return }
                            serialManager.connect(to: port)
                        }
                        .disabled(selectedPortPath.isEmpty)

                        if !selectedPortPath.isEmpty {
                            Button("Diagnose") {
                                checkPort()
                            }
                            .help("Check if another process is using this port")
                        }
                    }
                }
            }

            Section("Status") {
                HStack {
                    Circle()
                        .fill(serialManager.isConnected ? .green : .red)
                        .frame(width: 10, height: 10)
                    Text(serialManager.statusMessage)
                        .foregroundStyle(.secondary)
                }

                if let error = serialManager.lastError {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                }

                if serialManager.isConnected, let port = serialManager.connectedPort {
                    LabeledContent("Device") {
                        Text(port.path)
                            .font(.caption)
                            .textSelection(.enabled)
                    }

                    Button("Reboot Clock") {
                        serialManager.rebootClock()
                    }
                }
            }

            if hasCheckedPort {
                Section("Port Diagnostics") {
                    if portProcesses.isEmpty {
                        Text("No processes are using this port.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(portProcesses) { proc in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(proc.command).bold()
                                    Text("PID \(proc.pid) (\(proc.user))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Kill", role: .destructive) {
                                    processToKill = proc
                                    showKillConfirmation = true
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            if selectedPortPath.isEmpty {
                selectedPortPath = UserDefaults.standard.string(forKey: "lastSerialPort") ?? ""
            }
        }
        .alert("Kill Process?", isPresented: $showKillConfirmation) {
            Button("Kill", role: .destructive) {
                if let proc = processToKill {
                    kill(pid_t(proc.pid), SIGTERM)
                    // Re-check after a moment
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        checkPort()
                        serialManager.refreshPorts()
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let proc = processToKill {
                Text("Send SIGTERM to \(proc.command) (PID \(proc.pid))?")
            }
        }
    }

    private func checkPort() {
        guard !selectedPortPath.isEmpty else { return }

        DispatchQueue.global(qos: .userInitiated).async {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
            proc.arguments = [selectedPortPath]
            let pipe = Pipe()
            proc.standardOutput = pipe
            proc.standardError = Pipe()

            do {
                try proc.run()
                proc.waitUntilExit()
            } catch {
                return
            }

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            let lines = output.components(separatedBy: "\n").dropFirst()

            let found = lines.compactMap { line -> PortProcess? in
                let cols = line.split(separator: " ", omittingEmptySubsequences: true)
                guard cols.count >= 3, let pid = Int(cols[1]) else { return nil }
                return PortProcess(command: String(cols[0]), pid: pid, user: String(cols[2]))
            }

            DispatchQueue.main.async {
                self.portProcesses = found
                self.hasCheckedPort = true
            }
        }
    }
}
