import SwiftUI

enum SidebarItem: String, CaseIterable, Identifiable {
    case connect = "Connect"
    case text = "Text"
    case weather = "Weather"
    case countdown = "Countdown"
    case brightness = "Brightness"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .connect:    return "cable.connector"
        case .text:       return "textformat"
        case .weather:    return "cloud.sun"
        case .countdown:  return "timer"
        case .brightness: return "sun.max"
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var serialManager: SerialManager
    @State private var selectedItem: SidebarItem? = .connect
    @State private var pendingItem: SidebarItem?
    @State private var showSwitchAlert = false

    private var hasActiveMode: Bool {
        serialManager.activeDisplayMode != .none
    }

    private var selectionBinding: Binding<SidebarItem?> {
        Binding(
            get: { selectedItem },
            set: { newItem in
                guard newItem != selectedItem else { return }
                if hasActiveMode {
                    pendingItem = newItem
                    showSwitchAlert = true
                } else {
                    selectedItem = newItem
                }
            }
        )
    }

    var body: some View {
        NavigationSplitView {
            List(selection: selectionBinding) {
                ForEach(SidebarItem.allCases) { item in
                    HStack {
                        Label(item.rawValue, systemImage: item.icon)
                        if isActiveMode(item) {
                            Spacer()
                            Circle().fill(.green).frame(width: 6, height: 6)
                        }
                    }
                    .tag(item)
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 140, ideal: 160, max: 200)
        } detail: {
            Group {
                switch selectedItem {
                case .connect:    ConnectView()
                case .text:       ClockTextView()
                case .weather:    WeatherView()
                case .countdown:  CountdownView()
                case .brightness: BrightnessView()
                case nil:         Text("Select a panel")
                }
            }
            .frame(minWidth: 300)
        }
        .navigationTitle("Precision Clock")
        .toolbar {
            ToolbarItem(placement: .status) {
                HStack(spacing: 4) {
                    Circle()
                        .fill(serialManager.isConnected ? .green : .gray)
                        .frame(width: 8, height: 8)
                    Text(serialManager.isConnected ? "Connected" : "Disconnected")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .alert("Switch Panel?", isPresented: $showSwitchAlert) {
            Button("Switch") {
                selectedItem = pendingItem
                pendingItem = nil
            }
            Button("Stay", role: .cancel) {
                pendingItem = nil
            }
        } message: {
            Text("\(serialManager.activeDisplayMode.rawValue) is active on the clock.")
        }
    }

    private func isActiveMode(_ item: SidebarItem) -> Bool {
        switch (item, serialManager.activeDisplayMode) {
        case (.text, .text), (.weather, .weather), (.countdown, .countdown):
            return true
        default:
            return false
        }
    }
}
