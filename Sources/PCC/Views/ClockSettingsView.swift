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
    @State private var matrixFrequency = 20000

    // Accuracy tolerance
    @State private var tolerance1ms = 1000
    @State private var tolerance10ms = 10000
    @State private var tolerance100ms = 100000

    // Fake GPS — 0,0 is the firmware's documented "disabled" position, so it
    // doubles as the unset default.
    @State private var fakeLatitude: Double = 0
    @State private var fakeLongitude: Double = 0

    // Corruption recovery
    @State private var showRestoreConfirm = false
    @State private var restoreError: String?

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
                    TextField("", value: clamped($matrixFrequency, to: 1_000...100_000),
                              format: .number)
                        .frame(width: 100)
                    Text("Hz")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Send") {
                        serialManager.sendCommand("MATRIX_FREQUENCY = \(matrixFrequency)")
                    }
                    .disabled(!serialManager.isConnected)
                    Button("Save") {
                        configManager.setValue("MATRIX_FREQUENCY", to: String(matrixFrequency))
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
                        TextField("", value: clamped($tolerance1ms, to: 0...Int.max),
                                  format: .number)
                            .frame(width: 100)
                    }
                    GridRow {
                        Text("\u{00B1}10 ms")
                        TextField("", value: clamped($tolerance10ms, to: 0...Int.max),
                                  format: .number)
                            .frame(width: 100)
                    }
                    GridRow {
                        Text("\u{00B1}100 ms")
                        TextField("", value: clamped($tolerance100ms, to: 0...Int.max),
                                  format: .number)
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
                        configManager.setValue("Tolerance_time_1ms", to: String(tolerance1ms))
                        configManager.setValue("Tolerance_time_10ms", to: String(tolerance10ms))
                        configManager.setValue("Tolerance_time_100ms", to: String(tolerance100ms))
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
                    // Up to 6 fraction digits (~0.1 m): the default .number
                    // style rounds to 3, which would corrupt a pasted GPS
                    // coordinate by ~100 m on commit.
                    TextField("0.0", value: clamped($fakeLatitude, to: -90...90),
                              format: .number.precision(.fractionLength(0...6)))
                }
                HStack {
                    Text("Longitude")
                        .frame(width: 70, alignment: .leading)
                    TextField("0.0", value: clamped($fakeLongitude, to: -180...180),
                              format: .number.precision(.fractionLength(0...6)))
                }
                HStack {
                    Button("Send") {
                        serialManager.sendCommand("fake_latitude = \(fakeLatitude)")
                        serialManager.sendCommand("fake_longitude = \(fakeLongitude)")
                    }
                    .disabled(!serialManager.isConnected)

                    Button("Disable") {
                        fakeLatitude = 0
                        fakeLongitude = 0
                        serialManager.sendCommand("fake_latitude = 0")
                        serialManager.sendCommand("fake_longitude = 0")
                    }
                    .disabled(!serialManager.isConnected)
                    Spacer()
                    Button("Save") {
                        configManager.setValue("fake_latitude", to: String(fakeLatitude))
                        configManager.setValue("fake_longitude", to: String(fakeLongitude))
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

            if configManager.configCorrupted {
                Section {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.yellow)
                        Text(configManager.error ?? "config.txt appears corrupted")
                            .font(.caption)
                        Spacer()
                        Button("Restore from Backup\u{2026}") {
                            showRestoreConfirm = true
                        }
                        .disabled(!canSave)
                    }
                    if let restoreError {
                        Text(restoreError)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    Text("Replaces config.txt on the clock with the most recent local backup.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Recovery")
                }
            }

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
        .alert("Restore config.txt?", isPresented: $showRestoreConfirm) {
            Button("Restore", role: .destructive) { restoreFromBackup() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This overwrites config.txt on the clock with the most recent local backup from ~/Library/Application Support/PCC/config-backups/.")
        }
    }

    /// Recovery path for a corrupted config.txt: restorePrevious() writes the
    /// newest valid local backup back to the clock and re-adopts it as the
    /// loaded config (clearing `configCorrupted`), so afterwards the panels
    /// can be re-seeded from it like any normal load.
    private func restoreFromBackup() {
        if configManager.restorePrevious() {
            restoreError = nil
            loadFromConfig()
        } else {
            // restorePrevious() sets configManager.error for write failures
            // but returns bare false when no usable backup exists.
            restoreError = configManager.error ?? "No valid local backup found."
        }
    }

    private func loadFromConfig() {
        guard configManager.isLoaded else { return }
        timezoneOverride = configManager.value(forKey: "ZONE_OVERRIDE") ?? ""
        // Unparseable on-device values fall back to the firmware defaults —
        // the same ones used before anything is loaded.
        matrixFrequency = configManager.value(forKey: "MATRIX_FREQUENCY").flatMap(Int.init) ?? 20000
        tolerance1ms = configManager.value(forKey: "Tolerance_time_1ms").flatMap(Int.init) ?? 1000
        tolerance10ms = configManager.value(forKey: "Tolerance_time_10ms").flatMap(Int.init) ?? 10000
        tolerance100ms = configManager.value(forKey: "Tolerance_time_100ms").flatMap(Int.init) ?? 100000
        fakeLatitude = configManager.value(forKey: "fake_latitude").flatMap(Double.init) ?? 0
        fakeLongitude = configManager.value(forKey: "fake_longitude").flatMap(Double.init) ?? 0
        configEditorText = configManager.rawText
    }

    // MARK: - Clamped numeric bindings

    /// Mirrors the clamping-binding pattern BrightnessView uses for its
    /// ADC/DAC fields: `TextField(value:format:)` rejects non-numeric input
    /// outright, and the binding clamps out-of-range commits — so nonsense
    /// like "MATRIX_FREQUENCY = abc" or a latitude of 999 can no longer reach
    /// the serial port or be written into config.txt.
    private func clamped<V: Comparable>(_ value: Binding<V>, to range: ClosedRange<V>) -> Binding<V> {
        Binding(
            get: { value.wrappedValue },
            set: { value.wrappedValue = min(range.upperBound, max(range.lowerBound, $0)) }
        )
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
