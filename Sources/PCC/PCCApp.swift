import SwiftUI
import AppKit

@main
struct PCCApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var serialManager = SerialManager()
    @StateObject private var settings = AppSettings()
    @StateObject private var dataSourceManager = DataSourceManager()
    @StateObject private var configManager = ConfigManager()

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
                .environmentObject(configManager)
                .frame(minWidth: 460, minHeight: 500)
                .onAppear {
                    dataSourceManager.serialManager = serialManager
                    appDelegate.setUp(serialManager: serialManager, dataSourceManager: dataSourceManager)
                    dataSourceManager.activate()
                    configManager.load()
                }
        }
        .windowResizability(.contentMinSize)
        .defaultSize(width: 580, height: 640)

        Settings {
            PreferencesView()
                .environmentObject(settings)
        }
    }
}
