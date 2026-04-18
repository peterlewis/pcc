import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusBarController: StatusBarController?

    func setUp(serialManager: SerialManager,
               dataSourceManager: DataSourceManager,
               ntpServer: NTPServer,
               trailStore: SkyTrailStore) {
        guard statusBarController == nil else { return }
        statusBarController = StatusBarController(
            serialManager: serialManager,
            dataSourceManager: dataSourceManager,
            ntpServer: ntpServer,
            trailStore: trailStore
        )
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationDidResignActive(_ notification: Notification) {
        let hasVisibleWindow = NSApp.windows.contains { $0.isVisible && $0.canBecomeMain }
        if !hasVisibleWindow {
            NSApp.setActivationPolicy(.accessory)
        }
    }
}
