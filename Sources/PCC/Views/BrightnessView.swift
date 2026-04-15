import SwiftUI

struct BrightnessPoint: Equatable, Codable {
    var adc: Int
    var dac: Int
}

struct CustomBrightnessPreset: Identifiable, Codable {
    var id = UUID()
    var name: String
    var points: [BrightnessPoint]
}

enum CurvePreset: String, CaseIterable {
    case revC    = "Rev C (GL5528, R11=20K)"
    case gl5549  = "GL5549 (R11=470K)"
    case revD    = "Rev D (VTT9812FH, R11=470K)"

    var points: [BrightnessPoint] {
        switch self {
        case .revC: return [
            .init(adc: 0, dac: 0),      .init(adc: 1425, dac: 737),
            .init(adc: 2566, dac: 1601), .init(adc: 3396, dac: 2725),
            .init(adc: 4095, dac: 4095)
        ]
        case .gl5549: return [
            .init(adc: 0, dac: 0),      .init(adc: 1860, dac: 225),
            .init(adc: 3050, dac: 684),  .init(adc: 3920, dac: 2269),
            .init(adc: 4095, dac: 4095)
        ]
        case .revD: return [
            .init(adc: 0, dac: 0),      .init(adc: 131, dac: 365),
            .init(adc: 1076, dac: 1422), .init(adc: 2774, dac: 2665),
            .init(adc: 3849, dac: 4095)
        ]
        }
    }
}

