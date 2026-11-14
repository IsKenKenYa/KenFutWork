import HelperCore
import HelperProtocol
import XCTest

final class PermissionStatusBuilderTests: XCTestCase {
  private let identity = HelperPermissionIdentity(
    bundleId: "com.kenfutwork.cua-helper",
    path:
      "/Applications/KenFutWork.app/Contents/Resources/cua-helper/KenFutWork Computer Use.app",
    teamIdentifier: "8A5X4JJ39T"
  )

  func testBothPermissionsGranted() {
    let status = HelperPermissionStatusBuilder.make(
      identity: identity,
      accessibility: true,
      screenRecording: true
    )
    XCTAssertTrue(status.available)
    XCTAssertEqual(status.helperBundleId, identity.bundleId)
    XCTAssertEqual(status.helperPath, identity.path)
    XCTAssertEqual(status.teamIdentifier, identity.teamIdentifier)
    XCTAssertEqual(status.accessibility, .granted)
    XCTAssertEqual(status.screenRecording, .granted)
    XCTAssertEqual(status.grantOwner, identity.path)
  }

  func testMissingPermissionsBecomeDenied() {
    let status = HelperPermissionStatusBuilder.make(
      identity: identity,
      accessibility: false,
      screenRecording: false,
      reason: "需要在系统设置中授权"
    )
    XCTAssertEqual(status.accessibility, .denied)
    XCTAssertEqual(status.screenRecording, .denied)
    XCTAssertEqual(status.reason, "需要在系统设置中授权")
  }

  func testUnavailableProbeBecomesUnknown() {
    let status = HelperPermissionStatusBuilder.make(
      identity: identity,
      accessibility: nil,
      screenRecording: nil
    )
    XCTAssertEqual(status.accessibility, .unknown)
    XCTAssertEqual(status.screenRecording, .unknown)
  }

  func testFunctionalProbeFailureDowngradesTrustedPermissions() {
    let status = HelperPermissionStatusBuilder.make(
      identity: identity,
      accessibility: true,
      screenRecording: true,
      accessibilityProbeOk: false,
      screenCaptureProbeOk: false,
      reason: "权限预检通过但实际读取失败"
    )
    XCTAssertEqual(status.accessibility, .stale)
    XCTAssertEqual(status.screenRecording, .denied)
    XCTAssertEqual(status.accessibilityProbeOk, false)
    XCTAssertEqual(status.screenCaptureProbeOk, false)
    XCTAssertEqual(status.reason, "权限预检通过但实际读取失败")
  }

  func testSuccessfulProbeKeepsGrantedState() {
    let status = HelperPermissionStatusBuilder.make(
      identity: identity,
      accessibility: true,
      screenRecording: true,
      accessibilityProbeOk: true,
      screenCaptureProbeOk: true
    )
    XCTAssertEqual(status.accessibility, .granted)
    XCTAssertEqual(status.screenRecording, .granted)
  }
}
