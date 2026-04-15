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
