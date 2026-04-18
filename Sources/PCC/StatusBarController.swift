import AppKit

class StatusBarController: NSObject, NSMenuDelegate {
    private let statusItem: NSStatusItem
    private let serialManager: SerialManager
    private let dataSourceManager: DataSourceManager
    private let ntpServer: NTPServer
    private let trailStore: SkyTrailStore
    private var appearanceObserver: NSKeyValueObservation?

    private var redModeEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "redModeEnabled") }
        set {
            UserDefaults.standard.set(newValue, forKey: "redModeEnabled")
            updateIcon()
        }
    }

    init(serialManager: SerialManager,
         dataSourceManager: DataSourceManager,
         ntpServer: NTPServer,
         trailStore: SkyTrailStore) {
        self.serialManager = serialManager
        self.dataSourceManager = dataSourceManager
        self.ntpServer = ntpServer
        self.trailStore = trailStore
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        updateIcon()

        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        // Redraw icon when system appearance changes
        appearanceObserver = NSApp.observe(\.effectiveAppearance) { [weak self] _, _ in
            self?.updateIcon()
        }
    }

    // MARK: - NSMenuDelegate

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        // Connection status
        let statusTitle = serialManager.isConnected
            ? "Connected: \(serialManager.connectedPort?.name ?? "Unknown")"
            : "Not connected"
        let statusMenuItem = NSMenuItem(title: statusTitle, action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)

        // Data source values (if active)
        if dataSourceManager.isActive && !dataSourceManager.enabledSources.isEmpty {
            for source in dataSourceManager.enabledSources {
                let value = dataSourceManager.lastValues[source.id] ?? "\u{2014}"
                let isCurrent = dataSourceManager.currentDisplayedSource?.id == source.id
                let prefix = isCurrent ? "\u{25B6} " : "   "
                let title = "\(prefix)\(source.name): \(value)"
                let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                item.isEnabled = false
                menu.addItem(item)
            }
        }

        // Satellite trail recording — runs as a background service whether
        // or not the Sky panel is visible, so it belongs in the menu bar
        // alongside the other always-on services. The leading dot mirrors
        // the red recording indicator used on the Sky panel's Record button,
        // and the pass count gives a quick sanity check that data is
        // actually accumulating.
        if trailStore.isLogging {
            menu.addItem(.separator())
            let count = trailStore.allPasses.count
            let title = count == 0
                ? "\u{25CF} Recording satellites (waiting for data)"
                : "\u{25CF} Recording satellites (\(count) pass\(count == 1 ? "" : "es"))"
            let recItem = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            recItem.isEnabled = false
            menu.addItem(recItem)
        }

        // NTP server status
        if ntpServer.isRunning {
            menu.addItem(.separator())
            var ntpTitle = "NTP: serving on port \(ntpServer.port)"
            if ntpServer.queriesServed > 0 {
                ntpTitle += " (\(ntpServer.queriesServed) queries)"
            }
            let ntpItem = NSMenuItem(title: ntpTitle, action: nil, keyEquivalent: "")
            ntpItem.isEnabled = false
            menu.addItem(ntpItem)

            if let offset = ntpServer.timeOffset {
                let ms = offset * 1000
                let offsetStr: String
                if abs(ms) < 1 {
                    offsetStr = String(format: "%+.3f ms", ms)
                } else if abs(ms) < 1000 {
                    offsetStr = String(format: "%+.1f ms", ms)
                } else {
                    offsetStr = String(format: "%+.2f s", offset)
                }
                let offsetItem = NSMenuItem(title: "   System clock skew: \(offsetStr)", action: nil, keyEquivalent: "")
                offsetItem.isEnabled = false
                menu.addItem(offsetItem)
            }
        }

        menu.addItem(.separator())

        // Clock actions
        var hasClockAction = false

        if NSEvent.modifierFlags.contains(.option) {
            let redItem = NSMenuItem(title: "Red Mode", action: #selector(toggleRedMode), keyEquivalent: "")
            redItem.target = self
            redItem.state = redModeEnabled ? .on : .off
            menu.addItem(redItem)
            hasClockAction = true
        }

        if serialManager.isConnected {
            let rebootItem = NSMenuItem(title: "Reboot Clock", action: #selector(rebootClock), keyEquivalent: "")
            rebootItem.target = self
            menu.addItem(rebootItem)
            hasClockAction = true
        }

        if hasClockAction {
            menu.addItem(.separator())
        }

        // Show window
        let showItem = NSMenuItem(title: "Open Precision Clock Companion", action: #selector(showWindow), keyEquivalent: "0")
        showItem.target = self
        menu.addItem(showItem)

        // Quit
        let quitItem = NSMenuItem(title: "Quit Precision Clock Companion", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
    }

    // MARK: - Icon

    private func updateIcon() {
        statusItem.button?.image = makeSevenSegmentIcon()
    }

    private func makeSevenSegmentIcon() -> NSImage {
        let useRed = redModeEnabled
        let size = NSSize(width: 11, height: 17)
        let image = NSImage(size: size, flipped: true) { _ in
            (useRed ? NSColor(red: 0.9, green: 0.15, blue: 0.1, alpha: 1.0) : NSColor.black).setFill()

            func hex(_ points: [(CGFloat, CGFloat)]) {
                let path = NSBezierPath()
                path.move(to: NSPoint(x: points[0].0, y: points[0].1))
                for p in points.dropFirst() { path.line(to: NSPoint(x: p.0, y: p.1)) }
                path.close()
                path.fill()
            }

            let s: CGFloat = 0.5

            // a: top horizontal
            hex([(5,2),(7,0),(15,0),(17,2),(15,4),(7,4)].map { ($0.0*s, $0.1*s) })
            // f: top-left vertical
            hex([(2,5),(4,7),(4,13),(2,15),(0,13),(0,7)].map { ($0.0*s, $0.1*s) })
            // b: top-right vertical
            hex([(20,5),(22,7),(22,13),(20,15),(18,13),(18,7)].map { ($0.0*s, $0.1*s) })
            // g: middle horizontal
            hex([(5,17),(7,15),(15,15),(17,17),(15,19),(7,19)].map { ($0.0*s, $0.1*s) })
            // e: bottom-left vertical
            hex([(2,19),(4,21),(4,27),(2,29),(0,27),(0,21)].map { ($0.0*s, $0.1*s) })
            // c: bottom-right vertical
            hex([(20,19),(22,21),(22,27),(20,29),(18,27),(18,21)].map { ($0.0*s, $0.1*s) })
            // d: bottom horizontal
            hex([(5,32),(7,30),(15,30),(17,32),(15,34),(7,34)].map { ($0.0*s, $0.1*s) })

            return true
        }
        image.isTemplate = !useRed
        image.accessibilityDescription = "PCC"
        return image
    }

    // MARK: - Actions

    @objc private func toggleRedMode() {
        redModeEnabled.toggle()
    }

    @objc private func showWindow() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            // Window was destroyed by SwiftUI — recreate it.
            // Dispatch async so the menu bar is set up after the policy change,
            // then invoke the same "New Window" action that Cmd+N uses.
            DispatchQueue.main.async {
                if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
                    window.makeKeyAndOrderFront(nil)
                    return
                }
                if let menuItem = NSApp.mainMenu?.items.lazy
                    .compactMap({ $0.submenu })
                    .flatMap({ $0.items })
                    .first(where: { $0.keyEquivalent == "n" && $0.keyEquivalentModifierMask == .command }),
                   let action = menuItem.action {
                    NSApp.sendAction(action, to: menuItem.target, from: nil)
                }
            }
        }
    }

    @objc private func rebootClock() {
        serialManager.rebootClock()
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

}
