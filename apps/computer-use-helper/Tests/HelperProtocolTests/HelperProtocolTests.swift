import Foundation
import HelperProtocol
import XCTest

final class HelperProtocolTests: XCTestCase {
  private let helperBundleId = "com.kenfutwork.cua-helper"
  private let helperPath =
    "/Applications/KenFutWork.app/Contents/Resources/cua-helper/KenFutWork Computer Use.app"

  func testDecodesPermissionStatusAndKeepsHelperIdentity() throws {
    let json = """
      {
        "available": true,
        "helperBundleId": "\(helperBundleId)",
        "helperPath": "\(helperPath)",
        "teamIdentifier": "8A5X4JJ39T",
        "accessibility": "granted",
        "screenRecording": "denied",
        "grantOwner": "\(helperPath)",
        "reason": "屏幕录制未授权"
      }
      """

    let status = try JSONDecoder().decode(
      ComputerUseHelperPermissionStatus.self,
      from: Data(json.utf8)
    )

    XCTAssertTrue(status.available)
    XCTAssertEqual(status.helperBundleId, helperBundleId)
    XCTAssertEqual(status.helperPath, helperPath)
    XCTAssertEqual(status.teamIdentifier, "8A5X4JJ39T")
    XCTAssertEqual(status.accessibility, .granted)
    XCTAssertEqual(status.screenRecording, .denied)
    XCTAssertEqual(status.grantOwner, helperPath)
    XCTAssertEqual(status.reason, "屏幕录制未授权")
  }

  func testEncodesNullableIdentityFieldsAsNull() throws {
    let status = ComputerUseHelperPermissionStatus(
      available: true,
      helperBundleId: helperBundleId,
      helperPath: helperPath,
      teamIdentifier: nil,
      accessibility: .denied,
      screenRecording: .denied,
      grantOwner: nil
    )
    let data = try JSONEncoder().encode(status)
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: data) as? [String: Any]
    )
    XCTAssertTrue(object["teamIdentifier"] is NSNull)
    XCTAssertTrue(object["grantOwner"] is NSNull)
  }

  func testRejectsPermissionStatusWhoseGrantOwnerIsNotTheHelper() {
    let json = """
      {
        "available": true,
        "helperBundleId": "\(helperBundleId)",
        "helperPath": "\(helperPath)",
        "teamIdentifier": "8A5X4JJ39T",
        "accessibility": "granted",
        "screenRecording": "denied",
        "grantOwner": "com.kenfutwork.desktop"
      }
      """

    XCTAssertThrowsError(
      try JSONDecoder().decode(
        ComputerUseHelperPermissionStatus.self,
        from: Data(json.utf8)
      )
    )
  }

  func testRejectsRelativeHelperPathAndInvalidScreenRecordingState() {
    let relativePath = """
      {
        "available": true,
        "helperBundleId": "\(helperBundleId)",
        "helperPath": "relative/helper.app",
        "teamIdentifier": null,
        "accessibility": "granted",
        "screenRecording": "denied",
        "grantOwner": "\(helperBundleId)"
      }
      """
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        ComputerUseHelperPermissionStatus.self,
        from: Data(relativePath.utf8)
      )
    )

    let staleScreen = """
      {
        "available": true,
        "helperBundleId": "\(helperBundleId)",
        "helperPath": "\(helperPath)",
        "teamIdentifier": null,
        "accessibility": "granted",
        "screenRecording": "stale",
        "grantOwner": "\(helperBundleId)"
      }
      """
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        ComputerUseHelperPermissionStatus.self,
        from: Data(staleScreen.utf8)
      )
    )
  }

  func testDecodesHelloResultAndRejectsAnotherProtocolVersion() throws {
    let json = """
      {
        "protocolVersion": 1,
        "helperVersion": "0.1.0",
        "bundleId": "\(helperBundleId)",
        "pid": 12345,
        "teamIdentifier": "8A5X4JJ39T",
        "permissions": {
          "accessibility": "granted",
          "screenRecording": "denied"
        }
      }
      """

    let hello = try JSONDecoder().decode(
      ComputerUseHelperHelloResult.self,
      from: Data(json.utf8)
    )
    XCTAssertEqual(hello.protocolVersion, 1)
    XCTAssertEqual(hello.bundleId, helperBundleId)
    XCTAssertEqual(hello.pid, 12345)
    XCTAssertEqual(hello.permissions.accessibility, .granted)
    XCTAssertEqual(hello.permissions.screenRecording, .denied)

    let nextVersion = json.replacingOccurrences(
      of: "\"protocolVersion\": 1",
      with: "\"protocolVersion\": 2"
    )
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        ComputerUseHelperHelloResult.self,
        from: Data(nextVersion.utf8)
      )
    )
  }

  func testApplicationEncodingUsesExplicitNullForMissingIdentity() throws {
    let application = ComputerUseHelperApplication(
      pid: 501,
      name: "后台进程",
      bundleId: nil,
      path: nil,
      active: false,
      hidden: true
    )
    let data = try JSONEncoder().encode(application)
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: data) as? [String: Any]
    )
    XCTAssertTrue(object["bundleId"] is NSNull)
    XCTAssertTrue(object["path"] is NSNull)
    XCTAssertEqual(object["pid"] as? Int, 501)
  }
}
