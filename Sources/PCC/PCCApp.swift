import SwiftUI
import AppKit

@main
struct PCCApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var serialManager = SerialManager()
    @StateObject private var settings = AppSettings()
    @StateObject private var dataSourceManager = DataSourceManager()
    @StateObject private var weatherManager = WeatherManager()
    @StateObject private var configManager = ConfigManager()
    @StateObject private var ntpServer = NTPServer()
    @StateObject private var trailStore = SkyTrailStore()

    init() {
        NSApplication.shared.setActivationPolicy(.accessory)
        ProcessInfo.processInfo.processName = "Precision Clock Companion"
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(serialManager)
                .environmentObject(settings)
                .environmentObject(dataSourceManager)
                .environmentObject(weatherManager)
                .environmentObject(configManager)
                .environmentObject(ntpServer)
                .environmentObject(trailStore)
                .frame(minWidth: 460, minHeight: 500)
                .onAppear {
                    dataSourceManager.serialManager = serialManager
                    weatherManager.serialManager = serialManager
                    appDelegate.setUp(serialManager: serialManager, dataSourceManager: dataSourceManager, ntpServer: ntpServer)
                    dataSourceManager.activate()
                    weatherManager.activate()
                    configManager.load()
                    ntpServer.serialManager = serialManager
                }
        }
        .windowResizability(.contentMinSize)
        .defaultSize(width: 700, height: 800)

        Settings {
            PreferencesView()
                .environmentObject(settings)
        }
    }
}