struct BrightnessView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var configManager: ConfigManager
    @EnvironmentObject var settings: AppSettings
    @State private var brightness: Double = 0.5
    @State private var isManual = false
    @State private var needsReboot = false
    @State private var savedToConfig = false

    // Brightness curve
    @State private var curvePoints: [BrightnessPoint] = CurvePreset.revD.points
    @State private var draggingIndex: Int?

    // Custom presets
    @State private var customPresets: [CustomBrightnessPreset] = []
    @State private var showingSavePreset = false
    @State private var newPresetName = ""
    @State private var showing3DSurface = false

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                manualOverrideSection
                curveSection
            }
        }
        .onAppear {
            loadFromConfig()
            loadCustomPresets()
        }
        .alert("Save Preset", isPresented: $showingSavePreset) {
            TextField("Preset name", text: $newPresetName)
            Button("Save") {
                saveCurrentAsPreset()
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Enter a name for this brightness curve preset.")
        }
    }

    // MARK: - Custom Presets

    private func loadCustomPresets() {
        guard let data = UserDefaults.standard.data(forKey: "customBrightnessPresets"),
              let presets = try? JSONDecoder().decode([CustomBrightnessPreset].self, from: data)
        else { return }
        customPresets = presets
    }

    private func saveCustomPresets() {
        if let data = try? JSONEncoder().encode(customPresets) {
            UserDefaults.standard.set(data, forKey: "customBrightnessPresets")
        }
    }

    private func saveCurrentAsPreset() {
        guard !newPresetName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let preset = CustomBrightnessPreset(name: newPresetName.trimmingCharacters(in: .whitespaces), points: curvePoints)
        customPresets.append(preset)
        saveCustomPresets()
    }

    private func deletePreset(_ preset: CustomBrightnessPreset) {
        customPresets.removeAll { $0.id == preset.id }
        saveCustomPresets()
    }

    // MARK: - Config

    private func loadFromConfig() {
        guard configManager.isLoaded else { return }
        var loaded = [BrightnessPoint]()
        for i in 1...5 {
            if let pair = configManager.intPair(forKey: "BS\(i)") {
                loaded.append(BrightnessPoint(adc: pair.0, dac: pair.1))
            }
        }
        if loaded.count == 5 { curvePoints = loaded }
    }

    private func saveCurveToConfig() {
        for (i, p) in curvePoints.enumerated() {
            configManager.setValue("BS\(i+1)", to: "\(p.adc),\(p.dac)")
        }
        if configManager.save() {
            savedToConfig = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { savedToConfig = false }
        }
    }

    // MARK: - Manual Override

    private var manualOverrideSection: some View {
        GroupBox("Manual Override") {
            VStack(alignment: .leading, spacing: 8) {
                Toggle("Lock brightness", isOn: $isManual)
                    .onChange(of: isManual) { _, manual in
                        if manual {
                            needsReboot = false
                            serialManager.sendCommand(
                                "brightness = \(String(format: "%.3f", brightness))")
                        } else {
                            needsReboot = true
                        }
                    }

                if isManual {
                    HStack {
                        Slider(value: $brightness, in: 0...1, step: 0.01)
                            .onChange(of: brightness) { _, value in
                                guard isManual else { return }
                                serialManager.sendCommand(
                                    "brightness = \(String(format: "%.3f", value))")
                            }
                        Text(String(format: "%.0f%%", brightness * 100))
                            .monospacedDigit()
                            .frame(width: 40, alignment: .trailing)
                    }
                }

                if needsReboot {
                    HStack {
                        Text("Manual brightness persists until clock resets.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Reboot Clock") {
                            needsReboot = false
                            serialManager.rebootClock()
                        }
                        .disabled(!serialManager.isConnected)
                    }
                }

                Text("Useful when filming the clock.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(4)
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }

    // MARK: - Brightness Curve

    private var curveSection: some View {
        GroupBox("Brightness Curve") {
            VStack(spacing: 8) {
                // Interactive graph
                curveGraph
                    .frame(height: 200)
                    .clipShape(RoundedRectangle(cornerRadius: 4))

                // Axis labels
                HStack {
                    Text("ADC (sensor)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("DAC (brightness)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                // Point editors
                Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 4) {
                    GridRow {
                        Text("").frame(width: 30)
                        Text("ADC").font(.caption).foregroundStyle(.secondary)
                        Text("DAC").font(.caption).foregroundStyle(.secondary)
                        Text("").frame(width: 44)
                    }
                    ForEach(0..<5, id: \.self) { i in
                        GridRow {
                            Text("BS\(i + 1)")
                                .font(.system(.body, design: .monospaced))
                                .frame(width: 30)
                            TextField("ADC", value: adcBinding(i), format: .number)
                                .frame(width: 60)
                            TextField("DAC", value: dacBinding(i), format: .number)
                                .frame(width: 60)
                            Button("Send") {
                                let p = curvePoints[i]
                                serialManager.sendCommand("BS\(i+1) = \(p.adc),\(p.dac)")
                            }
                            .buttonStyle(.borderless)
                            .disabled(!serialManager.isConnected)
                        }
                    }
                }

                Divider()

                HStack {
                    Menu("Presets") {
                        Section("Factory") {
                            ForEach(CurvePreset.allCases, id: \.self) { preset in
                                Button(preset.rawValue) {
                                    curvePoints = preset.points
                                }
                            }
                        }
                        if !customPresets.isEmpty {
                            Section("Custom") {
                                ForEach(customPresets) { preset in
                                    Menu(preset.name) {
                                        Button("Load") {
                                            curvePoints = preset.points
                                        }
                                        Divider()
                                        Button("Delete", role: .destructive) {
                                            deletePreset(preset)
                                        }
                                    }
                                }
                            }
                        }
                        Divider()
                        Button("Revert to Saved") {
                            loadFromConfig()
                        }
                        .disabled(!configManager.isLoaded)
                        Button("Save Current as Preset\u{2026}") {
                            newPresetName = ""
                            showingSavePreset = true
                        }
                    }
                    Spacer()
                    if savedToConfig {
                        Label("Saved", systemImage: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                    if configManager.hasPreviousConfig {
                        Button("Undo Save") {
                            if configManager.restorePrevious() { loadFromConfig() }
                        }
                    }
                    Button("Save") {
                        saveCurveToConfig()
                    }
                    .disabled(!configManager.clockMounted || !settings.configWriteEnabled)
                    Button("Apply") {
                        for (i, p) in curvePoints.enumerated() {
                            serialManager.sendCommand("BS\(i+1) = \(p.adc),\(p.dac)")
                        }
                    }
                    .disabled(!serialManager.isConnected)

                    Button {
                        showing3DSurface = true
                    } label: {
                        Image(systemName: "cube")
                    }
                    .help("3D Surface Comparison")
                }

                Text("Apply sends the current curve to the clock. Settings reset on power cycle unless saved.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(4)
        }
        .padding(.horizontal)
        .padding(.top, 4)
        .sheet(isPresented: $showing3DSurface) {
            BrightnessSurfaceView(currentPoints: curvePoints)
                .frame(minWidth: 500, minHeight: 450)
        }
    }

    // MARK: - Curve Graph

    private var curveGraph: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height

            ZStack {
                // Background
                Rectangle().fill(Color(.textBackgroundColor))

                // Grid
                Path { p in
                    for i in 1...3 {
                        let x = CGFloat(i) * w / 4
                        p.move(to: CGPoint(x: x, y: 0))
                        p.addLine(to: CGPoint(x: x, y: h))
                        let y = CGFloat(i) * h / 4
                        p.move(to: CGPoint(x: 0, y: y))
                        p.addLine(to: CGPoint(x: w, y: y))
                    }
                }
                .stroke(.secondary.opacity(0.15), lineWidth: 0.5)

                // Diagonal reference (linear)
                Path { p in
                    p.move(to: CGPoint(x: 0, y: h))
                    p.addLine(to: CGPoint(x: w, y: 0))
                }
                .stroke(.secondary.opacity(0.1), style: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))

                // Curve
                Path { p in
                    for (i, pt) in curvePoints.enumerated() {
                        let x = CGFloat(pt.adc) / 4095 * w
                        let y = h - CGFloat(pt.dac) / 4095 * h
                        if i == 0 { p.move(to: CGPoint(x: x, y: y)) }
                        else { p.addLine(to: CGPoint(x: x, y: y)) }
                    }
                }
                .stroke(Color.accentColor, lineWidth: 2)

                // Control point dots
                Path { p in
                    for pt in curvePoints {
                        let x = CGFloat(pt.adc) / 4095 * w
                        let y = h - CGFloat(pt.dac) / 4095 * h
                        p.addEllipse(in: CGRect(x: x - 6, y: y - 6, width: 12, height: 12))
                    }
                }
                .fill(Color.accentColor)

                // Highlighted drag point
                if let idx = draggingIndex {
                    let pt = curvePoints[idx]
                    let x = CGFloat(pt.adc) / 4095 * w
                    let y = h - CGFloat(pt.dac) / 4095 * h
                    Circle()
                        .stroke(.white, lineWidth: 2)
                        .frame(width: 16, height: 16)
                        .position(x: x, y: y)

                    // Value tooltip
                    Text("\(pt.adc), \(pt.dac)")
                        .font(.caption2)
                        .monospacedDigit()
                        .padding(2)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 3))
                        .position(x: x, y: max(16, y - 18))
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        handleDrag(value, in: CGSize(width: w, height: h))
                    }
                    .onEnded { _ in draggingIndex = nil }
            )
        }
    }

    // MARK: - Drag handling

    private func handleDrag(_ value: DragGesture.Value, in size: CGSize) {
        if draggingIndex == nil {
            var best = 0
            var bestDist = CGFloat.infinity
            for (i, pt) in curvePoints.enumerated() {
                let px = CGFloat(pt.adc) / 4095 * size.width
                let py = size.height - CGFloat(pt.dac) / 4095 * size.height
                let d = hypot(value.startLocation.x - px, value.startLocation.y - py)
                if d < bestDist { bestDist = d; best = i }
            }
            guard bestDist < 24 else { return }
            draggingIndex = best
        }

        guard let idx = draggingIndex else { return }

        var adc = Int(value.location.x / size.width * 4095)
        var dac = Int((size.height - value.location.y) / size.height * 4095)
        adc = max(0, min(4095, adc))
        dac = max(0, min(4095, dac))

        if idx > 0 { adc = max(curvePoints[idx - 1].adc, adc) }
        if idx < 4 { adc = min(curvePoints[idx + 1].adc, adc) }

        curvePoints[idx] = BrightnessPoint(adc: adc, dac: dac)
    }

    // MARK: - Bindings

    private func adcBinding(_ i: Int) -> Binding<Int> {
        Binding(
            get: { curvePoints[i].adc },
            set: { curvePoints[i].adc = max(0, min(4095, $0)) }
        )
    }

    private func dacBinding(_ i: Int) -> Binding<Int> {
        Binding(
            get: { curvePoints[i].dac },
            set: { curvePoints[i].dac = max(0, min(4095, $0)) }
        )
    }
}
