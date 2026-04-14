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
    @Published var lastSerialPort: String {
        didSet { UserDefaults.standard.set(lastSerialPort, forKey: "lastSerialPort") }
    }
    @Published var latitude: Double {
        didSet { UserDefaults.standard.set(latitude, forKey: "latitude") }
    }
    @Published var longitude: Double {
        didSet { UserDefaults.standard.set(longitude, forKey: "longitude") }
    }
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

    init() {
        let d = UserDefaults.standard
        self.lastSerialPort = d.string(forKey: "lastSerialPort") ?? ""
        self.latitude = d.object(forKey: "latitude") as? Double ?? 51.4043
        self.longitude = d.object(forKey: "longitude") as? Double ?? -2.3234
        self.temperatureUnit = TemperatureUnit(rawValue: d.string(forKey: "temperatureUnit") ?? "C") ?? .celsius
        self.windSpeedUnit = WindSpeedUnit(rawValue: d.string(forKey: "windSpeedUnit") ?? "mph") ?? .mph
        self.weatherPollInterval = {
            let v = d.double(forKey: "weatherPollInterval")
            return v > 0 ? v : 120
        }()
        self.weatherDisplayFormat = WeatherDisplayFormat(rawValue: d.string(forKey: "weatherDisplayFormat") ?? "") ?? .temperatureConditions
        self.recentTexts = d.stringArray(forKey: "recentTexts") ?? []
        self.configWriteEnabled = d.bool(forKey: "configWriteEnabled")
    }

    func addRecentText(_ text: String) {
        recentTexts.removeAll { $0 == text }
        recentTexts.insert(text, at: 0)
        if recentTexts.count > 10 {
            recentTexts = Array(recentTexts.prefix(10))
        }
    }
}
