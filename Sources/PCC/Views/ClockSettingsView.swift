import SwiftUI

struct ClockSettingsView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var configManager: ConfigManager
    @EnvironmentObject var settings: AppSettings
    @StateObject private var timezoneList = TimezoneListLoader()

    // Timezone
    @State private var timezoneOverride = ""
    @State private var timezoneSearch = ""

    // Config editor
    @State private var configEditorText = ""
    @State private var configEditorDirty = false
    @State private var savedToConfig = false

    // Matrix frequency
    @State private var matrixFrequency = "20000"

    // Accuracy tolerance
    @State private var tolerance1ms = "1000"
    @State private var tolerance10ms = "10000"
    @State private var tolerance100ms = "100000"

    // Fake GPS
    @State private var fakeLatitude = ""
    @State private var fakeLongitude = ""

    private var canSave: Bool {
        configManager.clockMounted && settings.configWriteEnabled
    }

    private var filteredTimezones: [String] {
        if timezoneSearch.isEmpty { return timezoneList.timezones }
        return timezoneList.timezones.filter { $0.localizedCaseInsensitiveContains(timezoneSearch) }
    }

    var body: some View {
        Form {
            Section {
                if timezoneList.timezones.isEmpty {
                    HStack {
                        TextField("IANA timezone", text: $timezoneOverride,
                                  prompt: Text("e.g. America/New_York"))
                            .onSubmit {
                                if !timezoneOverride.isEmpty {
                                    serialManager.sendCommand("ZONE_OVERRIDE = \(timezoneOverride)")
                                }
                            }
                        Button("Send") {
                            serialManager.sendCommand("ZONE_OVERRIDE = \(timezoneOverride)")
                        }
                        .disabled(timezoneOverride.isEmpty || !serialManager.isConnected)
                    }
                    if timezoneList.isLoading {
                        Text("Loading timezone list\u{2026}")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    TextField("Search timezones", text: $timezoneSearch)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(filteredTimezones.enumerated()), id: \.element) { _, tz in
                                Button {
                                    timezoneOverride = tz
                                    serialManager.sendCommand("ZONE_OVERRIDE = \(tz)")
                                } label: {
                                    HStack {
                                        Text(tz)
                                            .foregroundStyle(.primary)
                                        if tz == timezoneOverride {
                                            Spacer()
                                            Image(systemName: "checkmark")
                                                .foregroundStyle(.blue)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.vertical, 3)
                                    .padding(.horizontal, 4)
                                    .background(tz == timezoneOverride ? Color.blue.opacity(0.1) : Color.clear)
                                    .cornerRadius(4)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .frame(height: 200)
                }
                HStack {
                    if !timezoneOverride.isEmpty {
                        Text("Active: \(timezoneOverride)")
                            .font(.caption)
                            .foregroundStyle(.blue)
                    }
                    Spacer()
                    Button("Clear") {
                        timezoneOverride = ""
                        serialManager.sendCommand("ZONE_OVERRIDE = off")
                    }
                    .disabled(!serialManager.isConnected)
                    Button("Save") {
                        if timezoneOverride.isEmpty {
                            configManager.commentOut("ZONE_OVERRIDE")
                        } else {
                            configManager.setValue("ZONE_OVERRIDE", to: timezoneOverride)
                        }
                        flashSaved()
                    }
                    .disabled(!canSave)
                }
                Text("Case sensitive. Leave blank to calculate from GPS position. Use Etc/UTC for UTC, Etc/GMT+5 for UTC\u{2212}5 (POSIX sign inversion).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Timezone Override")
            }

            Section {
                HStack {
                    TextField("", text: $matrixFrequency)
                        .frame(width: 100)
                    Text("Hz")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Send") {
                        serialManager.sendCommand("MATRIX_FREQUENCY = \(matrixFrequency)")
                    }
                    .disabled(!serialManager.isConnected)
                    Button("Save") {
                        configManager.setValue("MATRIX_FREQUENCY", to: matrixFrequency)
                        flashSaved()
                    }
                    .disabled(!canSave)
                }
                Text("Display refresh rate, 1,000\u{2013}100,000 Hz. Default 20,000. Exact frequency depends on processor clock division.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Matrix Frequency")
            }

            Section {
                Text("After GPS fix is lost, digits are progressively hidden as accuracy drifts. Set a timeout of 0 to disable that level.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                    GridRow {
                        Text("Precision")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("Hide after (seconds)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Divider()
                    GridRow {
                        Text("\u{00B1}1 ms")
                        TextField("", text: $tolerance1ms)
                            .frame(width: 100)
                    }
                    GridRow {
                        Text("\u{00B1}10 ms")
                        TextField("", text: $tolerance10ms)
                            .frame(width: 100)
                    }
                    GridRow {
                        Text("\u{00B1}100 ms")
                        TextField("", text: $tolerance100ms)
                            .frame(width: 100)
                    }
                }

                HStack {
                    Button("Send") {
                        serialManager.sendCommand("Tolerance_time_1ms = \(tolerance1ms)")
                        serialManager.sendCommand("Tolerance_time_10ms = \(tolerance10ms)")
                        serialManager.sendCommand("Tolerance_time_100ms = \(tolerance100ms)")
                    }
                    .disabled(!serialManager.isConnected)
                    Spacer()
                    Button("Save") {
                        configManager.setValue("Tolerance_time_1ms", to: tolerance1ms)
                        configManager.setValue("Tolerance_time_10ms", to: tolerance10ms)
                        configManager.setValue("Tolerance_time_100ms", to: tolerance100ms)
                        flashSaved()
                    }
                    .disabled(!canSave)
                }
            } header: {
                Text("Accuracy Tolerance")
            }

            Section {
                HStack {
                    Text("Latitude")
                        .frame(width: 70, alignment: .leading)
                    TextField("0.0", text: $fakeLatitude)
                }
                HStack {
                    Text("Longitude")
                        .frame(width: 70, alignment: .leading)
                    TextField("0.0", text: $fakeLongitude)
                }
                HStack {
                    Button("Send") {
                        serialManager.sendCommand("fake_latitude = \(fakeLatitude)")
                        serialManager.sendCommand("fake_longitude = \(fakeLongitude)")
                    }
                    .disabled(fakeLatitude.isEmpty || fakeLongitude.isEmpty || !serialManager.isConnected)

                    Button("Disable") {
                        fakeLatitude = "0"
                        fakeLongitude = "0"
                        serialManager.sendCommand("fake_latitude = 0")
                        serialManager.sendCommand("fake_longitude = 0")
                    }
                    .disabled(!serialManager.isConnected)
                    Spacer()
                    Button("Save") {
                        configManager.setValue("fake_latitude", to: fakeLatitude.isEmpty ? "0" : fakeLatitude)
                        configManager.setValue("fake_longitude", to: fakeLongitude.isEmpty ? "0" : fakeLongitude)
                        flashSaved()
                    }
                    .disabled(!canSave)
                }
                Text("Override GPS position for timezone calculation. Set both to 0 to disable.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Fake GPS Position")
            }
            if savedToConfig || configManager.hasPreviousConfig {
                Section {
                    HStack {
                        Spacer()
                        undoAndSavedIndicator
                    }
                }
            }

            // TODO: Restore from backup UI — disabled pending testing
            // if configManager.configCorrupted { ... }

            Section {
                Toggle("Enable config.txt writing", isOn: $settings.configWriteEnabled)
                Text("Writing to the CLOCK USB volume can occasionally corrupt config.txt if the device disconnects mid-write. Local backups are kept at ~/Library/Application Support/PCC/config-backups/")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Config File Access")
            }

            Section {
                if configManager.clockMounted {
                    TextEditor(text: $configEditorText)
                        .font(.system(.caption, design: .monospaced))
                        .frame(height: 300)
                        .onChange(of: configEditorText) {
                            configEditorDirty = configEditorText != configManager.rawText
                        }
                    HStack {
                        if configEditorDirty {
                            Text("Unsaved changes")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                        Spacer()
                        Button("Revert") {
                            configEditorText = configManager.rawText
                            configEditorDirty = false
                        }
                        .disabled(!configEditorDirty)
                        Button("Save to clock") {
                            if configManager.saveRaw(configEditorText) {
                                configEditorDirty = false
                            }
                        }
                        .disabled(!configEditorDirty || !settings.configWriteEnabled)
                    }
                    if let error = configManager.error {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                } else {
                    HStack {
                        Image(systemName: "externaldrive")
                            .foregroundStyle(.secondary)
                        Text("CLOCK volume not mounted")
                            .foregroundStyle(.secondary)
                    }
                }
                Text("Edit config.txt directly. Changes are written to the CLOCK USB volume. The clock reads this file on power-up.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Config File")
            }
        }
        .formStyle(.grouped)
        .onAppear { loadFromConfig() }
    }

    private func loadFromConfig() {
        guard configManager.isLoaded else { return }
        timezoneOverride = configManager.value(forKey: "ZONE_OVERRIDE") ?? ""
        matrixFrequency = configManager.value(forKey: "MATRIX_FREQUENCY") ?? "20000"
        tolerance1ms = configManager.value(forKey: "Tolerance_time_1ms") ?? "1000"
        tolerance10ms = configManager.value(forKey: "Tolerance_time_10ms") ?? "10000"
        tolerance100ms = configManager.value(forKey: "Tolerance_time_100ms") ?? "100000"
        fakeLatitude = configManager.value(forKey: "fake_latitude") ?? ""
        fakeLongitude = configManager.value(forKey: "fake_longitude") ?? ""
        configEditorText = configManager.rawText
    }

    private func flashSaved() {
        guard configManager.save() else { return }
        savedToConfig = true
        configEditorText = configManager.rawText
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { savedToConfig = false }
    }

    private func undoSave() {
        if configManager.restorePrevious() { loadFromConfig() }
    }

    @ViewBuilder
    private var undoAndSavedIndicator: some View {
        if savedToConfig {
            Label("Saved", systemImage: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.green)
        }
        if configManager.hasPreviousConfig {
            Button("Undo Save") { undoSave() }
        }
    }
}
