import AppKit
import ApplicationServices
import HelperProtocol
import XCTest
@testable import HelperMacOS

final class MacOSInputControllerTests: XCTestCase {
  func testAnsiKeyMapCoversLettersDigitsAndNamedKeys() {
    XCTAssertEqual(MacOSInputController.keyCode(for: "f"), 3)
    XCTAssertEqual(MacOSInputController.keyCode(for: "F"), 3)
    XCTAssertEqual(MacOSInputController.keyCode(for: "1"), 18)
    XCTAssertEqual(MacOSInputController.keyCode(for: "return"), 36)
    XCTAssertEqual(MacOSInputController.keyCode(for: "space"), 49)
    XCTAssertNil(MacOSInputController.keyCode(for: "not-a-key"))
  }

  func testUnknownKeyIsRejectedBeforeAnyEvent() throws {
    let controller = MacOSInputController()
    XCTAssertThrowsError(
      try controller.key(
        pid: Int(ProcessInfo.processInfo.processIdentifier),
        key: "definitely-not-a-key",
        modifiers: [],
        repeatCount: 1
      )
    ) { error in
      XCTAssertEqual(
        (error as? HelperOperationError)?.code,
        "invalid_request"
      )
    }
  }

  func testClipboardRoundTripRestoresPreviousText() throws {
    let pasteboard = NSPasteboard.general
    let previous = pasteboard.string(forType: .string)
    let marker = "kfw-cua-clipboard-\(UUID().uuidString)"
    defer {
      pasteboard.clearContents()
      if let previous {
        pasteboard.setString(previous, forType: .string)
      }
    }
    let controller = MacOSInputController()
    XCTAssertTrue(controller.writeClipboard(text: marker).written)
    XCTAssertEqual(controller.readClipboard().text, marker)
  }

  func testClickWithoutAccessibilityFailsClosed() throws {
    guard !AXIsProcessTrusted() else {
      throw XCTSkip("当前测试进程已有辅助功能授权，跳过以避免真实点击")
    }
    let controller = MacOSInputController()
    XCTAssertThrowsError(
      try controller.click(
        pid: Int(ProcessInfo.processInfo.processIdentifier),
        x: 0,
        y: 0,
        button: "left",
        clickCount: 1
      )
    ) { error in
      XCTAssertEqual(
        (error as? HelperOperationError)?.code,
        "permission_denied"
      )
    }
  }
}
