import SwiftUI
import MapKit
import CoreLocation

// MARK: - Sub-satellite point calculation

extension SatelliteInfo {
    /// Approximate orbital altitude in km for each constellation
    var orbitalAltitude: Double {
        switch constellation {
        case .gps:     return 20_200
        case .glonass: return 19_100
        case .galileo: return 23_222
        case .beidou:  return 21_528
        }
    }

    /// Sub-satellite point (lat/lon on Earth directly below the satellite).
    /// Delegates to the canonical projection in SatPass.swift so the live dot
    /// and the recorded ground-track trail use identical geometry.
    func subSatellitePoint(observerLat: Double, observerLon: Double) -> CLLocationCoordinate2D? {
        PCC.subSatellitePoint(az: azimuth,
                              el: elevation,
                              constellation: constellation,
                              observerLat: observerLat,
                              observerLon: observerLon)
    }
}

// MARK: - Satellite annotation

struct SatelliteAnnotation: Identifiable {
    let id: String
    let coordinate: CLLocationCoordinate2D
    let constellation: SatConstellation
    let snr: Int?
    let label: String
}

// MARK: - Map View

/// MapKit view of the clock's GPS fix and all currently-tracked satellites
/// (rendered at their sub-satellite points). There's intentionally no
/// "set weather location" affordance — weather follows the clock's own GPS
/// fix, so there's nothing for this view to override.
struct SatelliteMapView: View {
    @EnvironmentObject var serialManager: SerialManager

    @State private var cameraPosition: MapCameraPosition = .region(
        MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 30, longitude: 0),
                           span: MKCoordinateSpan(latitudeDelta: 140, longitudeDelta: 360))
    )

    private var gpsCoordinate: CLLocationCoordinate2D? {
        guard let lat = serialManager.gpsLatitude,
              let lon = serialManager.gpsLongitude else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }

    private var constellationsPresent: [SatConstellation] {
        let unique = Set(serialManager.satellites.map(\.constellation))
        return SatConstellation.allCases.filter { unique.contains($0) }
    }

    private var satelliteAnnotations: [SatelliteAnnotation] {
        guard let gps = gpsCoordinate else { return [] }
        return serialManager.satellites.compactMap { sat in
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

    var body: some View {
        VStack(spacing: 0) {
            // GPS status bar
            HStack {
                if serialManager.gpsFix > 0, let lat = serialManager.gpsLatitude, let lon = serialManager.gpsLongitude {
                    Image(systemName: "location.fill")
                        .foregroundStyle(.green)
                    Text(String(format: "%.4f, %.4f", lat, lon))
                        .font(.system(.caption, design: .monospaced))
                    if let alt = serialManager.gpsAltitude {
                        Text(String(format: "%.0fm", alt))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Image(systemName: "location.slash")
                        .foregroundStyle(.secondary)
                    Text("No GPS fix")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal)
            .padding(.vertical, 6)

            // Map
            Map(position: $cameraPosition) {
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
                    Annotation(sat.label, coordinate: sat.coordinate) {
                        Circle()
                            .fill(sat.constellation.color.opacity(sat.snr != nil ? 0.8 : 0.3))
                            .frame(width: sat.snr != nil ? 8 : 5, height: sat.snr != nil ? 8 : 5)
                    }
                }
            }
            .mapStyle(.standard(elevation: .flat))
            .overlay(alignment: .bottomTrailing) {
                // Legend
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(constellationsPresent, id: \.self) { c in
                        HStack(spacing: 4) {
                            Circle().fill(c.color).frame(width: 6, height: 6)
                            Text(c.rawValue).font(.system(size: 9))
                        }
                    }
                }
                .padding(6)
                .background(.ultraThinMaterial)
                .cornerRadius(6)
                .padding(8)
            }
        }
        .onAppear {
            serialManager.requestSatelliteTracking()
            serialManager.requestNMEA(consumer: "Map")
        }
        .onDisappear {
            serialManager.releaseSatelliteTracking()
            serialManager.releaseNMEA(consumer: "Map")
        }
    }
}
