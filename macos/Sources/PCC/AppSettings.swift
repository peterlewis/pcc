import Foundation

enum TemperatureUnit: String, CaseIterable, Identifiable {
    case celsius = "C"
    case fahrenheit = "F"
    var id: String { rawValue }
}

enum WindSpeedUnit: String, CaseIterable, Identifiable {
    case mph = "mph"
    case kmh = "km/h"
    case ms = "m/s"
    case knots = "kn"
    var id: String { rawValue }
}

enum WeatherDisplayFormat: String, CaseIterable, Identifiable {
    case temperatureOnly = "Temperature only"
    case temperatureConditions = "Temperature + conditions"
    case temperatureWind = "Temperature + wind"
    case full = "Full"
    var id: String { rawValue }
}

class AppSettings: ObservableObject {
    // The "lastSerialPort" default is owned by SerialManager (written on
    // connect, read by autoConnect and ConnectView straight from
    // UserDefaults). A @Published mirror used to live here too, but nothing
    // read it and SerialManager's direct writes never updated it — a stale
    // second copy is worse than none.
    // Location used to come from UserDefaults here, but the app now sources
    // latitude/longitude exclusively from the clock's GPS fix (see
    // `SerialManager.gpsLatitude` / `gpsLongitude`). That avoids pulling in
    // macOS Location Services and keeps a single source of truth — if the
    // user wants to override, they fake the GPS output, not the app.
    @Published var temperatureUnit: TemperatureUnit {
        didSet { UserDefaults.standard.set(temperatureUnit.rawValue, forKey: "temperatureUnit") }
    }
    @Published var windSpeedUnit: WindSpeedUnit {
        didSet { UserDefaults.standard.set(windSpeedUnit.rawValue, forKey: "windSpeedUnit") }
    }
    @Published var weatherPollInterval: Double {
        didSet { UserDefaults.standard.set(weatherPollInterval, forKey: "weatherPollInterval") }
    }
    @Published var weatherDisplayFormat: WeatherDisplayFormat {
        didSet { UserDefaults.standard.set(weatherDisplayFormat.rawValue, forKey: "weatherDisplayFormat") }
    }
    @Published var recentTexts: [String] {
        didSet { UserDefaults.standard.set(recentTexts, forKey: "recentTexts") }
    }
    @Published var configWriteEnabled: Bool {
        didSet { UserDefaults.standard.set(configWriteEnabled, forKey: "configWriteEnabled") }
    }
    /// Seconds between character shifts for the marquee scroll on the clock.
    /// Applies to every scrolling mode (Text, Weather, Data Sources) since
    /// they all route through `SerialManager.sendScrollingText`. Lower is
    /// faster. 0.40 was chosen as the default after the original 0.35 felt
    /// just slightly too quick to read at a glance.
    @Published var scrollInterval: Double {
        didSet { UserDefaults.standard.set(scrollInterval, forKey: "scrollInterval") }
    }

