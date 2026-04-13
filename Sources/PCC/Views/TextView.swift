import SwiftUI

struct ClockTextView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var settings: AppSettings
    @State private var text = ""
    @State private var textModeEnabled = false

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

                Toggle("Text mode enabled", isOn: $textModeEnabled)
                    .onChange(of: textModeEnabled) { newValue in
                        serialManager.sendCommand("mode_text = \(newValue ? 1 : 0)")
                        serialManager.activeDisplayMode = newValue ? .text : .none
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
        if !textModeEnabled {
            textModeEnabled = true
            serialManager.sendCommand("mode_text = 1")
            serialManager.activeDisplayMode = .text
        }
        serialManager.sendScrollingText(text)
        settings.addRecentText(text)
    }
}
