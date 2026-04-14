import SwiftUI

struct CountdownView: View {
    @EnvironmentObject var serialManager: SerialManager
    @State private var targetDate = Date().addingTimeInterval(3600)

    private var isCountdownActive: Bool {
        serialManager.activeDisplayMode == .countdown
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    var body: some View {
        Form {
            Section("Countdown Target") {
                DatePicker("Target date & time",
                           selection: $targetDate,
                           in: Date()...,
                           displayedComponents: [.date, .hourAndMinute])

                Text("UTC: \(Self.isoFormatter.string(from: targetDate))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            Section {
                HStack {
                    Button("Start Countdown") {
                        let utc = Self.isoFormatter.string(from: targetDate)
                        serialManager.sendCommand("countdown_to = \(utc)")
                        serialManager.activateDisplayMode(.countdown)
                        serialManager.sendCommand("mode_countdown = 1")
                    }
                    .disabled(!serialManager.isConnected)

                    Button("Stop", role: .destructive) {
                        serialManager.activateDisplayMode(.none)
                    }
                    .disabled(!serialManager.isConnected || !isCountdownActive)
                }

                if isCountdownActive {
                    HStack {
                        Circle()
                            .fill(.green)
                            .frame(width: 8, height: 8)
                        Text("Countdown active")
                            .foregroundStyle(.secondary)
                    }
                } else if serialManager.activeDisplayMode != .none {
                    Label("\(serialManager.activeDisplayMode.rawValue) is currently using the display",
                          systemImage: "pause.circle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
        .formStyle(.grouped)
    }
}
