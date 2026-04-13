// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PrecisionClockCompanion",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/armadsen/ORSSerialPort.git", from: "2.1.0")
    ],
    targets: [
        .executableTarget(
            name: "PCC",
            dependencies: [
                .product(name: "ORSSerial", package: "ORSSerialPort")
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
