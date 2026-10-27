import Darwin
import Foundation
import HelperCore
import HelperProtocol

public struct HelperSocketConfiguration: Sendable {
  public let socketPath: String
  public let token: String
  public let helperBundleId: String
  public let helperPath: String
  public let helperVersion: String
  public let teamIdentifier: String?

  public init(
    socketPath: String,
    token: String,
    helperBundleId: String,
    helperPath: String,
    helperVersion: String,
    teamIdentifier: String?
  ) {
    self.socketPath = socketPath
    self.token = token
    self.helperBundleId = helperBundleId
    self.helperPath = helperPath
    self.helperVersion = helperVersion
    self.teamIdentifier = teamIdentifier
  }
}

public enum HelperSocketError: Error, LocalizedError {
  case invalidConfiguration(String)
  case systemCall(String, Int32)

  public var errorDescription: String? {
    switch self {
    case .invalidConfiguration(let reason):
      return "Helper socket 配置无效：\(reason)"
    case .systemCall(let operation, let code):
      return "Helper socket \(operation) 失败：errno \(code)"
    }
  }
}

/// 本地 Helper 的单实例 Unix socket 服务。身份与权限状态由注入的 provider 提供。
public final class HelperSocketServer {
  private static let maximumFrameBytes = 32 * 1024 * 1024

  public let socketPath: String
  public var isRunning: Bool { running }
  private let configuration: HelperSocketConfiguration
  private let permissionStatus: (Bool) -> ComputerUseHelperPermissionStatus
  private let permissionRequest: ((HelperPermissionRequestKind) -> HelperPermissionRequestResult)?
  private let applications: (() -> ComputerUseHelperApplicationsResult)?
  private let windows: ((Int) -> ComputerUseHelperWindowsResult)?
  private let displays: (() -> ComputerUseHelperDisplaysResult)?
  private let accessibilityTree:
    (
      (Int, ComputerUseHelperAxTreeLimits) throws
        -> ComputerUseHelperAxTreeResult
    )?
  private let screenshot:
    (
      (Int, Int, Int, Int) throws -> ComputerUseHelperScreenshotResult
    )?
  private let input: (any HelperInputProviding)?
  private let onShutdown: (() -> Void)?
  private let queue = DispatchQueue(label: "kenfutwork.cua.helper.socket")
  private var listenDescriptor: Int32 = -1
  private var acceptSource: DispatchSourceRead?
  private var running = false

  public init(
    configuration: HelperSocketConfiguration,
    permissionStatus: @escaping (Bool) -> ComputerUseHelperPermissionStatus,
    permissionRequest: (
      (HelperPermissionRequestKind) -> HelperPermissionRequestResult
    )? = nil,
    applications: (() -> ComputerUseHelperApplicationsResult)? = nil,
    windows: ((Int) -> ComputerUseHelperWindowsResult)? = nil,
    displays: (() -> ComputerUseHelperDisplaysResult)? = nil,
    accessibilityTree: (
      (Int, ComputerUseHelperAxTreeLimits) throws
        -> ComputerUseHelperAxTreeResult
    )? = nil,
    screenshot: (
      (Int, Int, Int, Int) throws -> ComputerUseHelperScreenshotResult
    )? = nil,
    input: (any HelperInputProviding)? = nil,
    onShutdown: (() -> Void)? = nil
  ) {
    self.configuration = configuration
    self.socketPath = configuration.socketPath
    self.permissionStatus = permissionStatus
    self.permissionRequest = permissionRequest
    self.applications = applications
    self.windows = windows
    self.displays = displays
    self.accessibilityTree = accessibilityTree
    self.screenshot = screenshot
    self.input = input
    self.onShutdown = onShutdown
  }

  deinit {
    stop()
  }

