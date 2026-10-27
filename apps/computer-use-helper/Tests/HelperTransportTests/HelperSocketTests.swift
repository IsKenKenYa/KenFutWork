import Foundation
import HelperCore
import HelperProtocol
import HelperTransport
import XCTest

final class HelperSocketTests: XCTestCase {
  private let helperBundleId = "com.kenfutwork.cua-helper"
  private let helperPath =
    "/Applications/KenFutWork.app/Contents/Resources/cua-helper/KenFutWork Computer Use.app"
  private let token = String(repeating: "a", count: 64)
  private var socketPath: String!
  private var server: HelperSocketServer!
  private var shutdownExpectation: XCTestExpectation?
  private var requestedKinds: [HelperPermissionRequestKind] = []
  private var probedFlags: [Bool] = []

  override func setUpWithError() throws {
    socketPath =
      FileManager.default.temporaryDirectory
      .appendingPathComponent("kfw-\(UUID().uuidString.prefix(8)).sock").path

    let status = ComputerUseHelperPermissionStatus(
      available: true,
      helperBundleId: helperBundleId,
      helperPath: helperPath,
      teamIdentifier: "8A5X4JJ39T",
      accessibility: .denied,
      screenRecording: .denied,
      grantOwner: helperPath,
      reason: "辅助功能与屏幕录制未授权"
    )
    server = HelperSocketServer(
      configuration: HelperSocketConfiguration(
        socketPath: socketPath,
        token: token,
        helperBundleId: helperBundleId,
        helperPath: helperPath,
        helperVersion: "0.1.0",
        teamIdentifier: "8A5X4JJ39T"
      ),
      permissionStatus: { [weak self] probe in
        self?.probedFlags.append(probe)
        return status
      },
      permissionRequest: { [weak self] kind in
        self?.requestedKinds.append(kind)
        return HelperPermissionRequestResult(
          requested: true,
          granted: false,
          reason: "测试授权提示"
        )
      },
      applications: {
        ComputerUseHelperApplicationsResult(applications: [
          ComputerUseHelperApplication(
            pid: 501,
            name: "访达",
            bundleId: "com.apple.finder",
            path: "/System/Library/CoreServices/Finder.app",
            active: true,
            hidden: false
          )
        ])
      },
      windows: { pid in
        guard pid == 501 else {
          return ComputerUseHelperWindowsResult(windows: [])
        }
        return ComputerUseHelperWindowsResult(windows: [
          ComputerUseHelperWindow(
            windowId: 42,
            pid: pid,
            title: "访达",
            layer: 0,
            onScreen: true,
            bounds: ComputerUseHelperBounds(
              x: 10,
              y: 20,
              width: 800,
              height: 600
            )
          )
        ])
      },
      displays: {
        ComputerUseHelperDisplaysResult(displays: [
          ComputerUseHelperDisplay(
            id: "1",
            name: "内建显示器",
            bounds: ComputerUseHelperBounds(
              x: 0,
              y: 0,
              width: 1512,
              height: 982
            ),
            scaleFactor: 2,
            primary: true
          )
        ])
      },
      accessibilityTree: { pid, limits in
        guard pid == 501 else {
          throw HelperOperationError(
            code: "permission_denied",
            message: "辅助功能未授权"
          )
        }
        return ComputerUseHelperAxTreeResult(
          pid: pid,
          root: ComputerUseHelperAxNode(
            role: "AXApplication",
            title: "访达",
            children: [
              ComputerUseHelperAxNode(
                role: "AXWindow",
                title: "访达",
                position: ComputerUseHelperPoint(x: 10, y: 20),
                size: ComputerUseHelperSize(width: 800, height: 600),
                actions: ["AXRaise"]
              )
            ]
          ),
          nodeCount: 2,
          truncated: limits.maxNodes < 10
        )
      },
      screenshot: { pid, windowId, maxBytes, maxDimension in
        guard windowId == 42 else {
          throw HelperOperationError(
            code: "window_not_found",
            message: "目标窗口不存在"
          )
        }
        return ComputerUseHelperScreenshotResult(
          pid: pid,
          windowId: windowId,
          frame: ComputerUseHelperBounds(
            x: 10,
            y: 20,
            width: 800,
            height: 600
          ),
          width: min(800, maxDimension),
          height: min(600, maxDimension),
          imageBase64: Data("png".utf8).base64EncodedString(),
          blackFrame: false,
          capturedAt: "2026-10-27T02:00:00.000Z"
        )
      },
      onShutdown: { [weak self] in self?.shutdownExpectation?.fulfill() }
    )
    try server.start()
  }

