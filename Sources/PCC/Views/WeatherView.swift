import SwiftUI

struct WeatherView: View {
    var body: some View {
        Form {
            Section("Weather Display") {
                VStack(spacing: 12) {
                    Image(systemName: "cloud.sun")
                        .font(.system(size: 36))
                        .foregroundStyle(.secondary)
                    Text("Coming Soon")
                        .font(.headline)
                    Text("Weather integration will be available in a future update.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            }
        }
        .formStyle(.grouped)
    }
}
