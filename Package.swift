// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ClockApp",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/armadsen/ORSSerialPort.git", from: "2.1.0")
    ],
    targets: [
        .executableTarget(
            name: "ClockApp",
            dependencies: [
                .product(name: "ORSSerial", package: "ORSSerialPort")
            ]
        )
    ]
)