  override func tearDownWithError() throws {
    server.stop()
    try? FileManager.default.removeItem(atPath: socketPath)
  }

  func testHelloThenPermissionStatusReturnsHelperIdentity() throws {
    let client = try UnixSocketTestClient(path: socketPath)

    try client.send([
      "id": "1",
      "method": "hello",
      "params": [
        "protocolVersion": 1,
        "client": "kenfutwork-desktop",
        "clientVersion": "0.1.3",
        "token": token,
      ],
    ])
    let hello = try client.receive()
    XCTAssertEqual(hello["ok"] as? Bool, true)
    let helloResult = try XCTUnwrap(hello["result"] as? [String: Any])
    XCTAssertEqual(helloResult["bundleId"] as? String, helperBundleId)
    XCTAssertEqual(helloResult["pid"] as? Int, Int(ProcessInfo.processInfo.processIdentifier))
    let permissions = try XCTUnwrap(
      helloResult["permissions"] as? [String: Any]
    )
    XCTAssertEqual(permissions["accessibility"] as? String, "denied")
    XCTAssertEqual(permissions["screenRecording"] as? String, "denied")

    try client.send(["id": "2", "method": "permission.status"])
    let statusResponse = try client.receive()
    XCTAssertEqual(statusResponse["ok"] as? Bool, true)
    let status = try XCTUnwrap(
      statusResponse["result"] as? [String: Any]
    )
    XCTAssertEqual(status["helperBundleId"] as? String, helperBundleId)
    XCTAssertEqual(status["helperPath"] as? String, helperPath)
    XCTAssertEqual(status["grantOwner"] as? String, helperPath)
    XCTAssertEqual(status["accessibility"] as? String, "denied")
    XCTAssertEqual(status["screenRecording"] as? String, "denied")

    try client.send([
      "id": "3",
      "method": "permission.status",
      "params": ["probe": true],
    ])
    let probed = try client.receive()
    XCTAssertEqual(probed["ok"] as? Bool, true)
    XCTAssertEqual(probedFlags.last, true)

    try client.send([
      "id": "4",
      "method": "permission.status",
      "params": ["probe": "yes"],
    ])
    let invalidProbe = try client.receive()
    XCTAssertEqual(
      (invalidProbe["error"] as? [String: Any])?["code"] as? String,
      "invalid_request"
    )
  }

  func testHelloRejectsWrongVersionAndToken() throws {
    let versionClient = try UnixSocketTestClient(path: socketPath)
    try versionClient.send([
      "id": "1",
      "method": "hello",
      "params": [
        "protocolVersion": 2,
        "client": "kenfutwork-desktop",
        "clientVersion": "0.1.3",
        "token": token,
      ],
    ])
    let versionResponse = try versionClient.receive()
    XCTAssertEqual(versionResponse["ok"] as? Bool, false)
    let versionError = try XCTUnwrap(
      versionResponse["error"] as? [String: Any]
    )
    XCTAssertEqual(
      versionError["code"] as? String,
      "unsupported_protocol_version"
    )

    let tokenClient = try UnixSocketTestClient(path: socketPath)
    try tokenClient.send([
      "id": "2",
      "method": "hello",
      "params": [
        "protocolVersion": 1,
        "client": "kenfutwork-desktop",
        "clientVersion": "0.1.3",
        "token": String(repeating: "b", count: 64),
      ],
    ])
    let tokenResponse = try tokenClient.receive()
    XCTAssertEqual(tokenResponse["ok"] as? Bool, false)
    let tokenError = try XCTUnwrap(tokenResponse["error"] as? [String: Any])
    XCTAssertEqual(tokenError["code"] as? String, "unauthorized")
  }

