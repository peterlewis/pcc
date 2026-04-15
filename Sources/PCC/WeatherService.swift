import Foundation
import WeatherKit
import CoreLocation

class WeatherManager: ObservableObject {
    @Published var temperature: String = ""
    @Published var condition: String = ""
    @Published var windSpeed: String = ""
    @Published var humidity: String = ""
    @Published var displayString: String = ""
    @Published var lastFetchTime: Date?
    @Published var lastError: String?
    @Published var isEnabled = false {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: "weatherEnabled")
            if isEnabled { startPolling() } else { stopPolling() }
        }
    }

    weak var serialManager: SerialManager?
    private var timer: Timer?
    private let service = WeatherKit.WeatherService.shared

    init() {
        self.isEnabled = UserDefaults.standard.bool(forKey: "weatherEnabled")
    }

    func activate() {
        if isEnabled { startPolling() }
    }

    // MARK: - Polling

    func startPolling() {
        timer?.invalidate()
        serialManager?.activateDisplayMode(.weather)
        fetchNow()
        let interval = pollInterval
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.fetchNow()
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
        if serialManager?.activeDisplayMode == .weather {
            serialManager?.stopScrolling()
            serialManager?.activateDisplayMode(.none)
        }
    }

    func resumeDisplay() {
        guard isEnabled, !displayString.isEmpty else { return }
        serialManager?.activateDisplayMode(.weather)
        serialManager?.sendCommand("mode_text = 1")
        serialManager?.sendScrollingText(displayString)
    }

    func fetchNow() {
        let lat = UserDefaults.standard.object(forKey: "latitude") as? Double ?? 51.4043
        let lon = UserDefaults.standard.object(forKey: "longitude") as? Double ?? -2.3234
        let location = CLLocation(latitude: lat, longitude: lon)

        Task {
            do {
                let weather = try await service.weather(for: location, including: .current)
                let display = formatForClock(weather)
                await MainActor.run {
                    self.temperature = self.formatTemp(weather.temperature)
                    self.condition = self.mapCondition(weather.condition)
                    self.windSpeed = self.formatWind(weather.wind.speed)
                    self.humidity = "\(Int(weather.humidity * 100))%"
                    self.displayString = display
                    self.lastFetchTime = Date()
                    self.lastError = nil

                    self.sendToDisplay(display)
                }
            } catch {
                await MainActor.run {
                    self.lastError = error.localizedDescription
                }
            }
        }
    }

    private func sendToDisplay(_ value: String) {
        guard let sm = serialManager else { return }
        guard sm.activeDisplayMode == .weather else { return }
        sm.sendCommand("mode_text = 1")
        sm.sendScrollingText(value)
    }

    private var pollInterval: TimeInterval {
        let v = UserDefaults.standard.double(forKey: "weatherPollInterval")
        return v >= 30 ? v : 120
    }

    // MARK: - Clock display formatting (0-9 a-z - only)

    private func formatForClock(_ weather: CurrentWeather) -> String {
        let tempUnit = TemperatureUnit(rawValue: UserDefaults.standard.string(forKey: "temperatureUnit") ?? "C") ?? .celsius
        let windUnit = WindSpeedUnit(rawValue: UserDefaults.standard.string(forKey: "windSpeedUnit") ?? "mph") ?? .mph
        let format = WeatherDisplayFormat(rawValue: UserDefaults.standard.string(forKey: "weatherDisplayFormat") ?? "") ?? .temperatureConditions

        let temp = convertTemp(weather.temperature, to: tempUnit)
        // No degree symbol - clock can't display it
        let tempStr: String
        if temp == temp.rounded() {
            tempStr = "\(Int(temp))\(tempUnit.rawValue)"
        } else {
            tempStr = String(format: "%.1f%@", temp, tempUnit.rawValue)
        }

        let wind = convertWind(weather.wind.speed, to: windUnit)
        let windStr = "\(Int(round(wind)))\(windUnit.rawValue)"

        let cond = mapCondition(weather.condition)

        switch format {
        case .temperatureOnly:       return tempStr
        case .temperatureConditions: return "\(tempStr) \(cond)"
        case .temperatureWind:       return "\(tempStr) \(windStr)"
        case .full:                  return "\(tempStr) \(cond) \(windStr)"
        }
    }

    // MARK: - UI formatting (with symbols)

    private func formatTemp(_ measurement: Measurement<UnitTemperature>) -> String {
        let tempUnit = TemperatureUnit(rawValue: UserDefaults.standard.string(forKey: "temperatureUnit") ?? "C") ?? .celsius
        let value = convertTemp(measurement, to: tempUnit)
        return String(format: "%.1f°%@", value, tempUnit.rawValue)
    }

    private func convertTemp(_ measurement: Measurement<UnitTemperature>, to unit: TemperatureUnit) -> Double {
        switch unit {
        case .celsius:    return measurement.converted(to: .celsius).value
        case .fahrenheit: return measurement.converted(to: .fahrenheit).value
        }
    }

    private func formatWind(_ measurement: Measurement<UnitSpeed>) -> String {
        let windUnit = WindSpeedUnit(rawValue: UserDefaults.standard.string(forKey: "windSpeedUnit") ?? "mph") ?? .mph
        let value = convertWind(measurement, to: windUnit)
        return "\(Int(round(value))) \(windUnit.rawValue)"
    }

    private func convertWind(_ measurement: Measurement<UnitSpeed>, to unit: WindSpeedUnit) -> Double {
        switch unit {
        case .mph:   return measurement.converted(to: .milesPerHour).value
        case .kmh:   return measurement.converted(to: .kilometersPerHour).value
        case .ms:    return measurement.converted(to: .metersPerSecond).value
        case .knots: return measurement.converted(to: .knots).value
        }
    }

    // Short labels that fit the clock's character set (a-z 0-9 -)
    private func mapCondition(_ condition: WeatherCondition) -> String {
        switch condition {
        case .clear:                            return "clear"
        case .mostlyClear:                      return "fair"
        case .partlyCloudy:                     return "cloudy"
        case .mostlyCloudy:                     return "cloudy"
        case .cloudy:                           return "overcast"
        case .drizzle:                          return "drizzle"
        case .rain:                             return "rain"
        case .heavyRain:                        return "hvy rain"
        case .snow, .flurries:                  return "snow"
        case .heavySnow, .blizzard:             return "hvy snow"
        case .foggy:                            return "fog"
        case .haze:                             return "haze"
        case .thunderstorms, .strongStorms:     return "storm"
        case .hail:                             return "hail"
        case .windy, .breezy:                   return "windy"
        case .frigid:                           return "frigid"
        case .hot:                              return "hot"
        case .sleet, .freezingRain:             return "sleet"
        case .freezingDrizzle:                  return "frz rain"
        case .tropicalStorm, .hurricane:        return "storm"
        default:                                return "---"
        }
    }
}
