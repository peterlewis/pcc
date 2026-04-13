import SwiftUI
import AppKit

struct PreferencesView: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        TabView {
            locationTab
                .tabItem { Label("Location", systemImage: "location") }

            unitsTab
                .tabItem { Label("Units", systemImage: "ruler") }
        }
        .frame(width: 450, height: 220)
    }

    // MARK: - Tabs

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

}
        .formStyle(.grouped)
    }
}
