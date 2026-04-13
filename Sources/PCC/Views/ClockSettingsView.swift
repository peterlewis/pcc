import SwiftUI

struct ClockSettingsView: View {
    @EnvironmentObject var serialManager: SerialManager
    @StateObject private var timezoneList = TimezoneListLoader()

    // Timezone
    @State private var timezoneOverride = ""
    @State private var timezoneSearch = ""

    // NMEA
    @State private var nmeaMode = "off"

    // Matrix frequency
    @State private var matrixFrequency = "20000"

    // Accuracy tolerance
    @State private var tolerance1ms = "1000"
    @State private var tolerance10ms = "10000"
    @State private var tolerance100ms = "100000"

    // Fake GPS
    @State private var fakeLatitude = ""
    @State private var fakeLongitude = ""

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
                }
                Text("Case sensitive. Leave blank to calculate from GPS position. Use Etc/UTC for UTC, Etc/GMT+5 for UTC\u{2212}5 (POSIX sign inversion).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Timezone Override")
            }

            Section {
                Picker("Serial output", selection: $nmeaMode) {
                    Text("All").tag("all")
                    Text("RMC").tag("RMC")
                    Text("Off").tag("off")
                }
                .pickerStyle(.segmented)
                .onChange(of: nmeaMode) { newValue in
                    serialManager.sendCommand("NMEA = \(newValue)")
                }
                Text("Controls GPS NMEA sentences on USB serial. The app sets this to Off on connect and All on disconnect.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("NMEA Output")
            }

            Section {
                HStack {
                    TextField("Hz", text: $matrixFrequency)
                        .frame(width: 80)
                    Text("Hz")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Send") {
                        serialManager.sendCommand("MATRIX_FREQUENCY = \(matrixFrequency)")
                    }
                    .disabled(!serialManager.isConnected)
                }
                Text("Display refresh rate, 1,000\u{2013}100,000 Hz. Default 20,000. Exact frequency depends on processor clock division.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Matrix Frequency")
            }

            Section {
                HStack {
                    Text("1 ms")
                        .frame(width: 50, alignment: .leading)
                    TextField("seconds", text: $tolerance1ms)
                        .frame(width: 80)
                    Text("s without GPS fix")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text("10 ms")
                        .frame(width: 50, alignment: .leading)
                    TextField("seconds", text: $tolerance10ms)
                        .frame(width: 80)
                    Text("s without GPS fix")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text("100 ms")
                        .frame(width: 50, alignment: .leading)
                    TextField("seconds", text: $tolerance100ms)
                        .frame(width: 80)
                    Text("s since RTC calibration")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Button("Send Tolerances") {
                    serialManager.sendCommand("Tolerance_time_1ms = \(tolerance1ms)")
                    serialManager.sendCommand("Tolerance_time_10ms = \(tolerance10ms)")
                    serialManager.sendCommand("Tolerance_time_100ms = \(tolerance100ms)")
                }
                .disabled(!serialManager.isConnected)

                Text("Digits are progressively hidden as accuracy degrades after GPS fix loss. Set all to 0 to disable the feature entirely.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
                }
                Text("Override GPS position for timezone calculation. Set both to 0 to disable.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Fake GPS Position")
            }
            Section {
                VStack(spacing: 12) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 36))
                        .foregroundStyle(.secondary)
                    Text("Coming Soon")
                        .font(.headline)
                    Text("Read and write config.txt via USB mass storage.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            } header: {
                Text("Config File")
            }
        }
        .formStyle(.grouped)
    }
}
