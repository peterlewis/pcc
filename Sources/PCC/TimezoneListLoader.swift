import Foundation

class TimezoneListLoader: ObservableObject {
    @Published var timezones: [String] = []
    @Published var isLoading = false

    private static let url = URL(string: "https://raw.githubusercontent.com/mitxela/clock4/HEAD/qspi/timezone-names.json")!

    init() {
        load()
    }

    func load() {
        isLoading = true
        Task {
            do {
                let (data, _) = try await URLSession.shared.data(from: Self.url)
                let names = try JSONDecoder().decode([String].self, from: data)
                await MainActor.run {
                    self.timezones = names
                    self.isLoading = false
                }
            } catch {
                await MainActor.run { self.isLoading = false }
            }
        }
    }
}
