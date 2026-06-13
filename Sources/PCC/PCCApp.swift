import SwiftUI
import AppKit

@main
struct PCCApp: App {
    // The delegate owns every app-global service (see AppDelegate.swift);
    // scenes only attach those objects to their view trees. The adaptor
    // creates the delegate before `body` is first evaluated, so the
    // references below are always valid.
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appDelegate.serialManager)
                .environmentObject(appDelegate.settings)
                .environmentObject(appDelegate.dataSourceManager)
                .environmentObject(appDelegate.weatherManager)
                .environmentObject(appDelegate.configManager)
                .environmentObject(appDelegate.ntpServer)
                .environmentObject(appDelegate.trailStore)
                .environmentObject(appDelegate.updateManager)
                // Standard 40-pt grid sizes. 480 × 640 is tall enough for the
                // full sidebar (15 items + section headers + safe-area
                // connection status) to render without the last row colliding
                // with the bottom inset, and wide enough to show form content
                // at a comfortable reading width. 480 is also wide enough for
                // the Text view's 10 recent messages to lay out cleanly.
                .frame(minWidth: 480, minHeight: 640)
        }
        .windowResizability(.contentMinSize)
        .defaultSize(width: 800, height: 800)

        Settings {
            PreferencesView()
                .environmentObject(appDelegate.settings)
        }
    }
}
