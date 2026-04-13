import Foundation
import CryptoKit

struct CurrentWeather: Sendable {
    let temperature: Double   // Celsius (from API with en-GB)
    let conditionCode: String
    let windSpeed: Double     // km/h (from API with en-GB)
    let humidity: Double
}

enum WeatherError: LocalizedError {
    case missingCredentials
    case invalidKey(String)
    case invalidResponse
    case apiError(statusCode: Int, message: String)
    case parseError

    var errorDescription: String? {
        switch self {
        case .missingCredentials:
            return "WeatherKit credentials not configured. Set them in Preferences."
        case .invalidKey(let detail):
            return "Invalid .p8 private key: \(detail)"
        case .invalidResponse:
            return "Invalid response from WeatherKit API"
        case .apiError(let code, let msg):
            return "API error \(code): \(msg)"
        case .parseError:
            return "Failed to parse weather data"
        }
    }
}

class WeatherService: ObservableObject {
    @Published var currentWeather: CurrentWeather?
    @Published var displayString = ""
    @Published var lastFetchTime: Date?
    @Published var nextFetchTime: Date?
    @Published var lastError: String?
    @Published var isEnabled = false {
        didSet {
            if isEnabled { startPolling() } else { stopPolling() }
        }
    }

    weak var serialManager: SerialManager?
    private var timer: Timer?

    // MARK: - Polling

