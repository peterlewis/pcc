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
                // Standard 40-pt grid sizes. 480 × 640 is tall enough for the
                // full sidebar (15 items + section headers + safe-area
                // connection status) to render without the last row colliding
                // with the bottom inset, and wide enough to show form content
                // at a comfortable reading width. 480 is also wide enough for
                // the Text view's 10 recent messages to lay out cleanly.
                .frame(minWidth: 480, minHeight: 640)
                .onAppear {
                    dataSourceManager.serialManager = serialManager
                    weatherManager.serialManager = serialManager
                    appDelegate.setUp(serialManager: serialManager,
                                      dataSourceManager: dataSourceManager,
                                      ntpServer: ntpServer,
                                      trailStore: trailStore)
                    dataSourceManager.activate()
                    weatherManager.activate()
                    configManager.load()
                    ntpServer.serialManager = serialManager
                }
        }
        .windowResizability(.contentMinSize)
        .defaultSize(width: 800, height: 800)

        Settings {
            PreferencesView()
                .environmentObject(settings)
        }
    }
}
