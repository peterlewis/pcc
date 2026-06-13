import Foundation

/// Loads the list of IANA timezone names the clock firmware understands.
///
/// The authoritative copy lives in the clock4 repo (it tracks whatever tzdb
/// snapshot the firmware was built against), so we still fetch it from
/// GitHub for freshness — but a snapshot of the same file is vendored into
/// the app's resource bundle and loaded synchronously at init, so the
/// timezone picker is never silently empty when the Mac is offline. A failed
/// network refresh keeps the bundled list and just flags `usedFallback` so
/// the UI can mention the list may be slightly stale; it is never an error.
class TimezoneListLoader: ObservableObject {
    @Published var timezones: [String] = []
    @Published var isLoading = false
    /// True when the network refresh failed and `timezones` is the bundled
    /// snapshot rather than the live list. Purely informational — the
    /// bundled names remain valid picker entries for the shipped firmware.
    @Published var usedFallback = false

    private static let url = URL(string: "https://raw.githubusercontent.com/mitxela/clock4/HEAD/qspi/timezone-names.json")!

    init() {
        loadBundledSnapshot()
        load()
    }

    /// Seed the picker from the snapshot shipped in the app's resource
    /// bundle (Sources/PCC/Resources/timezone-names.json, vendored from the
    /// clock4 repo). Resolved via `Bundle.pccResources` rather than
    /// `Bundle.module`, which traps in the packaged-app layout — see
    /// ResourceBundle.swift for the full story. Failure here is tolerable
    /// (the network fetch may still populate the list), so no error surface.
    private func loadBundledSnapshot() {
        guard let url = Bundle.pccResources.url(forResource: "timezone-names", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let names = try? JSONDecoder().decode([String].self, from: data) else {
            return
        }
        timezones = names
    }

    func load() {
        isLoading = true
        Task {
            do {
                let (data, _) = try await URLSession.shared.data(from: Self.url)
                let names = try JSONDecoder().decode([String].self, from: data)
                await MainActor.run {
                    self.timezones = names
                    self.usedFallback = false
                    self.isLoading = false
                }
            } catch {
                // Offline or a GitHub hiccup: keep whatever the bundled
                // snapshot gave us and note that the refresh didn't land.
                await MainActor.run {
                    self.usedFallback = true
                    self.isLoading = false
                }
            }
        }
    }
}