    // MARK: Sky view preferences
    //
    // These mirror the toggles at the top-right of each Sky view (polar,
    // map, globe) and persist across launches. Defaults match the values
    // the views initially shipped with — i.e. everything on, time window
    // set to 1h, view mode polar, trails smoothed. We store booleans via
    // the `object(forKey:) == nil ? default : bool(forKey:)` pattern so a
    // user who toggles something off doesn't get it flipped back on at
    // launch (a naked `bool(forKey:)` call returns `false` both for "never
    // set" and for "set to false", which conflates the two).
    @Published var skyViewMode: String {
        didSet { UserDefaults.standard.set(skyViewMode, forKey: "skyViewMode") }
    }
    @Published var skyTimeWindow: String {
        didSet { UserDefaults.standard.set(skyTimeWindow, forKey: "skyTimeWindow") }
    }
    @Published var skyShowSatellites: Bool {
        didSet { UserDefaults.standard.set(skyShowSatellites, forKey: "skyShowSatellites") }
    }
    @Published var skyShowLabels: Bool {
        didSet { UserDefaults.standard.set(skyShowLabels, forKey: "skyShowLabels") }
    }
    @Published var skyShowCelestials: Bool {
        didSet { UserDefaults.standard.set(skyShowCelestials, forKey: "skyShowCelestials") }
    }
    @Published var skyShowHorizonMask: Bool {
        didSet { UserDefaults.standard.set(skyShowHorizonMask, forKey: "skyShowHorizonMask") }
    }
    /// Polar-plot-only: paint 5°×5° sky cells with a heatmap of peak SNR
    /// observed in each cell (u-center sky-view style). Default on because
    /// it's a more informative "background" than the red horizon-mask fill
    /// once any history has been recorded.
    @Published var skyShowSectorHeatmap: Bool {
        didSet { UserDefaults.standard.set(skyShowSectorHeatmap, forKey: "skyShowSectorHeatmap") }
    }
    /// When `false`, disables the Swift-side az/el moving-average filter so
    /// every rendered polyline vertex is a raw NMEA observation. Lets the
    /// user see the 1° integer-quantization staircase directly — useful to
    /// confirm trails are real observations, not interpolated fluff.
    @Published var skySmoothTrails: Bool {
        didSet { UserDefaults.standard.set(skySmoothTrails, forKey: "skySmoothTrails") }
    }

    init() {
        let d = UserDefaults.standard
        self.temperatureUnit = TemperatureUnit(rawValue: d.string(forKey: "temperatureUnit") ?? "C") ?? .celsius
        self.windSpeedUnit = WindSpeedUnit(rawValue: d.string(forKey: "windSpeedUnit") ?? "mph") ?? .mph
        self.weatherPollInterval = {
            let v = d.double(forKey: "weatherPollInterval")
            return v > 0 ? v : 120
        }()
        self.weatherDisplayFormat = WeatherDisplayFormat(rawValue: d.string(forKey: "weatherDisplayFormat") ?? "") ?? .temperatureConditions
        self.recentTexts = d.stringArray(forKey: "recentTexts") ?? []
        self.configWriteEnabled = d.bool(forKey: "configWriteEnabled")
        self.scrollInterval = {
            let v = d.double(forKey: "scrollInterval")
            return v > 0 ? v : 0.40
        }()
        self.skyViewMode = d.string(forKey: "skyViewMode") ?? "Polar"
        self.skyTimeWindow = d.string(forKey: "skyTimeWindow") ?? "1h"
        self.skyShowSatellites = d.object(forKey: "skyShowSatellites") == nil ? true : d.bool(forKey: "skyShowSatellites")
        self.skyShowLabels = d.object(forKey: "skyShowLabels") == nil ? true : d.bool(forKey: "skyShowLabels")
        self.skyShowCelestials = d.object(forKey: "skyShowCelestials") == nil ? true : d.bool(forKey: "skyShowCelestials")
        // Defaults to off because the sector heatmap (also default-on) shows
        // the same obstruction information in 2D with SNR colouring — the
        // horizon mask's only unique contribution is a crisp red silhouette
        // line, which most users don't need if they've already got the
        // heatmap filling in where signal lives.
        self.skyShowHorizonMask = d.object(forKey: "skyShowHorizonMask") == nil ? false : d.bool(forKey: "skyShowHorizonMask")
        self.skyShowSectorHeatmap = d.object(forKey: "skyShowSectorHeatmap") == nil ? true : d.bool(forKey: "skyShowSectorHeatmap")
        self.skySmoothTrails = d.object(forKey: "skySmoothTrails") == nil ? true : d.bool(forKey: "skySmoothTrails")
        // Clean up the old keys — we no longer read them, and leaving them in
        // place is just cruft that confuses anyone inspecting defaults.
        d.removeObject(forKey: "latitude")
        d.removeObject(forKey: "longitude")
    }

    func addRecentText(_ text: String) {
        recentTexts.removeAll { $0 == text }
        recentTexts.insert(text, at: 0)
        if recentTexts.count > 10 {
            recentTexts = Array(recentTexts.prefix(10))
        }
    }
}