    func startPolling() {
        fetchWeatherNow()
        let interval = pollInterval
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.fetchWeatherNow()
        }
        nextFetchTime = Date().addingTimeInterval(interval)
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
        nextFetchTime = nil
    }

    func fetchWeatherNow() {
        Task { [weak self] in
            guard let self else { return }
            do {
                let weather = try await self.fetchWeather()
                let display = self.formatForDisplay(weather)
                await MainActor.run {
                    self.currentWeather = weather
                    self.displayString = display
                    self.lastFetchTime = Date()
                    self.lastError = nil
                    self.nextFetchTime = Date().addingTimeInterval(self.pollInterval)

                    if self.isEnabled {
                        self.serialManager?.sendCommand("text = \(display)")
                        self.serialManager?.sendCommand("mode_text = 1")
                    }
                }
            } catch {
                await MainActor.run {
                    self.lastError = error.localizedDescription
                }
            }
        }
    }

    private var pollInterval: TimeInterval {
        let v = UserDefaults.standard.double(forKey: "weatherPollInterval")
        return v >= 30 ? v : 120
    }

    // MARK: - WeatherKit API

    private func fetchWeather() async throws -> CurrentWeather {
        let jwt = try createJWT()

        let d = UserDefaults.standard
        let lat = d.object(forKey: "latitude") as? Double ?? 51.4043
        let lon = d.object(forKey: "longitude") as? Double ?? -2.3234

        guard let url = URL(string:
            "https://weatherkit.apple.com/api/v1/weather/en-GB/\(lat)/\(lon)?dataSets=currentWeather"
        ) else { throw WeatherError.invalidResponse }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw WeatherError.invalidResponse
        }
        guard http.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw WeatherError.apiError(statusCode: http.statusCode, message: body)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cw = json["currentWeather"] as? [String: Any],
              let temperature = cw["temperature"] as? Double,
              let conditionCode = cw["conditionCode"] as? String,
              let windSpeed = cw["windSpeed"] as? Double,
              let humidity = cw["humidity"] as? Double
        else { throw WeatherError.parseError }

        return CurrentWeather(
            temperature: temperature,
            conditionCode: conditionCode,
            windSpeed: windSpeed,
            humidity: humidity
        )
    }

    // MARK: - JWT

    private func createJWT() throws -> String {
        let d = UserDefaults.standard
        let teamID    = d.string(forKey: "weatherTeamID") ?? ""
        let serviceID = d.string(forKey: "weatherServiceID") ?? ""
        let keyID     = d.string(forKey: "weatherKeyID") ?? ""
        let p8Path    = d.string(forKey: "weatherP8KeyPath") ?? ""

        guard !teamID.isEmpty, !serviceID.isEmpty, !keyID.isEmpty, !p8Path.isEmpty else {
            throw WeatherError.missingCredentials
        }

        let keyPEM: String
        do {
            keyPEM = try String(contentsOfFile: p8Path, encoding: .utf8)
        } catch {
            throw WeatherError.invalidKey("Cannot read file at \(p8Path)")
        }

        let privateKey: P256.Signing.PrivateKey
        do {
            privateKey = try P256.Signing.PrivateKey(pemRepresentation: keyPEM)
        } catch {
            throw WeatherError.invalidKey(error.localizedDescription)
        }

        // Header
        let header: [String: String] = [
            "alg": "ES256",
            "kid": keyID,
            "id": "\(teamID).\(serviceID)"
        ]
        // Payload
        let now = Int(Date().timeIntervalSince1970)
        let payload: [String: Any] = [
            "iss": teamID,
            "iat": now,
            "exp": now + 3600,
            "sub": serviceID
        ]

        let headerB64  = try JSONSerialization.data(withJSONObject: header).base64URLEncoded
        let payloadB64 = try JSONSerialization.data(withJSONObject: payload).base64URLEncoded

        let signingInput = "\(headerB64).\(payloadB64)"
        let signature = try privateKey.signature(for: Data(signingInput.utf8))
        let signatureB64 = signature.rawRepresentation.base64URLEncoded

        return "\(signingInput).\(signatureB64)"
    }

    // MARK: - Display formatting

    func formatForDisplay(_ weather: CurrentWeather) -> String {
        let d = UserDefaults.standard
        let tempUnit = TemperatureUnit(rawValue: d.string(forKey: "temperatureUnit") ?? "C") ?? .celsius
        let windUnit = WindSpeedUnit(rawValue: d.string(forKey: "windSpeedUnit") ?? "mph") ?? .mph
        let format = WeatherDisplayFormat(rawValue: d.string(forKey: "weatherDisplayFormat") ?? "") ?? .temperatureConditions

        // Temperature conversion
        var temp = weather.temperature
        if tempUnit == .fahrenheit { temp = temp * 9.0 / 5.0 + 32.0 }
        let tempStr = String(format: "%.1f%@", temp, tempUnit.rawValue)

        // Wind speed conversion (API returns km/h for en-GB)
        var wind = weather.windSpeed
        switch windUnit {
        case .mph:   wind *= 0.621371
        case .kmh:   break
        case .ms:    wind /= 3.6
        case .knots: wind *= 0.539957
        }
        let windStr = "\(Int(round(wind)))\(windUnit.rawValue)"

        let condition = Self.mapConditionCode(weather.conditionCode)

        switch format {
        case .temperatureOnly:      return tempStr
        case .temperatureConditions: return "\(tempStr) \(condition)"
        case .temperatureWind:      return "\(tempStr) \(windStr)"
        case .full:                 return "\(tempStr) \(condition) \(windStr)"
        }
    }

    static func mapConditionCode(_ code: String) -> String {
        switch code {
        case "Clear":        return "Clear"
        case "MostlyClear":  return "Fair"
        case "PartlyCloudy": return "Cloudy"
        case "MostlyCloudy": return "Cloudy"
        case "Overcast":     return "Overcast"
        case "Drizzle":      return "Drizzle"
        case "Rain":         return "Rain"
        case "HeavyRain":    return "HvyRain"
        case "Snow":         return "Snow"
        case "HeavySnow":    return "HvySnow"
        case "Foggy":        return "Fog"
        case "Haze":         return "Haze"
        case "Thunderstorms": return "Storm"
        case "Hail":         return "Hail"
        case "Windy":        return "Windy"
        default:             return String(code.prefix(8))
        }
    }
}

// MARK: - Base64URL

extension Data {
    var base64URLEncoded: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
