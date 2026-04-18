import SwiftUI
import MapKit
import CoreLocation

/// Satellite ground-track map for the Sky View.
/// Shows sub-satellite points, sun/moon projections, per-pass polylines, and the user's GPS position.
struct SkyMapView: View {
    let satellites: [SatelliteInfo]
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    let userLatitude: Double?
    let userLongitude: Double?
    var showLabels: Bool = true
    var passes: [SatPass] = []
    var activePRNs: Set<String> = []
    var now: Date = Date()
    /// When `false`, disables the Swift-side az/el moving-average filter so
    /// the rendered polyline passes through every raw NMEA observation
    /// (visible 1° integer-quantization staircase). Maps through to
    /// `SatPass.groundTrack(smoothingWindow:)` — `1` disables smoothing,
    /// `0` enables the adaptive window.
    var smoothTrails: Bool = true
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
            // Pass polylines, oldest first so fresh passes layer on top.
            if let lat = userLatitude, let lon = userLongitude {
                let ordered = passes.sorted { $0.endTime < $1.endTime }
                ForEach(ordered) { pass in
                    let isLive = activePRNs.contains(pass.prn)
                    let age = now.timeIntervalSince(pass.endTime)
                    // No decimation — every rendered vertex is a real observation.
                    // `smoothingWindow: 1` disables smoothing so the raw
                    // NMEA 1° quantisation shows through; `0` asks for the
                    // adaptive moving-average.
                    let coords = pass.groundTrack(observerLat: lat, observerLon: lon,
                                                   maxPoints: .max,
                                                   smoothingWindow: smoothTrails ? 0 : 1)
                    if coords.count >= 2 {
                        let alpha = PassAgeTier.opacity(endAge: age, isLive: isLive)
                        let stroke = PassAgeTier.strokeWidth(endAge: age, isLive: isLive)
                        MapPolyline(coordinates: coords)
                            .stroke(pass.constellation.color.opacity(alpha),
                                    style: StrokeStyle(lineWidth: stroke,
                                                       lineCap: .round, lineJoin: .round))
                    }
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
                            .overlay(Circle().stroke(.white, lineWidth: 2))
                    }
                }
            }

            // Sub-satellite points (live)
            ForEach(satelliteAnnotations) { sat in
                Annotation(showLabels ? sat.label : "", coordinate: sat.coordinate) {
                    Circle()
                        .fill(sat.constellation.color.opacity(sat.snr != nil ? 0.85 : 0.3))
                        .frame(width: sat.snr != nil ? 9 : 5, height: sat.snr != nil ? 9 : 5)
                        .overlay(
                            Circle()
                                .stroke(.white.opacity(sat.snr != nil ? 0.6 : 0), lineWidth: 1)
                        )
                }
            }

            // Sun
            if let sun = sunPosition, let coord = celestialCoordinate(sun) {
                Annotation("Sun", coordinate: coord) {
                    Circle()
                        .fill(.yellow)
                        .frame(width: 12, height: 12)
                        .overlay(Circle().stroke(.orange, lineWidth: 1.5))
                }
            }

            // Moon
            if let moon = moonPosition, let coord = celestialCoordinate(moon) {
                Annotation("Moon", coordinate: coord) {
                    Circle()
                        .fill(.gray)
                        .frame(width: 10, height: 10)
                        .overlay(Circle().stroke(.white.opacity(0.5), lineWidth: 1))
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
