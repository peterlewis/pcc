import SwiftUI

@main
struct PrecisionClockApp: App {
    @StateObject private var serialManager = SerialManager()
    @StateObject private var settings = AppSettings()
    @StateObject private var weatherService = WeatherService()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(serialManager)
                .environmentObject(settings)
                .environmentObject(weatherService)
                .frame(minWidth: 460, minHeight: 350)
                .onAppear {
                    weatherService.serialManager = serialManager
                }
        }
        .windowResizability(.contentMinSize)
        .defaultSize(width: 500, height: 520)

        Settings {
            PreferencesView()
                .environmentObject(settings)
        }
    }
}
