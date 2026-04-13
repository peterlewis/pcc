import SwiftUI

struct CountdownView: View {
    @EnvironmentObject var serialManager: SerialManager
    @State private var targetDate = Date().addingTimeInterval(3600)
    @State private var isCountdownActive = false

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
                        serialManager.sendCommand("mode_countdown = 1")
                        isCountdownActive = true
                        serialManager.activeDisplayMode = .countdown
                    }
                    .disabled(!serialManager.isConnected)

                    Button("Stop", role: .destructive) {
                        serialManager.sendCommand("mode_countdown = 0")
                        isCountdownActive = false
                        serialManager.activeDisplayMode = .none
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
                }
            }
        }
        .formStyle(.grouped)
    }
}