  func testStatusBeforeHelloAndUnknownMethodReturnErrors() throws {
    let unauthenticated = try UnixSocketTestClient(path: socketPath)
    try unauthenticated.send(["id": "1", "method": "permission.status"])
    let unauthenticatedResponse = try unauthenticated.receive()
    XCTAssertEqual(unauthenticatedResponse["ok"] as? Bool, false)
    let unauthenticatedError = try XCTUnwrap(
      unauthenticatedResponse["error"] as? [String: Any]
    )
    XCTAssertEqual(unauthenticatedError["code"] as? String, "unauthorized")

    let client = try UnixSocketTestClient(path: socketPath)
    try client.send([
      "id": "2",
      "method": "hello",
      "params": [
        "protocolVersion": 1,
        "client": "kenfutwork-desktop",
        "clientVersion": "0.1.3",
        "token": token,
      ],
    ])
    _ = try client.receive()
    try client.send(["id": "3", "method": "not-a-method"])
    let unknownResponse = try client.receive()
    XCTAssertEqual(unknownResponse["ok"] as? Bool, false)
    let unknownError = try XCTUnwrap(
      unknownResponse["error"] as? [String: Any]
    )
    XCTAssertEqual(unknownError["code"] as? String, "method_not_found")
  }

  func testMalformedLineReturnsInvalidRequest() throws {
    let client = try UnixSocketTestClient(path: socketPath)
    try client.sendRaw("not json\n")
    let response = try client.receive()
    XCTAssertEqual(response["ok"] as? Bool, false)
    let error = try XCTUnwrap(response["error"] as? [String: Any])
    XCTAssertEqual(error["code"] as? String, "invalid_request")
  }

  func testPermissionRequestDelegatesToInjectedPrompt() throws {
    let client = try UnixSocketTestClient(path: socketPath)
    try client.send([
      "id": "1",
      "method": "hello",
      "params": [
        "protocolVersion": 1,
        "client": "kenfutwork-desktop",
        "clientVersion": "0.1.3",
        "token": token,
      ],
    ])
    _ = try client.receive()

    try client.send([
      "id": "2",
      "method": "permission.request",
      "params": ["kind": "screen_recording"],
    ])
    let response = try client.receive()
    XCTAssertEqual(response["ok"] as? Bool, true)
    let result = try XCTUnwrap(response["result"] as? [String: Any])
    XCTAssertEqual(result["requested"] as? Bool, true)
    XCTAssertEqual(result["granted"] as? Bool, false)
    XCTAssertEqual(result["reason"] as? String, "测试授权提示")
    XCTAssertEqual(requestedKinds, [.screenRecording])

    try client.send([
      "id": "3",
      "method": "permission.request",
      "params": ["kind": "camera"],
    ])
    let invalid = try client.receive()
    XCTAssertEqual(invalid["ok"] as? Bool, false)
    let error = try XCTUnwrap(invalid["error"] as? [String: Any])
    XCTAssertEqual(error["code"] as? String, "invalid_request")
  }

  func testShutdownStopsServerAndRemovesSocket() throws {
    shutdownExpectation = expectation(description: "helper shutdown")
    let client = try UnixSocketTestClient(path: socketPath)
    try client.send([
      "id": "1",
      "method": "hello",
      "params": [
        "protocolVersion": 1,
        "client": "kenfutwork-desktop",
        "clientVersion": "0.1.3",
        "token": token,
      ],
    ])
    _ = try client.receive()

    try client.send(["id": "2", "method": "helper.shutdown"])
    let response = try client.receive()
    XCTAssertEqual(response["ok"] as? Bool, true)

    wait(for: [try XCTUnwrap(shutdownExpectation)], timeout: 1)
    XCTAssertFalse(server.isRunning)
    XCTAssertFalse(FileManager.default.fileExists(atPath: socketPath))
  }

