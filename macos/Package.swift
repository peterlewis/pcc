// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "PrecisionClockCompanion",
    platforms: [.macOS(.v26)],
    dependencies: [
        .package(url: "https://github.com/armadsen/ORSSerialPort.git", from: "2.1.0")
    ],
    targets: [
        .executableTarget(
            name: "PCC",
            dependencies: [
                .product(name: "ORSSerial", package: "ORSSerialPort")
            ],
            // `Resources/Globe/` ships the globe.gl UMD bundle and its earth
            // textures so the 3D globe view works offline with a deterministic
            // version pin. See `THIRD_PARTY_LICENSES.md` at the repo root for
            // the MIT attributions.
            //
            // `timezone-names.json` is a vendored snapshot of the clock4
            // repo's firmware timezone list so the timezone picker still
            // works offline; TimezoneListLoader overlays the live GitHub
            // copy whenever the network allows.
            resources: [
                .copy("Resources/Globe"),
                .copy("Resources/timezone-names.json")
            ],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Info.plist"
                ])
            ]
        )
    ]
)
