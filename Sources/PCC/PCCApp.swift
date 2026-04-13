import SwiftUI
import AppKit

@main
struct PCCApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var serialManager = SerialManager()
    @StateObject private var settings = AppSettings()
    @StateObject private var dataSourceManager = DataSourceManager()

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
                .frame(minWidth: 460, minHeight: 400)
                .onAppear {
                    dataSourceManager.serialManager = serialManager
                    appDelegate.setUp(serialManager: serialManager, dataSourceManager: dataSourceManager)
                    dataSourceManager.activate()
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
