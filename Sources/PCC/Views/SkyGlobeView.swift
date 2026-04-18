import SwiftUI
import WebKit
import CoreLocation

/// 3D globe visualization of satellite positions using globe.gl.
/// Shows live satellites as floating dots at their sub-satellite points, plus
/// recorded passes as WebGL polylines (pathsData), sun/moon, user location, and
/// a space background.
struct SkyGlobeView: View {
    let satellites: [SatelliteInfo]
    let sunPosition: CelestialPosition?
    let moonPosition: CelestialPosition?
    var userLatitude: Double?
    var userLongitude: Double?
    var passes: [SatPass] = []
    var activePRNs: Set<String> = []
    var now: Date = Date()

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
            passes: showTrails ? passes : [],
            activePRNs: activePRNs,
            now: now,
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
    let passes: [SatPass]
    let activePRNs: Set<String>
    let now: Date
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
        var satData: [[String: Any]] = []
        for sat in satellites where (sat.snr ?? 0) > 0 {
            guard let coord = sat.subSatellitePoint(
                observerLat: userLatitude ?? 0,
                observerLon: userLongitude ?? 0
            ) else { continue }
            let isLive = activePRNs.contains(sat.id)
            satData.append([
                "lat": coord.latitude,
                "lng": coord.longitude,
                "alt": 0.02 + Double(sat.elevation) / 90.0 * 0.08,
                "color": colorHex(for: sat.constellation),
                "size": isLive ? 6 : 4,
                "name": sat.id,
                "label": showLabels ? sat.id : "",
                "type": isLive ? "live" : "satellite"
            ])
        }

        // Trail paths per pass, rendered as WebGL polylines via globe.gl pathsData.
        // Oldest first so fresh passes layer on top.
        var pathData: [[String: Any]] = []
        if let lat = userLatitude, let lon = userLongitude {
            let ordered = passes.sorted { $0.endTime < $1.endTime }
            for pass in ordered {
                let isLive = activePRNs.contains(pass.prn)
                let tier = PassAgeTier.tier(endAge: now.timeIntervalSince(pass.endTime),
                                             isLive: isLive)
                let coords = pass.groundTrack(observerLat: lat, observerLon: lon,
                                               maxPoints: tier.maxPoints)
                guard coords.count >= 2 else { continue }
                let points = coords.map { coord -> [Double] in
                    [coord.latitude, coord.longitude, 0.008]
                }
                pathData.append([
                    "coords": points,
                    "color": rgbaColor(for: pass.constellation, alpha: tier.opacity),
                    "stroke": Double(tier.strokeWidth)
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

        let allElements = satData + celestialData
        if let json = jsonString(allElements) {
            js += "if(window.updateElements)updateElements(\(json));"
        }
        if let ringJson = jsonString(rings) {
            js += "if(window.updateRings)updateRings(\(ringJson));"
        }
        if let pathJson = jsonString(pathData) {
            js += "if(window.updatePaths)updatePaths(\(pathJson));"
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

    private func rgbaColor(for constellation: SatConstellation, alpha: Double) -> String {
        let (r, g, b): (Int, Int, Int)
        switch constellation {
        case .gps:     (r, g, b) = (0, 122, 255)
        case .glonass: (r, g, b) = (255, 59, 48)
        case .galileo: (r, g, b) = (255, 149, 0)
        case .beidou:  (r, g, b) = (90, 200, 250)
        }
        return String(format: "rgba(%d,%d,%d,%.3f)", r, g, b, max(0, min(1, alpha)))
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
        .sat-dot.live {
            box-shadow: 0 0 12px currentColor, 0 0 4px currentColor;
            animation: sat-pulse 1.4s ease-in-out infinite;
        }
        @keyframes sat-pulse {
            0%, 100% { transform: scale(1); }
            50%      { transform: scale(1.22); }
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

            // Satellites + celestial bodies as HTML elements
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

            // Per-pass trail polylines, WebGL-rendered
            .pathsData([])
            .pathPoints('coords')
            .pathColor(d => d.color)
            .pathStroke(d => d.stroke || 1.2)
            .pathPointAlt(p => p[2])
            .pathTransitionDuration(0)

            (document.getElementById('globe'));

        window.updateElements = function(data) {
            myGlobe.htmlElementsData(data);
        };

        window.updateRings = function(data) {
            myGlobe.ringsData(data);
        };

        window.updatePaths = function(data) {
            myGlobe.pathsData(data);
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
