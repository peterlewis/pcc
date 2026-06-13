import AppKit
import Combine

class AppDelegate: NSObject, NSApplicationDelegate {
    // App-global services live here, not in the SwiftUI `App`, so their
    // lifecycle is the process's rather than any window's. Wiring them in
    // `applicationDidFinishLaunching` (instead of a view's `onAppear`) means
    // background services — trail recording, NTP, data-source polling, the
    // status item itself — exist even if no window is ever presented, and
    // are created exactly once rather than once per window recreation.
    let serialManager = SerialManager()
    let settings = AppSettings()
    let dataSourceManager = DataSourceManager()
    let weatherManager = WeatherManager()
    let configManager = ConfigManager()
    let ntpServer = NTPServer()
    let trailStore = SkyTrailStore()
    let updateManager = UpdateManager()

    var statusBarController: StatusBarController?
    private var cancellables: Set<AnyCancellable> = []

    /// Whether this delegate currently holds the "Trail Logger" NMEA/tracking
    /// consumer registrations. Guarding releases on this flag means a launch
    /// with recording off never issues a release it didn't pair with a
    /// request (which could otherwise steal another consumer's refcount).
    private var trailConsumerActive = false

    /// Held while recording so App Nap doesn't throttle the GSV pipeline's
    /// timers when every window is closed or occluded.
    private var recordingActivity: NSObjectProtocol?

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Accessory policy before any UI exists, so no Dock icon flashes in.
        NSApp.setActivationPolicy(.accessory)
        ProcessInfo.processInfo.processName = "Precision Clock Companion"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        dataSourceManager.serialManager = serialManager
        weatherManager.serialManager = serialManager

        statusBarController = StatusBarController(
            serialManager: serialManager,
            dataSourceManager: dataSourceManager,
            ntpServer: ntpServer,
            trailStore: trailStore
        )

        dataSourceManager.activate()
        weatherManager.activate()
        configManager.load()
        // Assigned last: the didSet auto-starts the NTP server if it was
        // enabled previously, and it reads GPS state through this reference.
        ntpServer.serialManager = serialManager

        // Satellite trail ingestion, independent of any window (the old
        // view-driven `.onChange` wiring stopped recording the moment the
        // last window closed — GitHub issue #9).
        serialManager.$satellites
            .sink { [weak self] sats in
                self?.trailStore.update(satellites: sats)
            }
            .store(in: &cancellables)

        // Recording lifecycle: register/release the NMEA + tracking consumer
        // and hold an App Nap exemption while logging. `$isLogging` replays
        // the current value on subscription, so a default-on store registers
        // immediately without any view appearing first.
        trailStore.$isLogging
            .removeDuplicates()
            .sink { [weak self] logging in
                self?.setTrailRecording(logging)
            }
            .store(in: &cancellables)

        // Keep the serial scroll timer in lockstep with the stored
        // preference; replays the persisted value at launch.
        settings.$scrollInterval
            .sink { [weak self] interval in
                self?.serialManager.setScrollInterval(interval)
            }
            .store(in: &cancellables)
    }

    private func setTrailRecording(_ on: Bool) {
        guard on != trailConsumerActive else { return }
        trailConsumerActive = on
        if on {
            serialManager.requestSatelliteTracking()
            serialManager.requestNMEA(consumer: "Trail Logger")
            recordingActivity = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiated],
                reason: "Recording satellite passes"
            )
        } else {
            serialManager.releaseSatelliteTracking()
            serialManager.releaseNMEA(consumer: "Trail Logger")
            if let activity = recordingActivity {
                ProcessInfo.processInfo.endActivity(activity)
                recordingActivity = nil
            }
        }
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