  func testCatalogAndAxTreeDispatchToInjectedProviders() throws {
    let client = try UnixSocketTestClient(path: socketPath)
    try authenticate(client)

    try client.send(["id": "apps", "method": "apps.list"])
    let apps = try client.receive()
    XCTAssertEqual(apps["ok"] as? Bool, true)
    let appList = try XCTUnwrap(
      (apps["result"] as? [String: Any])?["applications"] as? [[String: Any]]
    )
    XCTAssertEqual(appList.count, 1)
    XCTAssertEqual(appList[0]["pid"] as? Int, 501)
    XCTAssertEqual(appList[0]["bundleId"] as? String, "com.apple.finder")

    try client.send(["id": "windows", "method": "windows.list", "params": ["pid": 501]])
    let windows = try client.receive()
    XCTAssertEqual(windows["ok"] as? Bool, true)
    let windowList = try XCTUnwrap(
      (windows["result"] as? [String: Any])?["windows"] as? [[String: Any]]
    )
    XCTAssertEqual(windowList.first?["windowId"] as? Int, 42)
    let bounds = try XCTUnwrap(windowList.first?["bounds"] as? [String: Any])
    XCTAssertEqual(bounds["width"] as? Double, 800)

    try client.send(["id": "displays", "method": "displays.list"])
    let displays = try client.receive()
    let displayList = try XCTUnwrap(
      (displays["result"] as? [String: Any])?["displays"] as? [[String: Any]]
    )
    XCTAssertEqual(displayList.first?["id"] as? String, "1")
    XCTAssertEqual(displayList.first?["primary"] as? Bool, true)

    try client.send([
      "id": "bad-pid",
      "method": "windows.list",
      "params": ["pid": 0],
    ])
    let badPid = try client.receive()
    XCTAssertEqual(
      (badPid["error"] as? [String: Any])?["code"] as? String,
      "invalid_request"
    )

    try client.send([
      "id": "ax",
      "method": "ax.tree",
      "params": ["pid": 501, "maxDepth": 2, "maxNodes": 20],
    ])
    let tree = try client.receive()
    XCTAssertEqual(tree["ok"] as? Bool, true)
    let treeResult = try XCTUnwrap(tree["result"] as? [String: Any])
    XCTAssertEqual(treeResult["nodeCount"] as? Int, 2)
    let root = try XCTUnwrap(treeResult["root"] as? [String: Any])
    XCTAssertEqual(root["role"] as? String, "AXApplication")
    XCTAssertEqual(
      (root["children"] as? [[String: Any]])?.first?["role"] as? String,
      "AXWindow"
    )

    try client.send([
      "id": "ax-denied",
      "method": "ax.tree",
      "params": ["pid": 999],
    ])
    let denied = try client.receive()
    XCTAssertEqual(
      (denied["error"] as? [String: Any])?["code"] as? String,
      "permission_denied"
    )

    try client.send([
      "id": "shot",
      "method": "screenshot.capture",
      "params": ["pid": 501, "windowId": 42, "maxDimension": 300],
    ])
    let shot = try client.receive()
    XCTAssertEqual(shot["ok"] as? Bool, true)
    let shotResult = try XCTUnwrap(shot["result"] as? [String: Any])
    XCTAssertEqual(shotResult["width"] as? Int, 300)
    XCTAssertEqual(shotResult["format"] as? String, "png")
    XCTAssertEqual(shotResult["blackFrame"] as? Bool, false)
    let frame = try XCTUnwrap(shotResult["frame"] as? [String: Any])
    XCTAssertEqual(frame["width"] as? Double, 800)

    try client.send([
      "id": "shot-missing",
      "method": "screenshot.capture",
      "params": ["pid": 501, "windowId": 7],
    ])
    let missing = try client.receive()
    XCTAssertEqual(
      (missing["error"] as? [String: Any])?["code"] as? String,
      "window_not_found"
    )

    try client.send([
      "id": "shot-invalid",
      "method": "screenshot.capture",
      "params": ["pid": 501, "windowId": 42, "maxDimension": 8],
    ])
    let invalid = try client.receive()
    XCTAssertEqual(
      (invalid["error"] as? [String: Any])?["code"] as? String,
      "invalid_request"
    )

    try client.send([
      "id": "click-missing",
      "method": "input.click",
      "params": ["pid": 501],
    ])
    let clickMissing = try client.receive()
    XCTAssertEqual(
      (clickMissing["error"] as? [String: Any])?["code"] as? String,
      "invalid_request"
    )

    try client.send([
      "id": "click",
      "method": "input.click",
      "params": ["pid": 501, "x": 10, "y": 20],
    ])
    let click = try client.receive()
    XCTAssertEqual(
      (click["error"] as? [String: Any])?["code"] as? String,
      "input_unavailable"
    )

    try client.send(["id": "clipboard", "method": "clipboard.read"])
    let clipboard = try client.receive()
    XCTAssertEqual(
      (clipboard["error"] as? [String: Any])?["code"] as? String,
      "input_unavailable"
    )
  }

