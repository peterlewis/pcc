import SwiftUI

struct DiagnosticsView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var configManager: ConfigManager
    @EnvironmentObject var settings: AppSettings

    @State private var debugBrightness = false
    @State private var debugRTC = false
    @State private var satview = false
    @State private var vbat = false
    @State private var firmwareCRC = false
    @State private var displayTest = false
    @State private var ttff = false
    @State private var savedToConfig = false

    var body: some View {
        Form {
            Section("Diagnostic Modes") {
                Toggle("Brightness ADC/DAC", isOn: $debugBrightness)
                    .onChange(of: debugBrightness) { _, newValue in
                        serialManager.sendCommand("MODE_DEBUG_BRIGHTNESS = \(newValue ? 1 : 0)")
                    }

                Toggle("RTC Calibration", isOn: $debugRTC)
                    .onChange(of: debugRTC) { _, newValue in
                        serialManager.sendCommand("MODE_DEBUG_RTC = \(newValue ? 1 : 0)")
                    }

                Toggle("Satellite View", isOn: $satview)
                    .onChange(of: satview) { _, newValue in
                        serialManager.sendCommand("mode_satview = \(newValue ? 1 : 0)")
                    }

                Toggle("Battery Voltage", isOn: $vbat)
                    .onChange(of: vbat) { _, newValue in
                        serialManager.sendCommand("mode_vbat = \(newValue ? 1 : 0)")
                    }

                Toggle("Firmware CRC", isOn: $firmwareCRC)
                    .onChange(of: firmwareCRC) { _, newValue in
                        serialManager.sendCommand("MODE_FIRMWARE_CRC = \(newValue ? 1 : 0)")
                    }

                Toggle("Display Test", isOn: $displayTest)
                    .onChange(of: displayTest) { _, newValue in
                        serialManager.sendCommand("MODE_DISPLAYTEST = \(newValue ? 1 : 0)")
                    }

                Toggle("Time to First Fix", isOn: $ttff)
                    .onChange(of: ttff) { _, newValue in
                        serialManager.sendCommand("MODE_TTFF = \(newValue ? 1 : 0)")
                    }
            }

            Section {
                HStack {
                    Button("Apply") {
                        sendAllDiagnostics()
                    }
                    .disabled(!serialManager.isConnected)
                    Spacer()
                    if savedToConfig {
                        Label("Saved", systemImage: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                    if configManager.hasPreviousConfig {
                        Button("Undo Save") {
                            if configManager.restorePrevious() { loadFromConfig() }
                        }
                    }
                    Button("Revert") {
                        loadFromConfig()
                    }
                    .disabled(!configManager.isLoaded)
                    Button("Save") {
                        saveDiagnosticsToConfig()
                    }
                    .disabled(!configManager.clockMounted || !settings.configWriteEnabled)
                }
                Text("Enabled modes are added to the button cycle. TTFF must remain selected for an accurate measurement.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Changes take effect immediately but reset on power cycle unless saved.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { loadFromConfig() }
    }

    /// Single source of truth pairing each config key with the @State toggle
    /// that backs it. Load, save, and send all iterate this table — keeping
    /// three hand-maintained copies of the key list let them drift apart
    /// (and previously they did exist in triplicate, with this table itself
    /// declared but unused). A computed property because @State projections
    /// ($foo) can't be referenced from a stored-property initializer.
    private var diagKeys: [(key: String, state: Binding<Bool>)] {
        [
            ("MODE_DEBUG_BRIGHTNESS", $debugBrightness),
            ("MODE_DEBUG_RTC", $debugRTC),
            ("mode_satview", $satview),
            ("mode_vbat", $vbat),
            ("MODE_FIRMWARE_CRC", $firmwareCRC),
            ("MODE_DISPLAYTEST", $displayTest),
            ("MODE_TTFF", $ttff),
        ]
    }

    private func loadFromConfig() {
        guard configManager.isLoaded else { return }
        for (key, state) in diagKeys {
            if let v = configManager.bool(forKey: key) { state.wrappedValue = v }
        }
    }

    private func saveDiagnosticsToConfig() {
        for (key, state) in diagKeys {
            configManager.setValue(key, to: state.wrappedValue ? "enabled" : "disabled")
        }
        if configManager.save() {
            savedToConfig = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { savedToConfig = false }
        }
    }

    private func sendAllDiagnostics() {
        for (key, state) in diagKeys {
            serialManager.sendCommand("\(key) = \(state.wrappedValue ? 1 : 0)")
        }
    }
}
