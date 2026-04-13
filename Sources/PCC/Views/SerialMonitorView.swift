import SwiftUI

struct SerialMonitorView: View {
    @EnvironmentObject var serialManager: SerialManager

    @State private var nmeaMode = "off"
    @State private var autoScroll = true

    var body: some View {
        VStack(spacing: 0) {
            // Toolbar
            GroupBox {
                HStack {
                    Picker("NMEA", selection: $nmeaMode) {
                        Text("Off").tag("off")
                        Text("RMC").tag("RMC")
                        Text("All").tag("all")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 180)
                    .onChange(of: nmeaMode) { newValue in
                        serialManager.sendCommand("NMEA = \(newValue)")
                    }

                    Spacer()

                    Toggle("Auto-scroll", isOn: $autoScroll)
                        .toggleStyle(.checkbox)

                    Button {
                        serialManager.clearSerialLog()
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.borderless)
                    .help("Clear log")
                }
                .padding(2)
            }
            .padding(.horizontal)
            .padding(.top, 8)

            // Log view
            ScrollViewReader { proxy in
                ScrollView {
                    Text(serialManager.serialLog.isEmpty ? "Waiting for data\u{2026}" : serialManager.serialLog)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(serialManager.serialLog.isEmpty ? .secondary : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(8)
                        .id("logBottom")
                }
                .background(Color(.textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .padding(.horizontal)
                .padding(.top, 4)
                .onChange(of: serialManager.serialLog) { _ in
                    if autoScroll {
                        withAnimation(.none) {
                            proxy.scrollTo("logBottom", anchor: .bottom)
                        }
                    }
                }
            }

            // Info
            GroupBox {
                VStack(alignment: .leading, spacing: 4) {
                    Text("PCC disables NMEA output on connect so serial commands work reliably. Enable it here to watch the raw GPS feed. Output is restored when PCC disconnects.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("This setting is session-only \u{2014} it doesn\u{2019}t need saving to config.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(2)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        .onAppear {
            serialManager.serialLogEnabled = true
        }
        .onDisappear {
            serialManager.serialLogEnabled = false
            if nmeaMode != "off" {
                nmeaMode = "off"
                serialManager.sendCommand("NMEA = off")
            }
        }
    }
}