  private func authenticate(_ client: UnixSocketTestClient) throws {
    try client.send([
      "id": "hello",
      "method": "hello",
      "params": [
        "protocolVersion": 1,
        "client": "kenfutwork-desktop",
        "clientVersion": "0.1.3",
        "token": token,
      ],
    ])
    let hello = try client.receive()
    XCTAssertEqual(hello["ok"] as? Bool, true)
  }

  func testSocketFileIsOwnerOnly() throws {
    let attributes = try FileManager.default.attributesOfItem(
      atPath: socketPath
    )
    let permissions = try XCTUnwrap(
      attributes[.posixPermissions] as? NSNumber
    )
    XCTAssertEqual(permissions.intValue & 0o777, 0o600)
  }
}

final class UnixSocketTestClient {
  private let fileDescriptor: Int32

  init(path: String) throws {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = path.utf8CString
    guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path)
    else {
      close(descriptor)
      throw NSError(
        domain: NSPOSIXErrorDomain,
        code: Int(ENAMETOOLONG)
      )
    }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) {
        destination in
        pathBytes.withUnsafeBufferPointer { source in
          destination.initialize(from: source.baseAddress!, count: source.count)
        }
      }
    }

    let result = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(
          descriptor,
          $0,
          socklen_t(MemoryLayout<sockaddr_un>.size)
        )
      }
    }
    guard result == 0 else {
      let code = errno
      close(descriptor)
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
    var noSigPipe: Int32 = 1
    _ = setsockopt(
      descriptor,
      SOL_SOCKET,
      SO_NOSIGPIPE,
      &noSigPipe,
      socklen_t(MemoryLayout<Int32>.size)
    )
    fileDescriptor = descriptor
  }

  deinit {
    close(fileDescriptor)
  }

  func send(_ object: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: object)
    var payload = data
    payload.append(0x0A)
    try writeAll(payload)
  }

  func sendRaw(_ line: String) throws {
    try writeAll(Data(line.utf8))
  }

  private func writeAll(_ payload: Data) throws {
    try payload.withUnsafeBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        let written = write(
          fileDescriptor,
          buffer.baseAddress!.advanced(by: offset),
          buffer.count - offset
        )
        guard written > 0 else {
          throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        offset += written
      }
    }
  }

  func receive() throws -> [String: Any] {
    var buffer = Data()
    var byte = UInt8(0)
    while true {
      let count = read(fileDescriptor, &byte, 1)
      guard count == 1 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      if byte == 0x0A { break }
      buffer.append(byte)
      guard buffer.count <= 32 * 1024 * 1024 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(EMSGSIZE))
      }
    }
    guard
      let object = try JSONSerialization.jsonObject(with: buffer)
        as? [String: Any]
    else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(EINVAL))
    }
    return object
  }
}
