import AppKit
import ApplicationServices
import HelperMacOS
import HelperProtocol
import XCTest

final class MacOSCatalogTests: XCTestCase {
  func testApplicationCatalogReturnsRealRunningApplications() throws {
    let result = MacOSApplicationCatalog.list()
    XCTAssertFalse(result.applications.isEmpty)
    XCTAssertEqual(
      Set(result.applications.map(\.pid)).count,
      result.applications.count
    )
    for application in result.applications {
      XCTAssertGreaterThan(application.pid, 0)
      XCTAssertFalse(application.name.isEmpty)
    }
  }

  func testDisplayCatalogReturnsPrimaryLogicalBounds() throws {
    let result = MacOSDisplayCatalog.list()
    guard !result.displays.isEmpty else {
      throw XCTSkip("命令行测试进程没有可用的 NSScreen")
    }
    XCTAssertEqual(result.displays.filter(\.primary).count, 1)
    for display in result.displays {
      XCTAssertFalse(display.id.isEmpty)
      XCTAssertFalse(display.name.isEmpty)
      XCTAssertGreaterThan(display.bounds.width, 0)
      XCTAssertGreaterThan(display.bounds.height, 0)
      XCTAssertGreaterThan(display.scaleFactor, 0)
    }
  }

  func testWindowCatalogOnlyReturnsRequestedProcessWindows() throws {
    let finder = try XCTUnwrap(
      NSWorkspace.shared.runningApplications.first {
        $0.bundleIdentifier == "com.apple.finder"
      }
    )
    let result = MacOSWindowCatalog.list(pid: Int(finder.processIdentifier))
    XCTAssertTrue(result.windows.allSatisfy { $0.pid == Int(finder.processIdentifier) })
    XCTAssertTrue(result.windows.allSatisfy { $0.bounds.width > 0 })
    XCTAssertTrue(result.windows.allSatisfy { $0.bounds.height > 0 })
    XCTAssertEqual(
      Set(result.windows.map(\.windowId)).count,
      result.windows.count
    )
    XCTAssertEqual(MacOSWindowCatalog.list(pid: -1).windows, [])
  }

  func testAxTreeRejectsMissingApplicationAndObeysLimits() throws {
    let limits = ComputerUseHelperAxTreeLimits(
      maxDepth: 2,
      maxChildren: 3,
      maxNodes: 10,
      titleMaxChars: 20,
      valueMaxChars: 40,
      maxActions: 5,
      timeoutMs: 1_000
    )
    if AXIsProcessTrusted() {
      let finder = try XCTUnwrap(
        NSWorkspace.shared.runningApplications.first {
          $0.bundleIdentifier == "com.apple.finder"
        }
      )
      let tree = try MacOSAccessibilityTree.read(
        pid: Int(finder.processIdentifier),
        limits: limits
      )
      XCTAssertEqual(tree.root.role, "AXApplication")
      XCTAssertGreaterThan(tree.nodeCount, 0)
      XCTAssertLessThanOrEqual(tree.nodeCount, limits.maxNodes)
      assertWithinLimits(tree.root, depth: 0, limits: limits)

      XCTAssertThrowsError(
        try MacOSAccessibilityTree.read(pid: 999_999, limits: limits)
      ) { error in
        XCTAssertEqual(
          (error as? HelperOperationError)?.code,
          "application_not_found"
        )
      }
    } else {
      XCTAssertThrowsError(
        try MacOSAccessibilityTree.read(pid: 999_999, limits: limits)
      ) { error in
        XCTAssertEqual(
          (error as? HelperOperationError)?.code,
          "permission_denied"
        )
      }
    }
  }

  private func assertWithinLimits(
    _ node: ComputerUseHelperAxNode,
    depth: Int,
    limits: ComputerUseHelperAxTreeLimits
  ) {
    XCTAssertLessThanOrEqual(node.title?.count ?? 0, limits.titleMaxChars)
    XCTAssertLessThanOrEqual(node.value?.count ?? 0, limits.valueMaxChars)
    XCTAssertLessThanOrEqual(node.actions?.count ?? 0, limits.maxActions)
    if depth >= limits.maxDepth {
      XCTAssertNil(node.children)
      return
    }
    XCTAssertLessThanOrEqual(
      node.children?.count ?? 0,
      limits.maxChildren
    )
    for child in node.children ?? [] {
      assertWithinLimits(child, depth: depth + 1, limits: limits)
    }
  }

  func testBlackFrameDetectorDistinguishesBlackFromColoredFrames() throws {
    XCTAssertTrue(
      MacOSWindowCapture.isBlackFrame(
        try image(red: 0, green: 0, blue: 0)
      )
    )
    XCTAssertFalse(
      MacOSWindowCapture.isBlackFrame(
        try image(red: 255, green: 255, blue: 255)
      )
    )
    XCTAssertFalse(
      MacOSWindowCapture.isBlackFrame(
        try image(red: 220, green: 20, blue: 20)
      )
    )
  }

  func testWindowCaptureBindsFrameAndRespectsDimensionLimit() throws {
    guard CGPreflightScreenCaptureAccess() else {
      XCTAssertThrowsError(
        try MacOSWindowCapture.capture(pid: 1, windowId: 1)
      ) { error in
        XCTAssertEqual(
          (error as? HelperOperationError)?.code,
          "permission_denied"
        )
      }
      return
    }
    let finder = try XCTUnwrap(
      NSWorkspace.shared.runningApplications.first {
        $0.bundleIdentifier == "com.apple.finder"
      }
    )
    let window = MacOSWindowCatalog.list(
      pid: Int(finder.processIdentifier)
    ).windows.first { $0.onScreen }
    guard let window else {
      throw XCTSkip("访达当前没有可截图的窗口")
    }
    let shot = try MacOSWindowCapture.capture(
      pid: Int(finder.processIdentifier),
      windowId: window.windowId,
      maxBytes: 5_000_000,
      maxDimension: 320
    )
    XCTAssertEqual(shot.windowId, window.windowId)
    XCTAssertLessThanOrEqual(max(shot.width, shot.height), 320)
    XCTAssertGreaterThan(shot.width, 0)
    XCTAssertGreaterThan(shot.height, 0)
    XCTAssertGreaterThan(shot.frame.width, 0)
    XCTAssertFalse(shot.imageBase64.isEmpty)
    XCTAssertNotNil(Data(base64Encoded: shot.imageBase64))
    XCTAssertNotNil(
      ISO8601DateFormatter().date(from: shot.capturedAt)
    )
    XCTAssertThrowsError(
      try MacOSWindowCapture.capture(pid: 1, windowId: window.windowId)
    ) { error in
      XCTAssertEqual(
        (error as? HelperOperationError)?.code,
        "window_not_found"
      )
    }
  }

  private func image(red: Double, green: Double, blue: Double) throws
    -> CGImage
  {
    let context = try XCTUnwrap(
      CGContext(
        data: nil,
        width: 32,
        height: 32,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    )
    context.setFillColor(
      CGColor(
        colorSpace: CGColorSpaceCreateDeviceRGB(),
        components: [red / 255, green / 255, blue / 255, 1]
      )!
    )
    context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
    return try XCTUnwrap(context.makeImage())
  }
}
