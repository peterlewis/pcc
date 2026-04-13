import SwiftUI
import AppKit

struct PreferencesView: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        TabView {
            weatherCredentialsTab
                .tabItem { Label("WeatherKit", systemImage: "cloud") }

            locationTab
                .tabItem { Label("Location", systemImage: "location") }

            unitsTab
                .tabItem { Label("Units", systemImage: "ruler") }
        }
        .frame(width: 450, height: 280)
    }

    // MARK: - Tabs

    private var weatherCredentialsTab: some View {
        Form {
            TextField("Team ID", text: $settings.weatherTeamID)
                .help("Your 10-character Apple Developer Team ID")
            TextField("Service ID", text: $settings.weatherServiceID)
                .help("e.g. com.example.weatherkit")
            TextField("Key ID", text: $settings.weatherKeyID)
                .help("10-character key identifier")

            HStack {
                TextField("Path to .p8 key file", text: $settings.weatherP8KeyPath)
                Button("Browse...") {
                    let panel = NSOpenPanel()
                    panel.canChooseDirectories = false
                    panel.allowsMultipleSelection = false
                    panel.message = "Select your WeatherKit .p8 private key"
                    if panel.runModal() == .OK, let url = panel.url {
                        settings.weatherP8KeyPath = url.path
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    private var locationTab: some View {
        Form {
            TextField("Latitude", value: $settings.latitude, format: .number)
            TextField("Longitude", value: $settings.longitude, format: .number)

            Text("Default: 51.4043, -2.3234 (Bath, UK)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }

    private var unitsTab: some View {
        Form {
            Picker("Temperature", selection: $settings.temperatureUnit) {
                Text("Celsius (C)").tag(TemperatureUnit.celsius)
                Text("Fahrenheit (F)").tag(TemperatureUnit.fahrenheit)
            }

            Picker("Wind speed", selection: $settings.windSpeedUnit) {
                ForEach(WindSpeedUnit.allCases) { unit in
                    Text(unit.rawValue).tag(unit)
                }
            }

            HStack {
                TextField("Poll interval", value: $settings.weatherPollInterval, format: .number)
                Text("seconds (30-600)")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}
