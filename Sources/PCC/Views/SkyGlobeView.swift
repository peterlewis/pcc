import SwiftUI
import WebKit
import CoreLocation

/// 3D globe visualization of satellite positions using globe.gl.
/// Shows satellites as floating dots at their sub-satellite points,
/// with recorded trails, sun/moon, user location, and space background.
struct SkyGlobeView: View {
    let satellites: [SatelliteInfo]
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    var userLatitude: Double?
    var userLongitude: Double?
    var heatmapGrid: TrailGrid?

    @State private var showSatellites = true
    @State private var showTrails = true
    @State private var showLabels = false

    var body: some View {
        GlobeWebView(
            satellites: showSatellites ? satellites : [],
            sunPosition: sunPosition,
            moonPosition: moonPosition,
            userLatitude: userLatitude,
            userLongitude: userLongitude,
            heatmapGrid: showTrails ? heatmapGrid : nil,
            showLabels: showLabels
        )
        .overlay(alignment: .topTrailing) {
            HStack(spacing: 2) {
                toggleButton("scope", isOn: $showSatellites, tip: "Satellites")
                toggleButton("tag", isOn: $showLabels, tip: "Labels")
                toggleButton("point.3.filled.connected.trianglepath.dotted", isOn: $showTrails, tip: "Trails")
            }
            .padding(4)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 6))
            .padding(8)
        }
    }

    private func toggleButton(_ icon: String, isOn: Binding<Bool>, tip: String) -> some View {
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            Image(systemName: icon)
                .font(.caption)
                .frame(width: 24, height: 24)
                .foregroundStyle(isOn.wrappedValue ? .primary : .tertiary)
        }
        .buttonStyle(.borderless)
        .help(tip)
    }
}

// MARK: - WebView Wrapper

private struct GlobeWebView: NSViewRepresentable {
    let satellites: [SatelliteInfo]
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    let userLatitude: Double?
    let userLongitude: Double?
    let heatmapGrid: TrailGrid?
    let showLabels: Bool

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let userController = WKUserContentController()
        userController.add(context.coordinator, name: "globeReady")
        userController.add(context.coordinator, name: "globeLog")
        config.userContentController = userController
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.loadHTMLString(Self.globeHTML, baseURL: nil)
        context.coordinator.webView = webView
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        let js = buildUpdateJS()
        context.coordinator.pendingJS = js
        context.coordinator.sendIfReady()
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator: NSObject, WKScriptMessageHandler {
        weak var webView: WKWebView?
        var isReady = false
        var pendingJS: String?

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "globeReady" {
                isReady = true
                sendIfReady()
            }
            if message.name == "globeLog" {
                print("[Globe] \(message.body)")
            }
        }

