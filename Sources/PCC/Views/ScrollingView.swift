import SwiftUI

/// App-side scroll-speed control.
///
/// Lives under **Configuration** in the sidebar but is deliberately framed
/// as a Mac-side setting, not a clock setting — scroll timing is driven by
/// `SerialManager`'s timer on the Mac (it pushes `text = ` frames to the
/// clock at the configured interval), so nothing here writes to the clock's
/// persistent config. The header copy makes that explicit so the user
/// doesn't hunt for a Save / Apply button, and doesn't worry that changes
/// will or won't survive a clock power-cycle.
///
/// Affects every mode that scrolls: Text, Weather, Data Sources.
struct ScrollingView: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        Form {
            Section {
                Picker("Speed", selection: $settings.scrollInterval) {
                    Text("Slow").tag(0.55)
                    Text("Normal").tag(0.40)
                    Text("Fast").tag(0.28)
                    Text("Very fast").tag(0.18)
                }
                .pickerStyle(.segmented)

                Text("Speed at which text longer than 10 characters marches across the clock display. Applies to Text, Weather, and Data Source scrolling. Changes take effect immediately.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                HStack(spacing: 6) {
                    Image(systemName: "laptopcomputer")
                    Text("App setting — stored on this Mac")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            } footer: {
                Text("This setting governs how fast the Mac sends new frames to the clock. It is not written to the clock's config and does not persist on the clock across a power cycle — it always follows what this Mac is configured to send.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}
