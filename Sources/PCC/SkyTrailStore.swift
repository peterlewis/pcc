import Foundation
import AppKit

// MARK: - Trail Grid Cell

struct TrailCell: Codable {
    var count: Int = 0
    var totalSNR: Int = 0
    var maxSNR: Int = 0

    var avgSNR: Double { count > 0 ? Double(totalSNR) / Double(count) : 0 }
    var isEmpty: Bool { count == 0 }
}

// MARK: - Trail Grid

/// Aggregated satellite observation grid.
/// Uses a sparse dictionary keyed by `azimuth * 91 + elevation`
/// for 1° resolution across the full sky hemisphere.
/// Storage stays compact (typically < 200 KB) regardless of recording duration.
struct TrailGrid: Codable {
    /// Sparse grid: key = azimuth (0–359) × 91 + elevation (0–90).
    var cells: [Int: TrailCell] = [:]

    /// Minimum elevation observed per 5° azimuth sector (72 sectors).
    var horizonMask: [Double?] = Array(repeating: nil, count: 72)

    var startTime: Date?
    var lastSampleTime: Date?
    var totalSampleBatches: Int = 0

    static let elBins = 91

    /// Record one tracked satellite observation into the grid.
    mutating func record(_ sat: SatelliteInfo) {
        guard let snr = sat.snr, snr > 0, sat.elevation >= 0, sat.elevation <= 90 else { return }
        let az = max(0, min(359, sat.azimuth))
        let el = max(0, min(90, sat.elevation))
        let key = az * Self.elBins + el

        var cell = cells[key] ?? TrailCell()
        cell.count += 1
        cell.totalSNR += snr
        if snr > cell.maxSNR { cell.maxSNR = snr }
        cells[key] = cell

        // Update horizon mask (5° sectors)
        let sector = az / 5
        if sector < 72 {
            let current = horizonMask[sector] ?? 90
            if Double(el) < current {
                horizonMask[sector] = Double(el)
            }
        }
    }

    /// Total individual satellite observations across all cells.
    var totalObservations: Int {
        cells.values.reduce(0) { $0 + $1.count }
    }

    /// Return a coarsened version of the grid for map/globe rendering.
    /// Groups cells into `step`-degree bins, merging counts and SNR values.
    /// With step=5 the maximum output is 72×19 = 1,368 cells (vs 32,760 at 1°).
    func downsampled(step: Int = 5) -> [(key: Int, cell: TrailCell, azimuth: Int, elevation: Int)] {
        var coarse: [Int: TrailCell] = [:]
        for (key, cell) in cells where !cell.isEmpty {
            let az = (key / Self.elBins / step) * step
            let el = (key % Self.elBins / step) * step
            let coarseKey = az * 100 + el   // unique key for coarse grid
            var merged = coarse[coarseKey] ?? TrailCell()
            merged.count += cell.count
            merged.totalSNR += cell.totalSNR
            if cell.maxSNR > merged.maxSNR { merged.maxSNR = cell.maxSNR }
            coarse[coarseKey] = merged
        }
        return coarse.map { key, cell in
            (key: key, cell: cell, azimuth: key / 100, elevation: key % 100)
        }
    }

    /// Convert occupied cells to 3D hemisphere coordinates for Chart3D heatmap rendering.
    func heatmapPoints3D() -> [HeatmapPoint3D] {
        cells.compactMap { key, cell in
            guard !cell.isEmpty else { return nil }
            let az = key / Self.elBins
            let el = key % Self.elBins
            let elevRad = Double(el) * .pi / 180
            let azRad = Double(az) * .pi / 180
            let r = cos(elevRad)
            let density = min(Double(cell.count) / 80.0, 1.0)
            return HeatmapPoint3D(
                id: key,
                x: r * sin(azRad),
                y: sin(elevRad),
                z: r * cos(azRad),
                avgSNR: cell.avgSNR,
                density: density
            )
        }
    }
}

// MARK: - 3D Heatmap Point

struct HeatmapPoint3D: Identifiable {
    let id: Int
    let x: Double
    let y: Double
    let z: Double
    let avgSNR: Double
    let density: Double
}

// MARK: - Persistent Store

/// Persists satellite observation data to disk as an aggregated grid.
/// The grid grows in cell count (up to 32 760 at 1° resolution) but not in cell size,
/// so total storage stays well under 1 MB regardless of how long you record.
class SkyTrailStore: ObservableObject {
    @Published private(set) var grid = TrailGrid()
    @Published var isLogging = false

    private let fileURL: URL
    private var lastSampleTime: Date = .distantPast
    private let sampleInterval: TimeInterval = 10
    private var pendingSaves = 0

    /// Human-readable summary of stored data.
    var dataSummary: String {
        let cells = grid.cells.count
        let obs = grid.totalObservations
        if obs == 0 { return "No data" }
        if cells < 1000 {
            return "\(cells) positions, \(formatCount(obs)) obs"
        }
        return "\(formatCount(cells)) positions, \(formatCount(obs)) obs"
    }

    /// Duration string for the recording period, or nil if no data.
    var durationSummary: String? {
        guard let start = grid.startTime, let end = grid.lastSampleTime else { return nil }
        let seconds = Int(end.timeIntervalSince(start))
        if seconds < 60 { return "< 1 min" }
        let hours = seconds / 3600
        let mins = (seconds % 3600) / 60
        if hours >= 24 {
            let days = hours / 24
            let remH = hours % 24
            return "\(days)d \(remH)h"
        }
        if hours > 0 { return "\(hours)h \(mins)m" }
        return "\(mins)m"
    }

    init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("Precision Clock Companion", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("sky_trail.json")
        isLogging = false   // Never auto-resume — NMEA output must be explicitly requested
        load()

        // Save on app quit
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            self?.save()
        }
    }

    /// Record a batch of satellite observations. Only records when logging is enabled.
    func record(_ satellites: [SatelliteInfo]) {
        guard isLogging else { return }
        let now = Date()
        guard now.timeIntervalSince(lastSampleTime) >= sampleInterval else { return }
        lastSampleTime = now

        var updated = grid
        if updated.startTime == nil { updated.startTime = now }
        updated.lastSampleTime = now
        updated.totalSampleBatches += 1

        for sat in satellites {
            updated.record(sat)
        }

        grid = updated
        pendingSaves += 1

        // Flush to disk every ~30 seconds
        if pendingSaves >= 3 {
            save()
        }
    }

    /// Clear all stored data and remove the file.
    func clear() {
        grid = TrailGrid()
        pendingSaves = 0
        try? FileManager.default.removeItem(at: fileURL)
    }

    /// Flush pending changes to disk.
    func save() {
        guard pendingSaves > 0 else { return }
        pendingSaves = 0
        guard let data = try? JSONEncoder().encode(grid) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let loaded = try? JSONDecoder().decode(TrailGrid.self, from: data)
        else { return }
        grid = loaded
    }

    private func formatCount(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }
}
