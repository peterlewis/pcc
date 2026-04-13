import SwiftUI

struct ModesView: View {
    @EnvironmentObject var serialManager: SerialManager

    @State private var enabledModes: Set<String> = [
        "MODE_ISO8601_STD", "MODE_SHOW_OFFSET", "MODE_SHOW_TZ_NAME"
    ]
    @State private var colonMode = "slowfade"
    @State private var standbyEnabled = false

    private struct ModeItem: Identifiable {
        let id: String
        let label: String
    }

    private let timeModes: [ModeItem] = [
        ModeItem(id: "MODE_ISO8601_STD", label: "ISO 8601"),
        ModeItem(id: "MODE_UNIX", label: "Unix Timestamp"),
        ModeItem(id: "MODE_SHOW_OFFSET", label: "UTC Offset"),
        ModeItem(id: "MODE_SHOW_TZ_NAME", label: "Timezone Name"),
    ]

    private let dateModes: [ModeItem] = [
        ModeItem(id: "MODE_ISO_Ordinal", label: "Ordinal Date"),
        ModeItem(id: "MODE_ISO_WEEK", label: "ISO Week"),
        ModeItem(id: "MODE_JULIAN_DATE", label: "Julian Date"),
        ModeItem(id: "MODE_MODIFIED_JD", label: "Modified Julian Date"),
    ]

    private let weekdayModes: [ModeItem] = [
        ModeItem(id: "MODE_WEEKDAY", label: "Weekday"),
        ModeItem(id: "MODE_WEEKDA_DD", label: "Weekday + Day"),
        ModeItem(id: "MODE_WDY_MM_DD", label: "Wdy + Month-Day"),
    ]

    private let colonOptions: [(value: String, label: String)] = [
        ("slowfade", "Slow Fade"),
        ("heartbeat", "Heartbeat"),
        ("sawtooth", "Sawtooth"),
        ("alt_sawtooth", "Alt Sawtooth"),
        ("toggle", "Toggle"),
        ("solid", "Solid"),
    ]

    var body: some View {
        Form {
            Section("Time Display") {
                ForEach(timeModes) { mode in
                    Toggle(mode.label, isOn: modeBinding(for: mode.id))
                }
            }

            Section("Date Display") {
                ForEach(dateModes) { mode in
                    Toggle(mode.label, isOn: modeBinding(for: mode.id))
                }
            }

            Section {
                ForEach(weekdayModes) { mode in
                    Toggle(mode.label, isOn: modeBinding(for: mode.id))
                }
                Text("M and W render poorly on 7-segment display")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Weekday Display")
            }

            Section {
                Picker("Style", selection: $colonMode) {
                    ForEach(colonOptions, id: \.value) { option in
                        Text(option.label).tag(option.value)
                    }
                }
                .onChange(of: colonMode) { newValue in
                    serialManager.sendCommand("colon_mode = \(newValue)")
                }
                Text("Colons stop blinking when GPS fix is lost")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Colon Animation")
            }

            Section {
                Toggle("Standby Mode", isOn: $standbyEnabled)
                    .onChange(of: standbyEnabled) { newValue in
                        serialManager.sendCommand("MODE_STANDBY = \(newValue ? 1 : 0)")
                    }
                Text("Turns off all LEDs. GPS module stays powered.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Standby")
            }

            Section {
                Button("Send All Modes") {
                    sendAllModes()
                }
                .disabled(!serialManager.isConnected)
                Text("Re-sends the entire mode configuration above.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private func modeBinding(for id: String) -> Binding<Bool> {
        Binding(
            get: { enabledModes.contains(id) },
            set: { enabled in
                if enabled {
                    enabledModes.insert(id)
                } else {
                    enabledModes.remove(id)
                }
                serialManager.sendCommand("\(id) = \(enabled ? 1 : 0)")
            }
        )
    }

    private func sendAllModes() {
        let allModes = timeModes + dateModes + weekdayModes
        for mode in allModes {
            serialManager.sendCommand("\(mode.id) = \(enabledModes.contains(mode.id) ? 1 : 0)")
        }
        serialManager.sendCommand("MODE_STANDBY = \(standbyEnabled ? 1 : 0)")
        serialManager.sendCommand("colon_mode = \(colonMode)")
    }
}
