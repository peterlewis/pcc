import SwiftUI

struct WeatherView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var weatherManager: WeatherManager

    private var isWeatherActive: Bool {
        serialManager.activeDisplayMode == .weather
    }

    var body: some View {
        Form {
            Section {
                Toggle("Enable Weather", isOn: Binding(
                    get: { weatherManager.isEnabled },
                    set: { weatherManager.isEnabled = $0 }
                ))

                if weatherManager.isEnabled {
                    if isWeatherActive, !weatherManager.displayString.isEmpty {
                        HStack {
                            Text("Showing")
                                .foregroundStyle(.secondary)
                            Text(weatherManager.displayString)
                            Spacer()
                            if weatherManager.displayString.count > 10 {
                                Image(systemName: "arrow.left.arrow.right")
                                    .font(.caption2)
                                    .foregroundStyle(.orange)
                            }
                        }
                        .font(.caption)
                    } else if serialManager.activeDisplayMode != .weather
                                && serialManager.activeDisplayMode != DisplayMode.none {
                        HStack {
                            Label("\(serialManager.activeDisplayMode.rawValue) is using the display",
                                  systemImage: "pause.circle")
                                .font(.caption)
                                .foregroundStyle(.orange)
                            Spacer()
                            Button("Resume") {
                                weatherManager.resumeDisplay()
                            }
                            .disabled(!serialManager.isConnected)
                        }
                    }
                }
            }

            if weatherManager.isEnabled {
                Section("Current Weather") {
                    if let error = weatherManager.lastError {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }

                    if !weatherManager.temperature.isEmpty {
                        LabeledContent("Temperature", value: weatherManager.temperature)
                        LabeledContent("Condition", value: weatherManager.condition)
                        LabeledContent("Wind", value: weatherManager.windSpeed)
                        LabeledContent("Humidity", value: weatherManager.humidity)
                    } else if weatherManager.lastError == nil {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text("Fetching...").foregroundStyle(.secondary)
                        }
                    }

                    if let time = weatherManager.lastFetchTime {
                        LabeledContent("Last updated") {
                            Text(time, style: .relative)
                                .foregroundStyle(.secondary)
                                .font(.caption)
                        }
                    }

                    Button("Refresh Now") {
                        weatherManager.fetchNow()
                    }
                    .disabled(!serialManager.isConnected && weatherManager.lastFetchTime == nil)
                }

                Section("Display") {
                    Picker("Format", selection: $settings.weatherDisplayFormat) {
                        ForEach(WeatherDisplayFormat.allCases) { format in
                            Text(format.rawValue).tag(format)
                        }
                    }

                    if !weatherManager.displayString.isEmpty {
                        LabeledContent("Preview") {
                            Text(weatherManager.displayString)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(weatherManager.displayString.count > 10 ? .orange : .primary)
                        }
                        if weatherManager.displayString.count > 10 {
                            Text("Longer than 10 characters: will scroll on the clock.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Settings") {
                    Picker("Temperature", selection: $settings.temperatureUnit) {
                        Text("Celsius").tag(TemperatureUnit.celsius)
                        Text("Fahrenheit").tag(TemperatureUnit.fahrenheit)
                    }

                    Picker("Wind speed", selection: $settings.windSpeedUnit) {
                        ForEach(WindSpeedUnit.allCases) { unit in
                            Text(unit.rawValue).tag(unit)
                        }
                    }

                    Picker("Update every", selection: $settings.weatherPollInterval) {
                        Text("2 minutes").tag(120.0)
                        Text("5 minutes").tag(300.0)
                        Text("15 minutes").tag(900.0)
                        Text("30 minutes").tag(1800.0)
                    }
                }

                Section("Location") {
                    TextField("Latitude", value: $settings.latitude, format: .number)
                    TextField("Longitude", value: $settings.longitude, format: .number)
                    Text("Set your location for accurate weather data.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .onChange(of: settings.weatherDisplayFormat) { _, _ in weatherManager.fetchNow() }
        .onChange(of: settings.temperatureUnit) { _, _ in weatherManager.fetchNow() }
        .onChange(of: settings.windSpeedUnit) { _, _ in weatherManager.fetchNow() }
    }
}
