// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "KenFutWorkComputerUseHelper",
  platforms: [.macOS(.v12)],
  products: [
    .library(name: "HelperProtocol", targets: ["HelperProtocol"]),
    .library(name: "HelperCore", targets: ["HelperCore"]),
    .library(name: "HelperTransport", targets: ["HelperTransport"]),
    .library(name: "HelperMacOS", targets: ["HelperMacOS"]),
    .executable(
      name: "kenfutwork-cua-helper",
      targets: ["kenfutwork-cua-helper"]
    ),
  ],
  targets: [
    .target(name: "HelperProtocol"),
    .target(name: "HelperCore", dependencies: ["HelperProtocol"]),
    .target(
      name: "HelperTransport",
      dependencies: ["HelperCore", "HelperProtocol"]
    ),
    .target(
      name: "HelperMacOS",
      dependencies: ["HelperCore", "HelperProtocol"]
    ),
    .executableTarget(
      name: "kenfutwork-cua-helper",
      dependencies: [
        "HelperTransport",
        "HelperMacOS",
        "HelperCore",
        "HelperProtocol",
      ]
    ),
    .testTarget(name: "HelperProtocolTests", dependencies: ["HelperProtocol"]),
    .testTarget(
      name: "HelperCoreTests",
      dependencies: ["HelperCore", "HelperProtocol"]
    ),
    .testTarget(
      name: "HelperMacOSTests",
      dependencies: ["HelperMacOS", "HelperCore", "HelperProtocol"]
    ),
    .testTarget(
      name: "HelperTransportTests",
      dependencies: [
        "HelperTransport",
        "HelperCore",
        "HelperProtocol",
        "kenfutwork-cua-helper",
      ]
    ),
  ],
  swiftLanguageModes: [.v5]
)
