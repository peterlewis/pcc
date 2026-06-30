import Foundation
import WeatherKit
import CoreLocation
import MapKit

class WeatherManager: ObservableObject {
    @Published var temperature: String = ""
    @Published var condition: String = ""
    @Published var windSpeed: String = ""
    @Published var humidity: String = ""
    @Published var displayString: String = ""
    @Published var lastFetchTime: Date?
    @Published var lastError: String?
    /// Human-readable place name for the current weather fix
    /// (e.g. "Bath, Somerset"). Populated asynchronously by reverse-geocoding
    /// the GPS coordinates — empty until the first geocode resolves.
    @Published var locationName: String = ""
    @Published var isEnabled = false {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: "weatherEnabled")
            if isEnabled { startPolling() } else { stopPolling() }
        }
    }

    weak var serialManager: SerialManager?
    private var timer: Timer?
    private let service = WeatherKit.WeatherService.shared

    /// Last successful WeatherKit snapshot. Unit/format changes re-render
    /// this locally (see `reformatFromCache`) instead of re-fetching — the
    /// weather hasn't changed just because the user now prefers °F, and the
    /// old fetch-on-every-setting-change behaviour fired network requests
    /// even while the feature was switched off.
    private var lastWeather: CurrentWeather?

    /// Coordinates last sent to the geocoder — used to avoid re-geocoding on
    /// every poll when the GPS hasn't moved meaningfully. Empty until the
    /// first resolve.
    private var geocodedLat: Double?
    private var geocodedLon: Double?

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
        // Network fetches only run while the feature is on. Unit/format
        // changes go through `reformatFromCache()` instead of here, and this
        // guard keeps any other caller from quietly burning WeatherKit quota
        // for a display that's switched off.
        guard isEnabled else { return }

        // Location comes from the clock's own GPS fix — we never hit macOS
        // Location Services. No fix, no fetch; we surface the reason via
        // `lastError` so the weather UI can say something useful.
        guard let lat = serialManager?.gpsLatitude,
              let lon = serialManager?.gpsLongitude else {
            self.lastError = "Waiting for GPS fix from the clock"
            return
        }
        let location = CLLocation(latitude: lat, longitude: lon)

        Task {
            do {
                let weather = try await service.weather(for: location, including: .current)
                let display = formatForClock(weather)
                await MainActor.run {
                    self.lastWeather = weather
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
                    self.lastError = Self.describeWeatherError(error)
                }
            }
        }
        resolveLocationName(lat: lat, lon: lon)
    }

    /// Re-render the cached snapshot with the current unit/format settings
    /// and push it to the clock — no network involved. Called when the user
    /// flips temperature/wind units or the display format; a no-op until the
    /// first successful fetch populates the cache. `lastFetchTime` is left
    /// alone on purpose: the underlying data is no fresher than it was.
    func reformatFromCache() {
        guard let weather = lastWeather else { return }
        let display = formatForClock(weather)
        temperature = formatTemp(weather.temperature)
        condition = mapCondition(weather.condition)
        windSpeed = formatWind(weather.wind.speed)
        humidity = "\(Int(weather.humidity * 100))%"
        displayString = display
        sendToDisplay(display)
    }

    /// Translate a WeatherKit failure into something a human can act on.
    /// Auth failures surface as opaque daemon internals — "The operation
    /// couldn't be completed. (WDSJWTAuthenticatorServiceListener.Errors
    /// error 2.)" — which read like a crash rather than what they are: the
    /// build isn't signed with the WeatherKit entitlement, or the developer
    /// membership behind it has lapsed. Recognise those and lead with the
    /// fix, keeping the raw description as a parenthetical detail so the
    /// exact error stays searchable.
    private static func describeWeatherError(_ error: Error) -> String {
        let raw = error.localizedDescription
        let nsError = error as NSError
        let haystack = "\(nsError.domain) \(raw)"
        let authMarkers = ["WDSJWTAuthenticator", "JWTAuthenticator", "WeatherDaemon"]
        if authMarkers.contains(where: { haystack.contains($0) }) {
            return "WeatherKit authentication failed — the app must be signed with the "
                 + "WeatherKit entitlement and an active Apple Developer membership. (\(raw))"
        }
        return raw
    }

    /// Reverse-geocode the current GPS fix into a readable place name, caching
    /// aggressively so we don't hammer the geocoder on every poll. Only
    /// re-resolves when the position has shifted by more than ~500 m from the
    /// last successful resolve — GPS noise on a stationary clock wouldn't
    /// change the name anyway, and the geocoder has rate limits. Uses
    /// `MKReverseGeocodingRequest` (the macOS 26+ replacement for the
    /// deprecated `CLGeocoder`).
    private func resolveLocationName(lat: Double, lon: Double) {
        if let lastLat = geocodedLat, let lastLon = geocodedLon {
            let dLat = (lat - lastLat) * 111_000        // ~metres/degree
            let dLon = (lon - lastLon) * 111_000 * cos(lat * .pi / 180)
            if (dLat * dLat + dLon * dLon) < (500 * 500) { return }
        }
        let loc = CLLocation(latitude: lat, longitude: lon)
        guard let request = MKReverseGeocodingRequest(location: loc) else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                let items = try await request.mapItems
                guard let item = items.first else { return }
                let name = Self.formatMapItem(item)
                await MainActor.run {
                    self.locationName = name
                    self.geocodedLat = lat
                    self.geocodedLon = lon
                }
            } catch {
                // Silently ignore — we'll retry on the next GPS tick.
            }
        }
    }

    /// Compose a settlement-level label from an `MKMapItem`, trimmed down to
    /// "locality, region" style ("Bath, Somerset" / "Cupertino, CA"). The
    /// raw reverse-geocode against a GPS fix is doorstep-precise — it hands
    /// back "218 High Street, Bath, Somerset, BA1 5EA, United Kingdom" — which
    /// is more specific than a weather header needs, and more exposing than
    /// the user wants on a shared screen.
    ///
    /// `MKAddressRepresentations.cityWithContext` is Apple's built-in answer
    /// to exactly that problem: it returns "Cupertino, CA" / "Bath, Somerset"
    /// with locality + administrativeArea already composed, skipping the
    /// street and postcode. Falls back to `cityName` alone, then
    /// `regionName`, then empty.
    private static func formatMapItem(_ item: MKMapItem) -> String {
        guard let reps = item.addressRepresentations else { return "" }
        return reps.cityWithContext
            ?? reps.cityName
            ?? reps.regionName
            ?? ""
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
