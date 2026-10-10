// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "EquationExplainer",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "EquationExplainer", targets: ["EquationExplainer"]),
    ],
    targets: [
        .target(name: "EECore", path: "Sources/EECore"),
        .executableTarget(name: "EquationExplainer", dependencies: ["EECore"], path: "Sources/EquationExplainer"),
        .testTarget(name: "EECoreTests", dependencies: ["EECore"], path: "Tests/EECoreTests"),
    ]
)
