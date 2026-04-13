import SwiftUI

struct WeatherView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var weatherService: WeatherService
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        Form {
            Section("Weather Display") {
                Toggle("Enable weather mode", isOn: $weatherService.isEnabled)
                    .onChange(of: weatherService.isEnabled) { enabled in
                        if enabled {
                            serialManager.activeDisplayMode = .weather
                        } else {
                            serialManager.sendCommand("mode_text = 0")
                            serialManager.activeDisplayMode = .none
                        }
                    }

                Picker("Display format", selection: $settings.weatherDisplayFormat) {
                    ForEach(WeatherDisplayFormat.allCases) { format in
                        Text(format.rawValue).tag(format)
                    }
                }
            }

            Section("Current Weather") {
                if let weather = weatherService.currentWeather {
                    LabeledContent("Temperature") {
                        Text(formatTemperature(weather.temperature))
                    }
                    LabeledContent("Conditions") {
                        Text(weather.conditionCode)
                    }
                    LabeledContent("Wind") {
                        Text(formatWindSpeed(weather.windSpeed))
                    }
                    LabeledContent("Display string") {
                        Text(weatherService.displayString)
                            .monospaced()
                            .bold()
                    }
                } else {
                    Text("No data yet")
                        .foregroundStyle(.secondary)
                }
            }

            Section("Status") {
                if let time = weatherService.lastFetchTime {
                    LabeledContent("Last fetch") {
                        Text(time, style: .relative)
                    }
                }
                if let next = weatherService.nextFetchTime {
                    LabeledContent("Next fetch") {
                        Text(next, style: .relative)
                    }
                }
                if let error = weatherService.lastError {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            }

            Section {
                HStack {
                    Image(systemName: "cloud.fill")
                        .foregroundStyle(.secondary)
                    Link("Powered by Apple Weather",
                         destination: URL(string: "https://weather-data.apple.com/legal-attribution.html")!)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }

    private func formatTemperature(_ celsius: Double) -> String {
        if settings.temperatureUnit == .fahrenheit {
            return String(format: "%.1f °F", celsius * 9.0 / 5.0 + 32.0)
        }
        return String(format: "%.1f °C", celsius)
    }

    private func formatWindSpeed(_ kmh: Double) -> String {
        switch settings.windSpeedUnit {
        case .mph:   return String(format: "%.0f mph", kmh * 0.621371)
        case .kmh:   return String(format: "%.0f km/h", kmh)
        case .ms:    return String(format: "%.1f m/s", kmh / 3.6)
        case .knots: return String(format: "%.0f kn", kmh * 0.539957)
        }
    }
}
