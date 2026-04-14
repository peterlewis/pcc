import SwiftUI

enum SidebarItem: String, CaseIterable, Identifiable {
    case dataSources = "Data Sources"
    case connect = "Connect"
    case text = "Text"
    case weather = "Weather"
    case countdown = "Countdown"
    case brightness = "Brightness"
    case modes = "Modes"
    case diagnostics = "Diagnostics"
    case skyView = "Sky View"
    case map = "Map"
    case timeServer = "Time Server"
    case serialMonitor = "Serial Monitor"
    case advanced = "Advanced"
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
        case .skyView:        return "scope"
        case .map:            return "map"
        case .timeServer:     return "clock.badge.checkmark"
        case .serialMonitor:  return "terminal"
        case .advanced:       return "slider.horizontal.3"
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
    @State private var selectedItem: SidebarItem? = .dataSources

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedItem) {
                sidebarRow(.connect)

                Section("Display") {
                    sidebarRow(.dataSources)
                    sidebarRow(.text)
                    sidebarRow(.weather)
                    sidebarRow(.countdown)
                }

                Section("GPS") {
                    sidebarRow(.skyView)
                    sidebarRow(.map)
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
            }
            .listStyle(.sidebar)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(serialManager.isConnected ? .green : .red)
                        .frame(width: 8, height: 8)
                    Text(serialManager.isConnected
                         ? (serialManager.connectedPort?.name ?? "Connected")
                         : "Not connected")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .navigationSplitViewColumnWidth(min: 140, ideal: 160, max: 200)
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
                case .skyView:       SkyView()
                case .map:           SatelliteMapView()
                case .timeServer:    TimeServerView()
                case .serialMonitor: SerialMonitorView()
                case .advanced:      ClockSettingsView()
                case .updates:     UpdatesView()
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
    }

    @ViewBuilder
    private func sidebarRow(_ item: SidebarItem) -> some View {
        HStack {
            Label(item.rawValue, systemImage: item.icon)
            if isActiveMode(item) {
                Spacer()
                Circle().fill(.green).frame(width: 6, height: 6)
            }
        }
        .tag(item)
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