        func sendIfReady() {
            guard isReady, let js = pendingJS, let webView else { return }
            webView.evaluateJavaScript(js, completionHandler: nil)
            pendingJS = nil
        }
    }

    // MARK: - Data → JS

    private func buildUpdateJS() -> String {
        // Satellites as HTML elements (colored dots floating above the globe)
        var satData: [[String: Any]] = []
        for sat in satellites {
            let tracked = (sat.snr ?? 0) > 0
            guard tracked else { continue }
            guard let coord = sat.subSatellitePoint(
                observerLat: userLatitude ?? 0,
                observerLon: userLongitude ?? 0
            ) else { continue }
            satData.append([
                "lat": coord.latitude,
                "lng": coord.longitude,
                "alt": 0.02 + Double(sat.elevation) / 90.0 * 0.08,
                "color": colorHex(for: sat.constellation),
                "size": 8,
                "name": sat.id,
                "label": showLabels ? sat.id : "",
                "type": "satellite"
            ])
        }

        // Trail points from recorded data (capped at 300, absolute density for consistent dots)
        let maxTrailPoints = 600
        var trailData: [[String: Any]] = []
        if let grid = heatmapGrid, let lat = userLatitude, let lon = userLongitude {
            let sorted = grid.cells
                .filter { !$0.value.isEmpty }
                .sorted { $0.value.count > $1.value.count }

            for entry in sorted.prefix(maxTrailPoints) {
                let az = entry.key / TrailGrid.elBins
                let el = entry.key % TrailGrid.elBins
                guard let coord = SatelliteInfo(
                    prn: 0, constellation: .gps,
                    elevation: el, azimuth: az, snr: Int(entry.value.avgSNR)
                ).subSatellitePoint(observerLat: lat, observerLon: lon) else { continue }
                let density = min(Double(entry.value.count) / 80.0, 1.0)
                let alpha = 0.5
                trailData.append([
                    "lat": coord.latitude,
                    "lng": coord.longitude,
                    "alt": 0.005,
                    "color": "rgba(60,180,255,\(String(format: "%.2f", alpha)))",
                    "size": 3 + density * 5,
                    "name": "", "label": "", "type": "trail"
                ])
            }
        }

        // Sun & Moon
        var celestialData: [[String: Any]] = []
        if let lat = userLatitude, let lon = userLongitude {
            if let sun = sunPosition, sun.altitude > 0,
               let coord = celestialCoordinate(sun, observerLat: lat, observerLon: lon) {
                celestialData.append([
                    "lat": coord.latitude,
                    "lng": coord.longitude,
                    "alt": 0.12,
                    "color": "rgba(255,230,100,0.9)",
                    "size": 14,
                    "name": "Sun", "label": "", "type": "celestial"
                ])
            }
            if let moon = moonPosition, moon.altitude > 0,
               let coord = celestialCoordinate(moon, observerLat: lat, observerLon: lon) {
                celestialData.append([
                    "lat": coord.latitude,
                    "lng": coord.longitude,
                    "alt": 0.10,
                    "color": "rgba(230,232,240,0.9)",
                    "size": 13,
                    "name": "Moon", "label": "", "type": "celestial"
                ])
            }
        }

        // Rings at user location
        var rings: [[String: Any]] = []
        if let lat = userLatitude, let lon = userLongitude {
            rings.append(["lat": lat, "lng": lon])
        }

        var js = ""

        let allElements = satData + trailData + celestialData
        if let json = jsonString(allElements) {
            js += "if(window.updateElements)updateElements(\(json));"
        }
        if let ringJson = jsonString(rings) {
            js += "if(window.updateRings)updateRings(\(ringJson));"
        }
        if let lat = userLatitude, let lon = userLongitude {
            js += "if(window.focusOn)focusOn(\(lat),\(lon));"
        }
        return js
    }

    private func jsonString(_ obj: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let str = String(data: data, encoding: .utf8) else { return nil }
        return str
    }

    /// Project a celestial body (sun/moon) from observer azimuth/elevation to lat/lon on the globe.
    private func celestialCoordinate(_ pos: CelestialPosition, observerLat: Double, observerLon: Double) -> (latitude: Double, longitude: Double)? {
        guard pos.altitude > 0 else { return nil }
        let angularDist = (90.0 - pos.altitude) / 90.0 * 25.0
        let azRad = pos.azimuth * .pi / 180
        let distRad = angularDist * .pi / 180
        let latRad = observerLat * .pi / 180
        let lonRad = observerLon * .pi / 180

        let lat = asin(sin(latRad) * cos(distRad) + cos(latRad) * sin(distRad) * cos(azRad))
        let lon = lonRad + atan2(
            sin(azRad) * sin(distRad) * cos(latRad),
            cos(distRad) - sin(latRad) * sin(lat)
        )
        return (lat * 180 / .pi, lon * 180 / .pi)
    }

    private func colorHex(for constellation: SatConstellation) -> String {
        switch constellation {
        case .gps: return "#007aff"
        case .glonass: return "#ff3b30"
        case .galileo: return "#ff9500"
        case .beidou: return "#5ac8fa"
        }
    }

    // MARK: - HTML

    static let globeHTML = """
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="utf-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: black; overflow: hidden; }
        #globe { width: 100vw; height: 100vh; }
        .sat-el {
            display: flex;
            align-items: center;
            gap: 3px;
            pointer-events: none;
        }
        .sat-dot {
            border-radius: 50%;
            flex-shrink: 0;
        }
        .sat-dot.satellite {
            box-shadow: 0 0 6px currentColor;
        }
        .sat-dot.trail {
            box-shadow: 0 0 3px currentColor;
        }
        .sat-dot.celestial {
            box-shadow: 0 0 8px currentColor, 0 0 3px currentColor;
        }
        .sat-label {
            font: 9px -apple-system, sans-serif;
            color: #fff;
            text-shadow: 0 0 3px rgba(0,0,0,0.8);
            white-space: nowrap;
        }
    </style>
    <script src="https://unpkg.com/globe.gl@2.41.3/dist/globe.gl.min.js"></script>
    </head>
    <body>
    <div id="globe"></div>
    <script>
    try {
        const myGlobe = Globe()
            .globeImageUrl('https://unpkg.com/three-globe@2.35.2/example/img/earth-blue-marble.jpg')
            .bumpImageUrl('https://unpkg.com/three-globe@2.35.2/example/img/earth-topology.png')
            .backgroundImageUrl('https://unpkg.com/three-globe@2.35.2/example/img/night-sky.png')
            .atmosphereColor('#6699ff')
            .atmosphereAltitude(0.15)
            .showAtmosphere(true)

            // Satellites + celestial + trails as HTML elements
            .htmlElementsData([])
            .htmlLat('lat')
            .htmlLng('lng')
            .htmlAltitude('alt')
            .htmlElement(d => {
                const wrapper = document.createElement('div');
                wrapper.className = 'sat-el';

                const dot = document.createElement('div');
                dot.className = 'sat-dot ' + (d.type || 'satellite');
                const s = d.size || 6;
                dot.style.width = s + 'px';
                dot.style.height = s + 'px';
                dot.style.backgroundColor = d.color || '#fff';
                dot.style.color = d.color || '#fff';
                wrapper.appendChild(dot);

                if (d.label) {
                    const lbl = document.createElement('span');
                    lbl.className = 'sat-label';
                    lbl.textContent = d.label;
                    lbl.style.color = d.color || '#fff';
                    wrapper.appendChild(lbl);
                }

                if (d.name) wrapper.title = d.name;
                return wrapper;
            })

            // Rings at user location
            .ringsData([])
            .ringLat('lat')
            .ringLng('lng')
            .ringColor(() => '#ff3b30')
            .ringMaxRadius(3)
            .ringPropagationSpeed(2)
            .ringRepeatPeriod(1200)
            .ringAltitude(0.002)

            (document.getElementById('globe'));

        window.updateElements = function(data) {
            myGlobe.htmlElementsData(data);
        };

        window.updateRings = function(data) {
            myGlobe.ringsData(data);
        };

        window.addEventListener('resize', () => {
            myGlobe.width(window.innerWidth).height(window.innerHeight);
        });

        let hasFocused = false;
        window.focusOn = function(lat, lng) {
            if (hasFocused) return;
            hasFocused = true;
            myGlobe.pointOfView({ lat: lat, lng: lng, altitude: 1.8 }, 1000);
        };

        window.webkit.messageHandlers.globeReady.postMessage('ok');
    } catch(e) {
        window.webkit.messageHandlers.globeLog.postMessage('Error: ' + e.message);
    }
    </script>
    </body>
    </html>
    """
}
