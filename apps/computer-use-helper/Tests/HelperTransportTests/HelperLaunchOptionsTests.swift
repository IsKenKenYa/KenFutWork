import HelperTransport
import XCTest

final class HelperLaunchOptionsTests: XCTestCase {
  private let token = String(repeating: "a", count: 64)

  func testParsesRequiredArgumentsAndOptionalTeam() throws {
    let options = try HelperLaunchOptions.parse([
      "--socket", "/tmp/kfw-helper.sock",
      "--token", token,
      "--bundle-id", "com.kenfutwork.cua-helper.dev",
      "--helper-path", "/Applications/KenFutWork Computer Use Dev.app",
      "--version", "0.1.0",
      "--team-id", "DEVTEAM",
    ])
    XCTAssertEqual(options.socketPath, "/tmp/kfw-helper.sock")
    XCTAssertEqual(options.token, token)
    XCTAssertEqual(options.bundleId, "com.kenfutwork.cua-helper.dev")
    XCTAssertEqual(
      options.helperPath,
      "/Applications/KenFutWork Computer Use Dev.app"
    )
    XCTAssertEqual(options.helperVersion, "0.1.0")
    XCTAssertEqual(options.teamIdentifier, "DEVTEAM")
    XCTAssertNil(options.parentPid)

    let withParent = try HelperLaunchOptions.parse([
      "--socket", "/tmp/kfw-helper.sock",
      "--token", token,
      "--bundle-id", "com.kenfutwork.cua-helper.dev",
      "--helper-path", "/Applications/KenFutWork Computer Use Dev.app",
      "--version", "0.1.0",
      "--parent-pid", "4321",
    ])
    XCTAssertEqual(withParent.parentPid, 4321)

    let withoutTeam = try HelperLaunchOptions.parse([
      "--socket", "/tmp/kfw-helper.sock",
      "--token", token,
      "--bundle-id", "com.kenfutwork.cua-helper.dev",
      "--helper-path", "/Applications/KenFutWork Computer Use Dev.app",
      "--version", "0.1.0",
    ])
    XCTAssertNil(withoutTeam.teamIdentifier)
  }

  func testRejectsMissingUnknownAndInvalidArguments() {
    XCTAssertThrowsError(
      try HelperLaunchOptions.parse([
        "--token", token,
        "--bundle-id", "com.kenfutwork.cua-helper.dev",
        "--helper-path", "/Applications/Helper.app",
        "--version", "0.1.0",
      ])
    )
    XCTAssertThrowsError(
      try HelperLaunchOptions.parse([
        "--socket", "/tmp/kfw-helper.sock",
        "--token", "short",
        "--bundle-id", "com.kenfutwork.cua-helper.dev",
        "--helper-path", "/Applications/Helper.app",
        "--version", "0.1.0",
      ])
    )
    XCTAssertThrowsError(
      try HelperLaunchOptions.parse([
        "--socket", "/tmp/kfw-helper.sock",
        "--token", token,
        "--bundle-id", "com.kenfutwork.cua-helper.dev",
        "--helper-path", "relative/Helper.app",
        "--version", "0.1.0",
      ])
    )
    XCTAssertThrowsError(
      try HelperLaunchOptions.parse([
        "--socket", "/tmp/kfw-helper.sock",
        "--token", token,
        "--bundle-id", "com.kenfutwork.cua-helper.dev",
        "--helper-path", "/Applications/Helper.app",
        "--version", "0.1.0",
        "--unknown", "value",
      ])
    )
    XCTAssertThrowsError(
      try HelperLaunchOptions.parse([
        "--socket",
        "--token", token,
        "--bundle-id", "com.kenfutwork.cua-helper.dev",
        "--helper-path", "/Applications/Helper.app",
        "--version", "0.1.0",
      ])
    )
    for invalidParent in ["0", "-1", "abc"] {
      XCTAssertThrowsError(
        try HelperLaunchOptions.parse([
          "--socket", "/tmp/kfw-helper.sock",
          "--token", token,
          "--bundle-id", "com.kenfutwork.cua-helper.dev",
          "--helper-path", "/Applications/Helper.app",
          "--version", "0.1.0",
          "--parent-pid", invalidParent,
        ])
      )
    }
  }
}
