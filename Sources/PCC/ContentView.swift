import SwiftUI
import AppKit

enum SidebarItem: String, CaseIterable, Identifiable {
    case dataSources = "Data Sources"
    case connect = "Connect"
    case text = "Text"
    case weather = "Weather"
    case countdown = "Countdown"
    case brightness = "Brightness"
    case modes = "Modes"
    case diagnostics = "Diagnostics"
    case sky = "Satellites"
    case timeServer = "Time Server"
    case serialMonitor = "Serial Monitor"
    case scrolling = "Scrolling"
    case advanced = "Advanced"
    case documentation = "Mk IV User Manual"
    case updates = "Updates"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .connect:     return "cable.connector"
        case .text:        return "textformat"
        case .weather:     return "cloud.sun"
        case .dataSources: return "antenna.radiowaves.left.and.right"
        case .countdown:   return "timer"
        case .brightness:  return "sun.max"
        case .modes:       return "list.bullet"
        case .diagnostics:    return "gauge"
        case .sky:            return "scope"
        case .timeServer:     return "clock.badge.checkmark"
        case .serialMonitor:  return "terminal"
        case .scrolling:      return "text.line.first.and.arrowtriangle.forward"
        case .advanced:       return "slider.horizontal.3"
        case .documentation:  return "book"
        case .updates:     return "arrow.triangle.2.circlepath"
        }
    }
}

extension Notification.Name {
    static let navigateToPanel = Notification.Name("navigateToPanel")
}

struct ContentView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var ntpServer: NTPServer
    @EnvironmentObject var trailStore: SkyTrailStore
    // Initial pane is Data Sources unless overridden via the argument domain
    // (`open PCC.app --args -pccInitialPane Satellites`) — lets scripted runs
    // and release verification land on a specific pane without UI driving.
    @State private var selectedItem: SidebarItem? =
        UserDefaults.standard.string(forKey: "pccInitialPane")
            .flatMap(SidebarItem.init(rawValue:)) ?? .dataSources

    var body: some View {
        NavigationSplitView {
            sidebarList
        } detail: {
            Group {
                switch selectedItem {
                case .connect:     ConnectView()
                case .text:        ClockTextView()
                case .weather:     WeatherView()
                case .countdown:   CountdownView()
                case .dataSources:  DataSourcesView()
                case .brightness:  BrightnessView()
                case .modes:       ModesView()
                case .diagnostics:    DiagnosticsView()
                case .sky:           SkyView()
                case .timeServer:    TimeServerView()
                case .serialMonitor: SerialMonitorView()
                case .scrolling:     ScrollingView()
                case .advanced:      ClockSettingsView()
                case .updates:     UpdatesView()
                case .documentation: DocumentationView()
                case nil:          Text("Select a panel")
                }
            }
            .frame(minWidth: 320)
        }
        .navigationTitle("Precision Clock Companion")
        .onReceive(NotificationCenter.default.publisher(for: .navigateToPanel)) { notification in
            if let item = notification.object as? SidebarItem {
                selectedItem = item
            }
        }
        .onChange(of: selectedItem) { _, newItem in
            guard let newItem, let window = NSApp.keyWindow else { return }
            let idealHeight = idealHeight(for: newItem)
            var frame = window.frame
            guard abs(frame.height - idealHeight) > 20 else { return }
            let delta = idealHeight - frame.height
            frame.origin.y -= delta
            frame.size.height = idealHeight
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.25
                ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                window.animator().setFrame(frame, display: true)
            }
        }
        // Trail recording, satellite ingestion, and scroll-interval wiring
        // are app-global concerns owned by AppDelegate — deliberately not
        // wired here, so they survive window close/recreation (issue #9)
        // and never double-register when a second window opens.
    }

    private var sidebarList: some View {
        List(selection: $selectedItem) {
            sidebarRow(.connect)

            Section("Display") {
                sidebarRow(.dataSources)
                sidebarRow(.text)
                sidebarRow(.weather)
                sidebarRow(.countdown)
            }

            Section("GPS") {
                sidebarRow(.sky)
            }

            Section("Configuration") {
                sidebarRow(.brightness)
                sidebarRow(.modes)
                sidebarRow(.timeServer)
                sidebarRow(.diagnostics)
                sidebarRow(.serialMonitor)
                sidebarRow(.scrolling)
                sidebarRow(.advanced)
                sidebarRow(.updates)
            }

            Section("Reference") {
                sidebarRow(.documentation)
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 6) {
                // Connection status
                HStack(spacing: 5) {
                    Circle()
                        .fill(serialManager.isConnected ? .green : .red)
                        .frame(width: 8, height: 8)
                    Text(serialManager.isConnected ? "Connected" : "Not connected")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .navigationSplitViewColumnWidth(min: 140, ideal: 160, max: 200)
    }

    @ViewBuilder
    private func sidebarRow(_ item: SidebarItem) -> some View {
        let active = isActiveMode(item)
        let recording = (item == .sky && trailStore.isLogging)
        HStack {
            Label(item.rawValue, systemImage: item.icon)
            if active || recording {
                Spacer()
                Circle()
                    .fill(recording ? .red : .green)
                    .frame(width: 6, height: 6)
            }
        }
        .tag(item)
    }

    private func idealHeight(for item: SidebarItem) -> CGFloat {
        // Standard sizes on a 40-pt grid. The compact tier matches the
        // window's minHeight so short forms don't trigger a pointless resize
        // animation on first select; everything richer steps up in 80-pt
        // increments from there.
        switch item {
        case .connect, .countdown, .scrolling:
            return 640   // = window minHeight
        case .text, .diagnostics:
            return 720
        case .serialMonitor:
            return 760
        case .dataSources, .weather, .brightness, .modes, .updates, .documentation:
            return 800
        case .sky, .advanced, .timeServer:
            return 880
        }
    }

    private func isActiveMode(_ item: SidebarItem) -> Bool {
        if item == .timeServer { return ntpServer.isRunning }
        switch (item, serialManager.activeDisplayMode) {
        case (.text, .text), (.weather, .weather), (.countdown, .countdown), (.dataSources, .dataSource):
            return true
        default:
            return false
        }
    }
}
