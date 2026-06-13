import Foundation

extension Bundle {
    /// The SPM resource bundle (`PrecisionClockCompanion_PCC.bundle`),
    /// resolved in a packaging-safe way. Use this instead of `Bundle.module`
    /// anywhere that runs inside the packaged app.
    ///
    /// The accessor SwiftPM generates for *executable* targets only checks
    /// two locations: the directory of `Bundle.main` (for a packaged app
    /// that's the `.app` root, not `Contents/Resources/` where the bundle
    /// actually ships) and the absolute `.build/…/release` path on the
    /// machine that compiled the binary. The first never matches a packaged
    /// app and the second dangles as soon as the source checkout moves or
    /// the build dir is cleaned — `Bundle.module` then traps, which is
    /// exactly how 0.8.0 crashed the Satellites globe. Check the packaged
    /// location first; fall back to `Bundle.module` only for unpackaged
    /// dev layouts (`swift run`, `.build/debug/PCC`), where the generated
    /// accessor's build-directory lookup is valid.
    static let pccResources: Bundle = {
        if let url = Bundle.main.resourceURL?
            .appendingPathComponent("PrecisionClockCompanion_PCC.bundle"),
           let bundle = Bundle(url: url) {
            return bundle
        }
        return Bundle.module
    }()
}
