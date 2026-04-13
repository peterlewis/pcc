import SwiftUI

struct DiagnosticsView: View {
    @EnvironmentObject var serialManager: SerialManager

    @State private var debugBrightness = false
    @State private var debugRTC = false
    @State private var satview = false
    @State private var vbat = false
    @State private var firmwareCRC = false
    @State private var displayTest = false
    @State private var ttff = false

    var body: some View {
        Form {
            Section("Diagnostic Modes") {
                Toggle("Brightness ADC/DAC", isOn: $debugBrightness)
                    .onChange(of: debugBrightness) { newValue in
                        serialManager.sendCommand("MODE_DEBUG_BRIGHTNESS = \(newValue ? 1 : 0)")
                    }

                Toggle("RTC Calibration", isOn: $debugRTC)
                    .onChange(of: debugRTC) { newValue in
                        serialManager.sendCommand("MODE_DEBUG_RTC = \(newValue ? 1 : 0)")
                    }

                Toggle("Satellite View", isOn: $satview)
                    .onChange(of: satview) { newValue in
                        serialManager.sendCommand("mode_satview = \(newValue ? 1 : 0)")
                    }

                Toggle("Battery Voltage", isOn: $vbat)
                    .onChange(of: vbat) { newValue in
                        serialManager.sendCommand("mode_vbat = \(newValue ? 1 : 0)")
                    }

                Toggle("Firmware CRC", isOn: $firmwareCRC)
                    .onChange(of: firmwareCRC) { newValue in
                        serialManager.sendCommand("MODE_FIRMWARE_CRC = \(newValue ? 1 : 0)")
                    }

                Toggle("Display Test", isOn: $displayTest)
                    .onChange(of: displayTest) { newValue in
                        serialManager.sendCommand("MODE_DISPLAYTEST = \(newValue ? 1 : 0)")
                    }

                Toggle("Time to First Fix", isOn: $ttff)
                    .onChange(of: ttff) { newValue in
                        serialManager.sendCommand("MODE_TTFF = \(newValue ? 1 : 0)")
                    }
            }

            Section {
                Text("Enabled diagnostic modes are added to the button cycle on the clock.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("TTFF must remain selected on the clock display for an accurate measurement.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}
