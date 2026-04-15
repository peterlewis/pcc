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
    case advanced = "Advanced"
    case documentation = "Mk IV User Manual"
    case gpsDiagnostics = "Signal Analysis"
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
        case .advanced:       return "slider.horizontal.3"
        case .documentation:  return "book"
        case .gpsDiagnostics: return "sparkles"
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
    @State private var selectedItem: SidebarItem? = .dataSources

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
                case .advanced:      ClockSettingsView()
                case .updates:     UpdatesView()
                case .documentation: DocumentationView()
                case .gpsDiagnostics: GPSDiagnosticsView()
                case nil:          Text("Select a panel")
                }
            }
            .frame(minWidth: 300)
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
        // Background satellite trail recording — runs regardless of active pane
        .onChange(of: trailStore.isLogging) { _, logging in
            if logging {
                serialManager.requestSatelliteTracking()
                serialManager.requestNMEA(consumer: "Trail Logger")
            } else {
                serialManager.releaseSatelliteTracking()
                serialManager.releaseNMEA(consumer: "Trail Logger")
                trailStore.save()
            }
        }
        .onChange(of: serialManager.satellites) { _, sats in
            trailStore.record(sats)
        }
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
                sidebarRow(.gpsDiagnostics)
            }

            Section("Configuration") {
                sidebarRow(.brightness)
                sidebarRow(.modes)
                sidebarRow(.timeServer)
                sidebarRow(.diagnostics)
                sidebarRow(.serialMonitor)
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
        switch item {
        // Compact — simple forms
        case .connect, .countdown:
            return 550
        // Medium — lists and status panels
        case .text, .diagnostics, .gpsDiagnostics:
            return 650
        // Standard — tables and scrollable content
        case .serialMonitor:
            return 700
        // Tall — charts, rich visuals
        case .dataSources, .weather, .brightness, .sky, .modes, .updates, .documentation:
            return 800
        // Full — dense settings
        case .advanced, .timeServer:
            return 900
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
