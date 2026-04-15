import SwiftUI
import MapKit
import CoreLocation

/// Satellite ground-track map for the Sky View.
/// Shows sub-satellite points, sun/moon projections, trail data, and user GPS position.
struct SkyMapView: View {
    let satellites: [SatelliteInfo]
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    let userLatitude: Double?
    let userLongitude: Double?
    var showLabels: Bool = true
    var showTrails: Bool = false
    var heatmapGrid: TrailGrid?
    var toggles: AnyView?

    @State private var cameraPosition: MapCameraPosition = .automatic

    private var gpsCoordinate: CLLocationCoordinate2D? {
        guard let lat = userLatitude, let lon = userLongitude else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }

    private var constellationsPresent: [SatConstellation] {
        let unique = Set(satellites.map(\.constellation))
        return SatConstellation.allCases.filter { unique.contains($0) }
    }

    private var satelliteAnnotations: [SatelliteAnnotation] {
        guard let gps = gpsCoordinate else { return [] }
        return satellites.compactMap { sat in
            guard let coord = sat.subSatellitePoint(observerLat: gps.latitude, observerLon: gps.longitude) else {
                return nil
            }
            return SatelliteAnnotation(
                id: sat.id,
                coordinate: coord,
                constellation: sat.constellation,
                snr: sat.snr,
                label: sat.id
            )
        }
    }

    private struct TrailAnnotation: Identifiable {
        let id: Int
        let coordinate: CLLocationCoordinate2D
        let density: Double
        let avgSNR: Double
    }

    private static let maxTrailPoints = 600

    private var trailAnnotations: [TrailAnnotation] {
        guard showTrails,
              let grid = heatmapGrid,
              let lat = userLatitude,
              let lon = userLongitude else { return [] }

        // Keep top N by observation count, use absolute density for consistent dot visibility
        let sorted = grid.cells
            .filter { !$0.value.isEmpty }
            .sorted { $0.value.count > $1.value.count }

        return sorted.prefix(Self.maxTrailPoints).compactMap { entry in
            let az = entry.key / TrailGrid.elBins
            let el = entry.key % TrailGrid.elBins
            guard let coord = SatelliteInfo(
                prn: 0, constellation: .gps,
                elevation: el, azimuth: az, snr: Int(entry.value.avgSNR)
            ).subSatellitePoint(observerLat: lat, observerLon: lon) else { return nil }
            let density = min(Double(entry.value.count) / 80.0, 1.0)
            return TrailAnnotation(
                id: entry.key,
                coordinate: coord,
                density: density,
                avgSNR: entry.value.avgSNR
            )
        }
    }

    private func celestialCoordinate(_ pos: CelestialPosition) -> CLLocationCoordinate2D? {
        guard let gps = gpsCoordinate, pos.altitude > 0 else { return nil }
        let angularDist = (90.0 - pos.altitude) / 90.0 * 25.0
        let azRad = pos.azimuth * .pi / 180
        let distRad = angularDist * .pi / 180
        let userLatRad = gps.latitude * .pi / 180
        let userLonRad = gps.longitude * .pi / 180

        let lat = asin(sin(userLatRad) * cos(distRad) + cos(userLatRad) * sin(distRad) * cos(azRad))
        let lon = userLonRad + atan2(
            sin(azRad) * sin(distRad) * cos(userLatRad),
            cos(distRad) - sin(userLatRad) * sin(lat)
        )
        return CLLocationCoordinate2D(latitude: lat * 180 / .pi, longitude: lon * 180 / .pi)
    }

    var body: some View {
        Map(position: $cameraPosition) {
            // Trail points
            ForEach(trailAnnotations) { trail in
                Annotation("", coordinate: trail.coordinate, anchor: .center) {
                    Circle()
                        .fill(Color.blue.opacity(0.4))
                        .frame(
                            width: 3 + trail.density * 4,
                            height: 3 + trail.density * 4
                        )
                }
            }

            // GPS fix position
            if let gps = gpsCoordinate {
                Annotation("Clock", coordinate: gps) {
                    ZStack {
                        Circle()
                            .fill(.blue.opacity(0.2))
                            .frame(width: 24, height: 24)
                        Circle()
                            .fill(.blue)
                            .frame(width: 10, height: 10)
                            .overlay(
                                Circle()
                                    .stroke(.white, lineWidth: 2)
                            )
                    }
                }
            }

            // Sub-satellite points
            ForEach(satelliteAnnotations) { sat in
                Annotation(showLabels ? sat.label : "", coordinate: sat.coordinate) {
                    Circle()
                        .fill(sat.constellation.color.opacity(sat.snr != nil ? 0.8 : 0.3))
                        .frame(width: sat.snr != nil ? 8 : 5, height: sat.snr != nil ? 8 : 5)
                }
            }

            // Sun
            if let sun = sunPosition, let coord = celestialCoordinate(sun) {
                Annotation("Sun", coordinate: coord) {
                    Circle()
                        .fill(.yellow)
                        .frame(width: 12, height: 12)
                        .overlay(
                            Circle()
                                .stroke(.orange, lineWidth: 1.5)
                        )
                }
            }

            // Moon
            if let moon = moonPosition, let coord = celestialCoordinate(moon) {
                Annotation("Moon", coordinate: coord) {
                    Circle()
                        .fill(.gray)
                        .frame(width: 10, height: 10)
                        .overlay(
                            Circle()
                                .stroke(.white.opacity(0.5), lineWidth: 1)
                        )
                }
            }
        }
        .mapStyle(.standard(elevation: .flat))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .topTrailing) {
            if let toggles {
                toggles
                    .padding(8)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            // Legend
            VStack(alignment: .leading, spacing: 3) {
                ForEach(constellationsPresent, id: \.self) { c in
                    HStack(spacing: 4) {
                        Circle().fill(c.color).frame(width: 6, height: 6)
                        Text(c.rawValue).font(.system(size: 9))
                    }
                }
                if sunPosition != nil {
                    HStack(spacing: 4) {
                        Circle().fill(.yellow).frame(width: 6, height: 6)
                        Text("Sun").font(.system(size: 9))
                    }
                }
                if moonPosition != nil {
                    HStack(spacing: 4) {
                        Circle().fill(.gray).frame(width: 6, height: 6)
                        Text("Moon").font(.system(size: 9))
                    }
                }
            }
            .padding(6)
            .background(.ultraThinMaterial)
            .cornerRadius(6)
            .padding(8)
        }
    }
}
