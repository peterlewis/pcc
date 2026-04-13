import SwiftUI

struct ClockTextView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var settings: AppSettings
    @State private var text = ""
    @State private var textModeEnabled = false

    var body: some View {
        Form {
            Section("Display Text") {
                TextField("Display text", text: $text, prompt: Text("Enter text..."))
                    .labelsHidden()
                    .onSubmit { sendText() }

                HStack {
                    Text("\(text.count) / 20 characters")
                        .foregroundStyle(text.count > 20 ? .red : .secondary)
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
                Section("Recent") {
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
                }
            }
        }
        .formStyle(.grouped)
    }

    private func sendText() {
        guard !text.isEmpty, serialManager.isConnected else { return }
        serialManager.sendCommand("text = \(text)")
        if !textModeEnabled {
            textModeEnabled = true
            serialManager.sendCommand("mode_text = 1")
            serialManager.activeDisplayMode = .text
        }
        settings.addRecentText(text)
    }
}
