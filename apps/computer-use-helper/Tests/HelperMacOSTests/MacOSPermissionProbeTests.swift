import HelperCore
import HelperMacOS
import HelperProtocol
import XCTest

final class MacOSPermissionProbeTests: XCTestCase {
  func testProbeReportsTheCurrentHelperIdentity() {
    let identity = HelperPermissionIdentity(
      bundleId: "com.kenfutwork.cua-helper.test",
      path: "/Applications/KenFutWork Computer Use Test.app",
      teamIdentifier: nil
    )
    let status = MacOSPermissionProbe.currentStatus(identity: identity)

    XCTAssertTrue(status.available)
    XCTAssertEqual(status.helperBundleId, identity.bundleId)
    XCTAssertEqual(status.helperPath, identity.path)
    XCTAssertEqual(status.grantOwner, identity.path)
    XCTAssertTrue(
      [.granted, .denied].contains(status.accessibility),
      "TCC 查询必须返回明确状态，不能停在 unknown"
    )
    XCTAssertTrue(
      [.granted, .denied].contains(status.screenRecording),
      "屏幕录制查询必须返回明确状态，不能停在 unknown"
    )
  }
}
