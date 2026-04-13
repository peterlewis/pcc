import AppKit

class StatusBarController: NSObject, NSMenuDelegate {
    private let statusItem: NSStatusItem
    private let serialManager: SerialManager
    private let dataSourceManager: DataSourceManager
    private var appearanceObserver: NSKeyValueObservation?

    private var redModeEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "redModeEnabled") }
        set {
            UserDefaults.standard.set(newValue, forKey: "redModeEnabled")
            updateIcon()
        }
    }

    init(serialManager: SerialManager, dataSourceManager: DataSourceManager) {
        self.serialManager = serialManager
        self.dataSourceManager = dataSourceManager
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

        menu.addItem(.separator())

        // Data sources toggle
        let toggleItem = NSMenuItem(title: "Data Sources", action: #selector(toggleDataSources), keyEquivalent: "")
        toggleItem.target = self
        toggleItem.state = dataSourceManager.isActive ? .on : .off
        menu.addItem(toggleItem)

        // Show enabled sources with values
        for source in dataSourceManager.enabledSources {
            let value = dataSourceManager.lastValues[source.id] ?? "\u{2014}"
            let isCurrent = dataSourceManager.currentDisplayedSource?.id == source.id
            let prefix = isCurrent ? "\u{25B6} " : "   "
            let title = "\(prefix)\(source.name): \(value)"
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        menu.addItem(.separator())

        // Show window
        let showItem = NSMenuItem(title: "Show Window", action: #selector(showWindow), keyEquivalent: "0")
        showItem.target = self
        menu.addItem(showItem)

        // Option held — reveal easter egg toggle
        if NSEvent.modifierFlags.contains(.option) {
            let redItem = NSMenuItem(title: "Red Mode", action: #selector(toggleRedMode), keyEquivalent: "")
            redItem.target = self
            redItem.state = redModeEnabled ? .on : .off
            menu.addItem(redItem)
        }

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
        if let url = Bundle.module.url(forResource: "menubar-icon", withExtension: "svg"),
           let image = NSImage(contentsOf: url) {
            image.size = NSSize(width: 10, height: 17)
            image.isTemplate = !redModeEnabled
            image.accessibilityDescription = "PCC"
            return image
        }
        // Fallback: empty image if resource missing
        let image = NSImage(size: NSSize(width: 10, height: 17))
        image.accessibilityDescription = "PCC"
        return image
    }

    // MARK: - Actions

    @objc private func toggleRedMode() {
        redModeEnabled.toggle()
    }

    @objc private func toggleDataSources() {
        dataSourceManager.setEnabled(!dataSourceManager.isActive)
    }

    @objc private func showWindow() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            // Window was destroyed by SwiftUI — create a new one
            NSApp.sendAction(Selector(("newWindowForTab:")), to: nil, from: nil)
        }
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }
}
