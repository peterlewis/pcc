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

    /// Calculate the sub-satellite point (lat/lon on Earth directly below the satellite)
    /// given the observer's position and the satellite's elevation/azimuth.
    func subSatellitePoint(observerLat: Double, observerLon: Double) -> CLLocationCoordinate2D? {
        guard elevation > 0 else { return nil }

        let R = 6371.0 // Earth radius km
        let h = orbitalAltitude
        let el = Double(elevation) * .pi / 180
        let az = Double(azimuth) * .pi / 180
        let latO = observerLat * .pi / 180
        let lonO = observerLon * .pi / 180

        // Central angle between observer and sub-satellite point
        let sinEl = sin(el)
        let rRatio = R / (R + h)

        // gamma = arccos(sinEl * rRatio) - el  (simplified for MEO/high orbits)
        let gamma = acos(sinEl * rRatio) - el

        // Sub-satellite latitude
        let sinLatS = sin(latO) * cos(gamma) + cos(latO) * sin(gamma) * cos(az)
        let latS = asin(sinLatS)

        // Sub-satellite longitude
        let lonS = lonO + atan2(
            sin(az) * sin(gamma) * cos(latO),
            cos(gamma) - sin(latO) * sinLatS
        )

        return CLLocationCoordinate2D(
            latitude: latS * 180 / .pi,
            longitude: lonS * 180 / .pi
        )
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

struct SatelliteMapView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var settings: AppSettings

    @State private var cameraPosition: MapCameraPosition = .region(
        MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 30, longitude: 0),
                           span: MKCoordinateSpan(latitudeDelta: 140, longitudeDelta: 360))
    )
    @State private var pickedCoordinate: CLLocationCoordinate2D?
    @State private var hoveredTimezone: String?
    @State private var isPickingLocation = false

    private var gpsCoordinate: CLLocationCoordinate2D? {
        guard let lat = serialManager.gpsLatitude,
              let lon = serialManager.gpsLongitude else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
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

                if let tz = hoveredTimezone {
                    Text(tz)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                }

                Button(isPickingLocation ? "Cancel" : "Set Weather Location") {
                    isPickingLocation.toggle()
                    if !isPickingLocation {
                        pickedCoordinate = nil
                    }
                }
                .font(.caption)
                .buttonStyle(.borderless)
            }
            .padding(.horizontal)
            .padding(.vertical, 6)

            if isPickingLocation {
                HStack {
                    Image(systemName: "info.circle")
                        .foregroundStyle(.blue)
                    Text("Click the map to set your weather location")
                        .font(.caption)
                    if let coord = pickedCoordinate {
                        Spacer()
                        Text(String(format: "%.4f, %.4f", coord.latitude, coord.longitude))
                            .font(.system(.caption, design: .monospaced))
                        Button("Use This") {
                            settings.latitude = coord.latitude
                            settings.longitude = coord.longitude
                            isPickingLocation = false
                            pickedCoordinate = nil
                        }
                        .font(.caption)
                    }
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.bottom, 4)
            }

            // Map
            MapReader { proxy in
                Map(position: $cameraPosition) {
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
                        Annotation(sat.label, coordinate: sat.coordinate) {
                            Circle()
                                .fill(sat.constellation.color.opacity(sat.snr != nil ? 0.8 : 0.3))
                                .frame(width: sat.snr != nil ? 8 : 5, height: sat.snr != nil ? 8 : 5)
                        }
                    }

                    // Weather location marker
                    if !isPickingLocation {
                        Annotation("Weather", coordinate: CLLocationCoordinate2D(
                            latitude: settings.latitude, longitude: settings.longitude
                        )) {
                            Image(systemName: "cloud.fill")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                    }

                    // Picked location
                    if let picked = pickedCoordinate {
                        Annotation("Selected", coordinate: picked) {
                            Image(systemName: "mappin")
                                .font(.title3)
                                .foregroundStyle(.red)
                        }
                    }
                }
                .mapStyle(.standard(elevation: .flat))
                .onTapGesture { position in
                    guard isPickingLocation else { return }
                    if let coord = proxy.convert(position, from: .local) {
                        pickedCoordinate = coord
                        // Reverse geocode for timezone
                        let location = CLLocation(latitude: coord.latitude, longitude: coord.longitude)
                        CLGeocoder().reverseGeocodeLocation(location) { placemarks, _ in
                            hoveredTimezone = placemarks?.first?.timeZone?.identifier
                        }
                    }
                }
            }
            .overlay(alignment: .bottomTrailing) {
                // Legend
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(SatConstellation.allCases, id: \.self) { c in
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
            serialManager.requestNMEA()
        }
        .onDisappear {
            serialManager.releaseSatelliteTracking()
            serialManager.releaseNMEA()
        }
    }
}
