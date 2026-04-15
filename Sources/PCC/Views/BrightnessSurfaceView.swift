import SwiftUI
import Charts

/// 3D surface comparing the current brightness curve against factory presets.
/// X axis: ADC sensor reading, Z axis: preset blend, Y axis: DAC brightness output.
struct BrightnessSurfaceView: View {
    let currentPoints: [BrightnessPoint]
    @State private var surfacePose: Chart3DPose = .default

    private let presets: [(name: String, points: [BrightnessPoint])] = [
        ("Rev C", CurvePreset.revC.points),
        ("GL5549", CurvePreset.gl5549.points),
        ("Rev D", CurvePreset.revD.points),
    ]

    var body: some View {
        VStack(spacing: 12) {
            Text("Brightness Response Surface")
                .font(.headline)

            Text("Rotate to compare your curve against factory presets")
                .font(.caption)
                .foregroundStyle(.secondary)

            let allCurves = [currentPoints] + presets.map(\.points)
            Chart3D {
                SurfacePlot(x: "Sensor (ADC)", y: "Brightness (DAC)", z: "Curve") { x, z in
                    BrightnessMath.brightness(curves: allCurves, adc: x * 4095, presetBlend: z) / 4095
                }
                .foregroundStyle(.blue.gradient)
            }
            .chart3DPose($surfacePose)
            .chart3DCameraProjection(.perspective)
            .frame(minHeight: 300)

            // Legend showing which preset is at which z-position
            HStack(spacing: 16) {
                curveLabel("Your Curve", detail: "Front")
                ForEach(Array(presets.enumerated()), id: \.offset) { i, preset in
                    let pct = Int(Double(i + 1) / Double(presets.count + 1) * 100)
                    curveLabel(preset.name, detail: "\(pct)%")
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding()
    }

    private func curveLabel(_ title: String, detail: String) -> some View {
        VStack(spacing: 2) {
            Text(title).fontWeight(.medium)
            Text(detail)
        }
    }

}

// MARK: - Pure math extracted from View to avoid @MainActor isolation

private enum BrightnessMath {
    /// Interpolate DAC output for a given ADC value and preset blend position.
    /// At blend=0 uses the current curve, at blend=1 uses the last factory preset,
    /// with smooth interpolation between all curves.
    static func brightness(curves allCurves: [[BrightnessPoint]], adc: Double, presetBlend: Double) -> Double {
        let count = allCurves.count
        let scaledIndex = presetBlend * Double(count - 1)
        let lower = max(0, min(count - 2, Int(scaledIndex)))
        let upper = lower + 1
        let t = scaledIndex - Double(lower)

        let dacLower = interpolateCurve(allCurves[lower], adc: adc)
        let dacUpper = interpolateCurve(allCurves[upper], adc: adc)

        return dacLower * (1 - t) + dacUpper * t
    }

    /// Piecewise linear interpolation through calibration points,
    /// matching the clock firmware's brightness lookup.
    static func interpolateCurve(_ points: [BrightnessPoint], adc: Double) -> Double {
        guard let first = points.first, let last = points.last else { return 0 }
        if adc <= Double(first.adc) { return Double(first.dac) }
        if adc >= Double(last.adc) { return Double(last.dac) }

        for i in 0..<points.count - 1 {
            let p0 = points[i], p1 = points[i + 1]
            if adc <= Double(p1.adc) {
                let t = (adc - Double(p0.adc)) / max(1, Double(p1.adc - p0.adc))
                return Double(p0.dac) * (1 - t) + Double(p1.dac) * t
            }
        }
        return Double(last.dac)
    }
}
