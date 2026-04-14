import SwiftUI

struct ClockTextView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var settings: AppSettings
    @State private var text = ""

    private var textModeBinding: Binding<Bool> {
        Binding(
            get: { serialManager.activeDisplayMode == .text },
            set: { enabled in
                if enabled {
                    serialManager.activateDisplayMode(.text)
                    serialManager.sendCommand("mode_text = 1")
                } else {
                    serialManager.activateDisplayMode(.none)
                }
            }
        )
    }

    var body: some View {
        Form {
            Section("Display Text") {
                TextField("Text", text: $text, prompt: Text("Enter text..."))
                    .onSubmit { sendText() }

                HStack {
                    HStack(spacing: 3) {
                        if text.count > 10 {
                            Image(systemName: "arrow.left.arrow.right")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                        Text("\(text.count) / 10 characters")
                            .foregroundStyle(text.count > 10 ? .orange : .secondary)
                    }
                    .font(.caption)

                    Spacer()

                    Button("Send") { sendText() }
                        .disabled(text.isEmpty || !serialManager.isConnected)
                }

                Toggle("Text mode enabled", isOn: textModeBinding)

                if serialManager.activeDisplayMode != .text
                    && serialManager.activeDisplayMode != .none {
                    Label("\(serialManager.activeDisplayMode.rawValue) is currently using the display",
                          systemImage: "pause.circle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            if !settings.recentTexts.isEmpty {
                Section {
                    ForEach(settings.recentTexts, id: \.self) { recent in
                        HStack {
                            Text(recent)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Spacer()
                            Button("Send") {
                                text = recent
                                sendText()
                            }
                            .buttonStyle(.borderless)
                            .disabled(!serialManager.isConnected)
                        }
                    }
                } header: {
                    HStack {
                        Text("Recent")
                        Spacer()
                        Button("Clear") {
                            settings.recentTexts.removeAll()
                        }
                        .font(.caption)
                        .buttonStyle(.borderless)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    private func sendText() {
        guard !text.isEmpty, serialManager.isConnected else { return }
        if serialManager.activeDisplayMode != .text {
            serialManager.activateDisplayMode(.text)
            serialManager.sendCommand("mode_text = 1")
        }
        serialManager.sendScrollingText(text)
        settings.addRecentText(text)
    }
}