  public func start() throws {
    guard !running else { return }
    guard configuration.token.count == 64 else {
      throw HelperSocketError.invalidConfiguration("token 必须是 64 位十六进制字符串")
    }
    guard !configuration.socketPath.isEmpty else {
      throw HelperSocketError.invalidConfiguration("socketPath 不能为空")
    }

    unlink(configuration.socketPath)

    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else {
      throw HelperSocketError.systemCall("socket", errno)
    }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = configuration.socketPath.utf8CString
    guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path)
    else {
      close(descriptor)
      throw HelperSocketError.invalidConfiguration("socketPath 过长")
    }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) {
        destination in
        pathBytes.withUnsafeBufferPointer { source in
          destination.initialize(from: source.baseAddress!, count: source.count)
        }
      }
    }

    let bindResult = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(
          descriptor,
          $0,
          socklen_t(MemoryLayout<sockaddr_un>.size)
        )
      }
    }
    guard bindResult == 0 else {
      let code = errno
      close(descriptor)
      throw HelperSocketError.systemCall("bind", code)
    }
    guard chmod(configuration.socketPath, S_IRUSR | S_IWUSR) == 0 else {
      let code = errno
      close(descriptor)
      unlink(configuration.socketPath)
      throw HelperSocketError.systemCall("chmod", code)
    }
    guard listen(descriptor, 16) == 0 else {
      let code = errno
      close(descriptor)
      unlink(configuration.socketPath)
      throw HelperSocketError.systemCall("listen", code)
    }

    let flags = fcntl(descriptor, F_GETFL, 0)
    _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)

    listenDescriptor = descriptor
    let source = DispatchSource.makeReadSource(
      fileDescriptor: descriptor,
      queue: queue
    )
    source.setEventHandler { [weak self] in
      self?.acceptPendingClients()
    }
    acceptSource = source
    running = true
    source.resume()
  }

  public func stop() {
    guard running || listenDescriptor >= 0 else { return }
    running = false
    acceptSource?.cancel()
    acceptSource = nil
    if listenDescriptor >= 0 {
      close(listenDescriptor)
      listenDescriptor = -1
    }
    unlink(configuration.socketPath)
  }

  private func acceptPendingClients() {
    while running, listenDescriptor >= 0 {
      let clientDescriptor = accept(listenDescriptor, nil, nil)
      if clientDescriptor < 0 {
        if errno == EAGAIN || errno == EWOULDBLOCK { return }
        return
      }
      var noSigPipe: Int32 = 1
      _ = setsockopt(
        clientDescriptor,
        SOL_SOCKET,
        SO_NOSIGPIPE,
        &noSigPipe,
        socklen_t(MemoryLayout<Int32>.size)
      )
      // macOS 上 accept 会继承监听 socket 的非阻塞标志；客户端连接需要阻塞读取。
      let clientFlags = fcntl(clientDescriptor, F_GETFL, 0)
      _ = fcntl(clientDescriptor, F_SETFL, clientFlags & ~O_NONBLOCK)
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        self?.handleClient(clientDescriptor)
      }
    }
  }

  private func handleClient(_ clientDescriptor: Int32) {
    defer { close(clientDescriptor) }
    var authenticated = false
    var buffer = Data()

    while running {
      var chunk = [UInt8](repeating: 0, count: 4096)
      let count = read(clientDescriptor, &chunk, chunk.count)
      if count <= 0 { return }
      buffer.append(contentsOf: chunk.prefix(count))
      if buffer.count > Self.maximumFrameBytes {
        sendError(
          id: "unknown",
          code: "frame_too_large",
          message: "请求帧超过上限",
          to: clientDescriptor
        )
        return
      }

      while let newline = buffer.firstIndex(of: 0x0A) {
        let line = buffer[..<newline]
        buffer.removeSubrange(buffer.startIndex...newline)
        let lineData = Data(line)
        guard
          handleLine(
            lineData,
            authenticated: &authenticated,
            clientDescriptor: clientDescriptor
          )
        else {
          return
        }
      }
    }
  }

  private func handleLine(
    _ line: Data,
    authenticated: inout Bool,
    clientDescriptor: Int32
  ) -> Bool {
    guard
      !line.isEmpty,
      let object = try? JSONSerialization.jsonObject(with: line)
        as? [String: Any],
      let id = object["id"] as? String,
      !id.isEmpty,
      let method = object["method"] as? String,
      !method.isEmpty
    else {
      sendError(
        id: "unknown",
        code: "invalid_request",
        message: "请求必须是带 id 和 method 的 JSON 对象",
        to: clientDescriptor
      )
      return false
    }

    if !authenticated {
      guard method == "hello" else {
        sendError(
          id: id,
          code: "unauthorized",
          message: "未完成 hello 握手",
          to: clientDescriptor
        )
        return false
      }
      guard let params = object["params"] as? [String: Any] else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "hello 缺少参数",
          to: clientDescriptor
        )
        return false
      }
      let version = params["protocolVersion"] as? Int
      guard version == ComputerUseHelperProtocol.version else {
        sendError(
          id: id,
          code: "unsupported_protocol_version",
          message: "不支持的 Helper 协议版本",
          to: clientDescriptor
        )
        return false
      }
      guard
        let token = params["token"] as? String,
        token == configuration.token,
        let client = params["client"] as? String,
        !client.isEmpty,
        let clientVersion = params["clientVersion"] as? String,
        !clientVersion.isEmpty
      else {
        sendError(
          id: id,
          code: "unauthorized",
          message: "Helper 客户端身份无效",
          to: clientDescriptor
        )
        return false
      }
      authenticated = true
      let status = permissionStatus(false)
      let result = ComputerUseHelperHelloResult(
        protocolVersion: ComputerUseHelperProtocol.version,
        helperVersion: configuration.helperVersion,
        bundleId: configuration.helperBundleId,
        pid: Int(ProcessInfo.processInfo.processIdentifier),
        teamIdentifier: configuration.teamIdentifier,
        permissions: ComputerUseHelperHelloPermissions(
          accessibility: status.accessibility,
          screenRecording: status.screenRecording
        )
      )
      return sendSuccess(
        id: id,
        result: (try? jsonObject(result)) ?? [:],
        to: clientDescriptor
      )
    }

    switch method {
    case "ping":
      return sendSuccess(id: id, result: ["pong": true], to: clientDescriptor)
    case "permission.status":
      var probe = false
      if let rawParams = object["params"] {
        guard
          let params = rawParams as? [String: Any],
          params.keys.allSatisfy({ $0 == "probe" })
        else {
          sendError(
            id: id,
            code: "invalid_request",
            message: "permission.status 参数不合法",
            to: clientDescriptor
          )
          return true
        }
        if let rawProbe = params["probe"] {
          guard let parsed = rawProbe as? Bool else {
            sendError(
              id: id,
              code: "invalid_request",
              message: "permission.status.probe 必须是布尔值",
              to: clientDescriptor
            )
            return true
          }
          probe = parsed
        }
      }
      return sendSuccess(
        id: id,
        result: (try? jsonObject(permissionStatus(probe))) ?? [:],
        to: clientDescriptor
      )
    case "permission.request":
      guard
        let params = object["params"] as? [String: Any],
        let rawKind = params["kind"] as? String,
        let kind = HelperPermissionRequestKind(rawValue: rawKind)
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "permission.request 需要合法的 kind",
          to: clientDescriptor
        )
        return true
      }
      guard let permissionRequest else {
        sendError(
          id: id,
          code: "permission_request_unavailable",
          message: "当前 Helper 未接入权限提示",
          to: clientDescriptor
        )
        return true
      }
      let outcome = permissionRequest(kind)
      var result: [String: Any] = ["requested": outcome.requested]
      if let granted = outcome.granted { result["granted"] = granted }
      if let reason = outcome.reason { result["reason"] = reason }
      return sendSuccess(id: id, result: result, to: clientDescriptor)
    case "apps.list":
      guard let applications else {
        sendError(
          id: id,
          code: "applications_unavailable",
          message: "当前 Helper 未接入应用枚举",
          to: clientDescriptor
        )
        return true
      }
      return sendResult(id: id, result: applications(), to: clientDescriptor)
    case "windows.list":
      guard
        let params = object["params"] as? [String: Any],
        let rawPid = params["pid"] as? NSNumber
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "windows.list 需要合法的 pid",
          to: clientDescriptor
        )
        return true
      }
      let pid = rawPid.intValue
      guard pid > 0 else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "windows.list 需要合法的 pid",
          to: clientDescriptor
        )
        return true
      }
      guard let windows else {
        sendError(
          id: id,
          code: "windows_unavailable",
          message: "当前 Helper 未接入窗口枚举",
          to: clientDescriptor
        )
        return true
      }
      return sendResult(
        id: id,
        result: windows(pid),
        to: clientDescriptor
      )
    case "displays.list":
      guard let displays else {
        sendError(
          id: id,
          code: "displays_unavailable",
          message: "当前 Helper 未接入显示器枚举",
          to: clientDescriptor
        )
        return true
      }
      return sendResult(
        id: id,
        result: displays(),
        to: clientDescriptor
      )
    case "ax.tree":
      guard
        let params = object["params"] as? [String: Any],
        let rawPid = params["pid"] as? NSNumber
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "ax.tree 需要合法的 pid",
          to: clientDescriptor
        )
        return true
      }
      let pid = rawPid.intValue
      guard pid > 0 else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "ax.tree 需要合法的 pid",
          to: clientDescriptor
        )
        return true
      }
      guard let accessibilityTree else {
        sendError(
          id: id,
          code: "ax_unavailable",
          message: "当前 Helper 未接入 AX 树",
          to: clientDescriptor
        )
        return true
      }
      do {
        let result = try accessibilityTree(
          pid,
          ComputerUseHelperAxTreeLimits(json: params)
        )
        return sendResult(id: id, result: result, to: clientDescriptor)
      } catch let error as HelperOperationError {
        sendError(
          id: id,
          code: error.code,
          message: error.message,
          to: clientDescriptor
        )
        return true
      } catch {
        sendError(
          id: id,
          code: "helper_internal_error",
          message: "AX 树读取失败：\(error)",
          to: clientDescriptor
        )
        return true
      }
    case "screenshot.capture":
      guard
        let params = object["params"] as? [String: Any],
        let rawPid = params["pid"] as? NSNumber,
        let rawWindowId = params["windowId"] as? NSNumber
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "screenshot.capture 需要 pid 与 windowId",
          to: clientDescriptor
        )
        return true
      }
      let pid = rawPid.intValue
      let windowId = rawWindowId.intValue
      let maxBytes =
        (params["maxBytes"] as? NSNumber)?.intValue
        ?? 8 * 1024 * 1024
      let maxDimension =
        (params["maxDimension"] as? NSNumber)?.intValue
        ?? 2_560
      guard
        pid > 0,
        windowId > 0,
        maxBytes >= 1_000,
        maxBytes <= 50 * 1024 * 1024,
        maxDimension >= 64,
        maxDimension <= 8_192
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "截图参数超出允许范围",
          to: clientDescriptor
        )
        return true
      }
      guard let screenshot else {
        sendError(
          id: id,
          code: "screenshot_unavailable",
          message: "当前 Helper 未接入截图",
          to: clientDescriptor
        )
        return true
      }
      do {
        let result = try screenshot(pid, windowId, maxBytes, maxDimension)
        return sendResult(id: id, result: result, to: clientDescriptor)
      } catch let error as HelperOperationError {
        sendError(
          id: id,
          code: error.code,
          message: error.message,
          to: clientDescriptor
        )
        return true
      } catch {
        sendError(
          id: id,
          code: "capture_failed",
          message: "截图失败：\(error)",
          to: clientDescriptor
        )
        return true
      }
    case "input.click":
      guard
        let params = object["params"] as? [String: Any],
        let pid = integer(params["pid"]),
        pid > 0,
        let x = number(params["x"]),
        let y = number(params["y"])
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "input.click 需要 pid、x、y",
          to: clientDescriptor
        )
        return true
      }
      guard let input else {
        sendError(
          id: id,
          code: "input_unavailable",
          message: "当前 Helper 未接入输入",
          to: clientDescriptor
        )
        return true
      }
      let button = (params["button"] as? String) ?? "left"
      let clickCount = integer(params["clickCount"]) ?? 1
      guard
        ["left", "right", "middle"].contains(button),
        (1...3).contains(clickCount)
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "点击按钮或次数不合法",
          to: clientDescriptor
        )
        return true
      }
      return sendOperation(
        id: id,
        to: clientDescriptor,
        operation: {
          try input.click(
            pid: pid,
            x: x,
            y: y,
            button: button,
            clickCount: clickCount
          )
        }
      )
    case "input.type":
      guard
        let params = object["params"] as? [String: Any],
        let pid = integer(params["pid"]),
        pid > 0,
        let text = params["text"] as? String,
        !text.isEmpty,
        text.utf16.count <= 100_000
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "input.type 需要 pid 与非空文本",
          to: clientDescriptor
        )
        return true
      }
      guard let input else {
        sendError(
          id: id,
          code: "input_unavailable",
          message: "当前 Helper 未接入输入",
          to: clientDescriptor
        )
        return true
      }
      let delayMs = integer(params["delayMs"]) ?? 0
      guard (0...1_000).contains(delayMs) else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "输入间隔超出允许范围",
          to: clientDescriptor
        )
        return true
      }
      return sendOperation(
        id: id,
        to: clientDescriptor,
        operation: {
          try input.typeText(pid: pid, text: text, delayMs: delayMs)
        }
      )
    case "input.key":
      guard
        let params = object["params"] as? [String: Any],
        let pid = integer(params["pid"]),
        pid > 0,
        let key = params["key"] as? String,
        !key.isEmpty
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "input.key 需要 pid 与按键名",
          to: clientDescriptor
        )
        return true
      }
      guard let input else {
        sendError(
          id: id,
          code: "input_unavailable",
          message: "当前 Helper 未接入输入",
          to: clientDescriptor
        )
        return true
      }
      let modifiers = (params["modifiers"] as? [String]) ?? []
      let repeatCount = integer(params["repeat"]) ?? 1
      let allowedModifiers = ["cmd", "shift", "option", "control"]
      guard
        modifiers.allSatisfy(allowedModifiers.contains),
        (1...20).contains(repeatCount)
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "修饰键或重复次数不合法",
          to: clientDescriptor
        )
        return true
      }
      return sendOperation(
        id: id,
        to: clientDescriptor,
        operation: {
          try input.key(
            pid: pid,
            key: key,
            modifiers: modifiers,
            repeatCount: repeatCount
          )
        }
      )
    case "input.scroll":
      guard
        let params = object["params"] as? [String: Any],
        let pid = integer(params["pid"]),
        pid > 0,
        let deltaX = number(params["deltaX"]),
        let deltaY = number(params["deltaY"])
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "input.scroll 需要 pid 与滚动量",
          to: clientDescriptor
        )
        return true
      }
      guard let input else {
        sendError(
          id: id,
          code: "input_unavailable",
          message: "当前 Helper 未接入输入",
          to: clientDescriptor
        )
        return true
      }
      let unit = (params["unit"] as? String) ?? "pixel"
      guard ["pixel", "line"].contains(unit) else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "滚动单位不合法",
          to: clientDescriptor
        )
        return true
      }
      return sendOperation(
        id: id,
        to: clientDescriptor,
        operation: {
          try input.scroll(
            pid: pid,
            x: number(params["x"]),
            y: number(params["y"]),
            deltaX: deltaX,
            deltaY: deltaY,
            unit: unit
          )
        }
      )
    case "input.drag":
      guard
        let params = object["params"] as? [String: Any],
        let pid = integer(params["pid"]),
        pid > 0,
        let fromX = number(params["fromX"]),
        let fromY = number(params["fromY"]),
        let toX = number(params["toX"]),
        let toY = number(params["toY"])
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "input.drag 需要起点与终点",
          to: clientDescriptor
        )
        return true
      }
      guard let input else {
        sendError(
          id: id,
          code: "input_unavailable",
          message: "当前 Helper 未接入输入",
          to: clientDescriptor
        )
        return true
      }
      let durationMs = integer(params["durationMs"]) ?? 300
      guard (1...10_000).contains(durationMs) else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "拖拽时长超出允许范围",
          to: clientDescriptor
        )
        return true
      }
      return sendOperation(
        id: id,
        to: clientDescriptor,
        operation: {
          try input.drag(
            pid: pid,
            fromX: fromX,
            fromY: fromY,
            toX: toX,
            toY: toY,
            durationMs: durationMs
          )
        }
      )
    case "clipboard.read":
      guard let input else {
        sendError(
          id: id,
          code: "input_unavailable",
          message: "当前 Helper 未接入剪贴板",
          to: clientDescriptor
        )
        return true
      }
      return sendResult(
        id: id,
        result: input.readClipboard(),
        to: clientDescriptor
      )
    case "clipboard.write":
      guard
        let params = object["params"] as? [String: Any],
        let text = params["text"] as? String,
        text.utf16.count <= 1_000_000
      else {
        sendError(
          id: id,
          code: "invalid_request",
          message: "clipboard.write 需要文本",
          to: clientDescriptor
        )
        return true
      }
      guard let input else {
        sendError(
          id: id,
          code: "input_unavailable",
          message: "当前 Helper 未接入剪贴板",
          to: clientDescriptor
        )
        return true
      }
      return sendResult(
        id: id,
        result: input.writeClipboard(text: text),
        to: clientDescriptor
      )
    case "broker_info":
      return sendSuccess(
        id: id,
        result: [
          "bundleId": configuration.helperBundleId,
          "pid": Int(ProcessInfo.processInfo.processIdentifier),
          "version": configuration.helperVersion,
          "teamIdentifier": configuration.teamIdentifier as Any,
        ],
        to: clientDescriptor
      )
    case "helper.shutdown":
      _ = sendSuccess(id: id, result: ["ok": true], to: clientDescriptor)
      stop()
      onShutdown?()
      return false
    default:
      sendError(
        id: id,
        code: "method_not_found",
        message: "未知的 Helper 方法：\(method)",
        to: clientDescriptor
      )
      return true
    }
  }

  private func jsonObject<T: Encodable>(_ value: T) throws -> Any {
    let data = try JSONEncoder().encode(value)
    return try JSONSerialization.jsonObject(with: data)
  }

  private func sendOperation<T: Encodable>(
    id: String,
    to clientDescriptor: Int32,
    operation: () throws -> T
  ) -> Bool {
    do {
      return sendResult(
        id: id,
        result: try operation(),
        to: clientDescriptor
      )
    } catch let error as HelperOperationError {
      sendError(
        id: id,
        code: error.code,
        message: error.message,
        to: clientDescriptor
      )
      return true
    } catch {
      sendError(
        id: id,
        code: "input_failed",
        message: "输入操作失败：\(error)",
        to: clientDescriptor
      )
      return true
    }
  }

  private func number(_ value: Any?) -> Double? {
    (value as? NSNumber)?.doubleValue
  }

  private func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber else { return nil }
    return number.intValue
  }

  private func sendResult<T: Encodable>(
    id: String,
    result: T,
    to clientDescriptor: Int32
  ) -> Bool {
    do {
      return sendSuccess(
        id: id,
        result: try jsonObject(result),
        to: clientDescriptor
      )
    } catch {
      sendError(
        id: id,
        code: "helper_internal_error",
        message: "响应编码失败：\(error)",
        to: clientDescriptor
      )
      return true
    }
  }

  private func sendSuccess(
    id: String,
    result: Any,
    to clientDescriptor: Int32
  ) -> Bool {
    send(
      [
        "id": id,
        "ok": true,
        "result": result,
      ],
      to: clientDescriptor
    )
  }

  private func sendError(
    id: String,
    code: String,
    message: String,
    to clientDescriptor: Int32
  ) {
    _ = send(
      [
        "id": id,
        "ok": false,
        "error": [
          "code": code,
          "message": message,
        ],
      ],
      to: clientDescriptor
    )
  }

  private func send(_ object: [String: Any], to clientDescriptor: Int32) -> Bool {
    guard
      var data = try? JSONSerialization.data(withJSONObject: object)
    else {
      return false
    }
    data.append(0x0A)
    return data.withUnsafeBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        let written = write(
          clientDescriptor,
          buffer.baseAddress!.advanced(by: offset),
          buffer.count - offset
        )
        if written <= 0 { return false }
        offset += written
      }
      return true
    }
  }
}
