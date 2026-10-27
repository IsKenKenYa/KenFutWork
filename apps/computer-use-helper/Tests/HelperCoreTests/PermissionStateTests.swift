import HelperCore
import XCTest

final class PermissionStateTests: XCTestCase {
  func testCheckThenDenialThenUserGrant() {
    var state = HelperPermissionState.unknown

    state = HelperPermissionReducer.reduce(state, .checkStarted)
    XCTAssertEqual(state, .checking)

    state = HelperPermissionReducer.reduce(
      state,
      .checkFinished(granted: false)
    )
    XCTAssertEqual(state, .denied)

    state = HelperPermissionReducer.reduce(state, .userGranted)
    XCTAssertEqual(state, .granted)
  }

  func testGrantedCanBecomeStaleAndRecoverOrBeRevoked() {
    var state = HelperPermissionState.granted

    state = HelperPermissionReducer.reduce(state, .staleDetected)
    XCTAssertEqual(state, .stale)

    state = HelperPermissionReducer.reduce(
      state,
      .checkFinished(granted: true)
    )
    XCTAssertEqual(state, .granted)

    state = HelperPermissionReducer.reduce(state, .revoked)
    XCTAssertEqual(state, .denied)
  }

  func testUnhandledEventsKeepTheCurrentState() {
    XCTAssertEqual(
      HelperPermissionReducer.reduce(.unknown, .revoked),
      .unknown
    )
    XCTAssertEqual(
      HelperPermissionReducer.reduce(.denied, .staleDetected),
      .denied
    )
    XCTAssertEqual(
      HelperPermissionReducer.reduce(.checking, .checkStarted),
      .checking
    )
  }
}
