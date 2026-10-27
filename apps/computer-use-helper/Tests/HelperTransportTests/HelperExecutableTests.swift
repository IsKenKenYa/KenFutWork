import Foundation
import XCTest

final class HelperExecutableTests: XCTestCase {
  func testExecutableServesHelloAndExitsAfterShutdown() throws {
    let executable = Bundle(for: Self.self).bundleURL
      .deletingLastPathComponent()
      .appendingPathComponent("kenfutwork-cua-helper")
    XCTAssertTrue(
      FileManager.default.isExecutableFile(atPath: executable.path),
      "找不到 Helper 可执行文件：\(executable.path)"
    )

    let socketPath =
      FileManager.default.temporaryDirectory
      .appendingPathComponent("kfw-\(UUID().uuidString.prefix(8)).sock").path
    let token = String(repeating: "a", count: 64)
    let process = Process()
    process.executableURL = executable
    process.arguments = [
      "--socket", socketPath,
      "--token", token,
      "--bundle-id", "com.kenfutwork.cua-helper.dev",
      "--helper-path", "/Applications/KenFutWork Computer Use Dev.app",
      "--version", "0.1.0",
      "--team-id", "DEVTEAM",
    ]
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    try process.run()
    defer {
      if process.isRunning { process.terminate() }
      process.waitUntilExit()
      try? FileManager.default.removeItem(atPath: socketPath)
    }

    let deadline = Date().addingTimeInterval(2)
    while !FileManager.default.fileExists(atPath: socketPath),
      Date() < deadline
    {
      Thread.sleep(forTimeInterval: 0.02)
    }
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: socketPath),
      "Helper 没有在期限内创建 socket"
    )

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
    let result = try XCTUnwrap(hello["result"] as? [String: Any])
    XCTAssertEqual(
      result["bundleId"] as? String,
      "com.kenfutwork.cua-helper.dev"
    )

    try client.send(["id": "2", "method": "permission.status"])
    let statusResponse = try client.receive()
    XCTAssertEqual(statusResponse["ok"] as? Bool, true)
    let status = try XCTUnwrap(
      statusResponse["result"] as? [String: Any]
    )
    XCTAssertEqual(status["available"] as? Bool, true)
    XCTAssertTrue(
      ["granted", "denied"].contains(status["accessibility"] as? String ?? "")
    )
    XCTAssertTrue(
      ["granted", "denied"].contains(status["screenRecording"] as? String ?? "")
    )

    try client.send(["id": "3", "method": "helper.shutdown"])
    let shutdown = try client.receive()
    XCTAssertEqual(shutdown["ok"] as? Bool, true)

    let exitDeadline = Date().addingTimeInterval(2)
    while process.isRunning, Date() < exitDeadline {
      Thread.sleep(forTimeInterval: 0.02)
    }
    XCTAssertFalse(process.isRunning, "Helper 收到 shutdown 后没有退出")
    if process.isRunning { process.terminate() }
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    XCTAssertFalse(FileManager.default.fileExists(atPath: socketPath))
  }

  func testExecutableRemovesSocketOnSigterm() throws {
    let executable = Bundle(for: Self.self).bundleURL
      .deletingLastPathComponent()
      .appendingPathComponent("kenfutwork-cua-helper")
    let socketPath =
      FileManager.default.temporaryDirectory
      .appendingPathComponent("kfw-\(UUID().uuidString.prefix(8)).sock").path
    let process = Process()
    process.executableURL = executable
    process.arguments = [
      "--socket", socketPath,
      "--token", String(repeating: "b", count: 64),
      "--bundle-id", "com.kenfutwork.cua-helper.dev",
      "--helper-path", "/Applications/KenFutWork Computer Use Dev.app",
      "--version", "0.1.0",
    ]
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    try process.run()
    defer {
      if process.isRunning { process.terminate() }
      process.waitUntilExit()
      try? FileManager.default.removeItem(atPath: socketPath)
    }

    let deadline = Date().addingTimeInterval(2)
    while !FileManager.default.fileExists(atPath: socketPath),
      Date() < deadline
    {
      Thread.sleep(forTimeInterval: 0.02)
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: socketPath))

    process.terminate()
    let exitDeadline = Date().addingTimeInterval(2)
    while process.isRunning, Date() < exitDeadline {
      Thread.sleep(forTimeInterval: 0.02)
    }
    XCTAssertFalse(process.isRunning)
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    XCTAssertFalse(FileManager.default.fileExists(atPath: socketPath))
  }

  func testExecutableExitsWhenParentProcessDisappears() throws {
    let executable = Bundle(for: Self.self).bundleURL
      .deletingLastPathComponent()
      .appendingPathComponent("kenfutwork-cua-helper")
    let parent = Process()
    parent.executableURL = URL(fileURLWithPath: "/bin/sleep")
    parent.arguments = ["0.2"]
    try parent.run()
    let socketPath =
      FileManager.default.temporaryDirectory
      .appendingPathComponent("kfw-\(UUID().uuidString.prefix(8)).sock").path
    let process = Process()
    process.executableURL = executable
    process.arguments = [
      "--socket", socketPath,
      "--token", String(repeating: "c", count: 64),
      "--bundle-id", "com.kenfutwork.cua-helper.dev",
      "--helper-path", "/Applications/KenFutWork Computer Use Dev.app",
      "--version", "0.1.0",
      "--parent-pid", String(parent.processIdentifier),
    ]
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    try process.run()
    defer {
      if process.isRunning { process.terminate() }
      process.waitUntilExit()
      try? FileManager.default.removeItem(atPath: socketPath)
    }

    let deadline = Date().addingTimeInterval(2)
    while !FileManager.default.fileExists(atPath: socketPath),
      Date() < deadline
    {
      Thread.sleep(forTimeInterval: 0.02)
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: socketPath))

    parent.waitUntilExit()
    let exitDeadline = Date().addingTimeInterval(6)
    while process.isRunning, Date() < exitDeadline {
      Thread.sleep(forTimeInterval: 0.1)
    }
    XCTAssertFalse(process.isRunning, "父进程消失后 Helper 没有退出")
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    XCTAssertFalse(FileManager.default.fileExists(atPath: socketPath))
  }
}
