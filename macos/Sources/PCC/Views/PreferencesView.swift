import SwiftUI
import AppKit

/// App-wide preferences. Location is intentionally absent: lat/lon are read
/// from the clock's GPS fix so there's only one place the position can come
/// from. Users who want to override should fake the GPS output, not the app.
struct PreferencesView: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
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
        .frame(width: 420, height: 160)
    }
}
