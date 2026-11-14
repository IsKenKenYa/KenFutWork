import Foundation

public struct ComputerUseHelperPoint: Codable, Equatable, Sendable {
  public let x: Double
  public let y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

public struct ComputerUseHelperSize: Codable, Equatable, Sendable {
  public let width: Double
  public let height: Double

  public init(width: Double, height: Double) {
    self.width = width
    self.height = height
  }
}

public struct ComputerUseHelperBounds: Codable, Equatable, Sendable {
  public let x: Double
  public let y: Double
  public let width: Double
  public let height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }
}

public struct ComputerUseHelperApplication: Codable, Equatable, Sendable {
  public let pid: Int
  public let name: String
  public let bundleId: String?
  public let path: String?
  public let active: Bool
  public let hidden: Bool

  public init(
    pid: Int,
    name: String,
    bundleId: String?,
    path: String?,
    active: Bool,
    hidden: Bool
  ) {
    self.pid = pid
    self.name = name
    self.bundleId = bundleId
    self.path = path
    self.active = active
    self.hidden = hidden
  }

  private enum CodingKeys: String, CodingKey {
    case pid
    case name
    case bundleId
    case path
    case active
    case hidden
  }

  /// 协议要求 bundleId / path 为显式 null；合成编码会直接省略 nil 键。
  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(pid, forKey: .pid)
    try container.encode(name, forKey: .name)
    if let bundleId {
      try container.encode(bundleId, forKey: .bundleId)
    } else {
      try container.encodeNil(forKey: .bundleId)
    }
    if let path {
      try container.encode(path, forKey: .path)
    } else {
      try container.encodeNil(forKey: .path)
    }
    try container.encode(active, forKey: .active)
    try container.encode(hidden, forKey: .hidden)
  }
}

public struct ComputerUseHelperApplicationsResult: Codable, Equatable, Sendable {
  public let applications: [ComputerUseHelperApplication]

  public init(applications: [ComputerUseHelperApplication]) {
    self.applications = applications
  }
}

public struct ComputerUseHelperWindow: Codable, Equatable, Sendable {
  public let windowId: Int
  public let pid: Int
  public let title: String
  public let layer: Int
  public let onScreen: Bool
  public let bounds: ComputerUseHelperBounds

  public init(
    windowId: Int,
    pid: Int,
    title: String,
    layer: Int,
    onScreen: Bool,
    bounds: ComputerUseHelperBounds
  ) {
    self.windowId = windowId
    self.pid = pid
    self.title = title
    self.layer = layer
    self.onScreen = onScreen
    self.bounds = bounds
  }
}

public struct ComputerUseHelperWindowsResult: Codable, Equatable, Sendable {
  public let windows: [ComputerUseHelperWindow]

  public init(windows: [ComputerUseHelperWindow]) {
    self.windows = windows
  }
}

public struct ComputerUseHelperDisplay: Codable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let bounds: ComputerUseHelperBounds
  public let scaleFactor: Double
  public let primary: Bool

  public init(
    id: String,
    name: String,
    bounds: ComputerUseHelperBounds,
    scaleFactor: Double,
    primary: Bool
  ) {
    self.id = id
    self.name = name
    self.bounds = bounds
    self.scaleFactor = scaleFactor
    self.primary = primary
  }
}

public struct ComputerUseHelperDisplaysResult: Codable, Equatable, Sendable {
  public let displays: [ComputerUseHelperDisplay]

  public init(displays: [ComputerUseHelperDisplay]) {
    self.displays = displays
  }
}

/// AX 节点只保留模型真正需要的字段；安全输入框的 value 在采集阶段就被清空。
public struct ComputerUseHelperAxNode: Codable, Equatable, Sendable {
  public let role: String
  public let subrole: String?
  public let title: String?
  public let value: String?
  public let description: String?
  public let identifier: String?
  public let enabled: Bool?
  public let focused: Bool?
  public let position: ComputerUseHelperPoint?
  public let size: ComputerUseHelperSize?
  public let actions: [String]?
  public let children: [ComputerUseHelperAxNode]?

  public init(
    role: String,
    subrole: String? = nil,
    title: String? = nil,
    value: String? = nil,
    description: String? = nil,
    identifier: String? = nil,
    enabled: Bool? = nil,
    focused: Bool? = nil,
    position: ComputerUseHelperPoint? = nil,
    size: ComputerUseHelperSize? = nil,
    actions: [String]? = nil,
    children: [ComputerUseHelperAxNode]? = nil
  ) {
    self.role = role
    self.subrole = subrole
    self.title = title
    self.value = value
    self.description = description
    self.identifier = identifier
    self.enabled = enabled
    self.focused = focused
    self.position = position
    self.size = size
    self.actions = actions
    self.children = children
  }
}

public struct ComputerUseHelperAxTreeLimits: Equatable, Sendable {
  public let maxDepth: Int
  public let maxChildren: Int
  public let maxNodes: Int
  public let titleMaxChars: Int
  public let valueMaxChars: Int
  public let maxActions: Int
  public let timeoutMs: Int

  public init(
    maxDepth: Int = 8,
    maxChildren: Int = 40,
    maxNodes: Int = 600,
    titleMaxChars: Int = 120,
    valueMaxChars: Int = 400,
    maxActions: Int = 20,
    timeoutMs: Int = 2_000
  ) {
    self.maxDepth = Self.clamp(maxDepth, 1, 64)
    self.maxChildren = Self.clamp(maxChildren, 1, 1_000)
    self.maxNodes = Self.clamp(maxNodes, 1, 10_000)
    self.titleMaxChars = Self.clamp(titleMaxChars, 1, 500)
    self.valueMaxChars = Self.clamp(valueMaxChars, 1, 10_000)
    self.maxActions = Self.clamp(maxActions, 1, 100)
    self.timeoutMs = Self.clamp(timeoutMs, 100, 10_000)
  }

  public init(json: [String: Any]) {
    self.init(
      maxDepth: Self.integer(json["maxDepth"]) ?? 8,
      maxChildren: Self.integer(json["maxChildren"]) ?? 40,
      maxNodes: Self.integer(json["maxNodes"]) ?? 600,
      titleMaxChars: Self.integer(json["titleMaxChars"]) ?? 120,
      valueMaxChars: Self.integer(json["valueMaxChars"]) ?? 400,
      maxActions: Self.integer(json["maxActions"]) ?? 20,
      timeoutMs: Self.integer(json["timeoutMs"]) ?? 2_000
    )
  }

  static func clamp(_ value: Int, _ lower: Int, _ upper: Int) -> Int {
    min(max(value, lower), upper)
  }

  static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double.rounded() == double else { return nil }
    return number.intValue
  }
}

public struct ComputerUseHelperAxTreeResult: Codable, Equatable, Sendable {
  public let pid: Int
  public let root: ComputerUseHelperAxNode
  public let nodeCount: Int
  public let truncated: Bool

  public init(
    pid: Int,
    root: ComputerUseHelperAxNode,
    nodeCount: Int,
    truncated: Bool
  ) {
    self.pid = pid
    self.root = root
    self.nodeCount = nodeCount
    self.truncated = truncated
  }
}

public struct ComputerUseHelperScreenshotResult: Codable, Equatable, Sendable {
  public let pid: Int
  public let windowId: Int
  public let frame: ComputerUseHelperBounds
  public let width: Int
  public let height: Int
  public let format: String
  public let imageBase64: String
  public let blackFrame: Bool
  public let capturedAt: String

  public init(
    pid: Int,
    windowId: Int,
    frame: ComputerUseHelperBounds,
    width: Int,
    height: Int,
    format: String = "png",
    imageBase64: String,
    blackFrame: Bool,
    capturedAt: String
  ) {
    self.pid = pid
    self.windowId = windowId
    self.frame = frame
    self.width = width
    self.height = height
    self.format = format
    self.imageBase64 = imageBase64
    self.blackFrame = blackFrame
    self.capturedAt = capturedAt
  }
}

public struct ComputerUseHelperActionResult: Codable, Equatable, Sendable {
  public let performed: Bool

  public init(performed: Bool) {
    self.performed = performed
  }
}

public struct ComputerUseHelperClipboardReadResult: Codable, Equatable,
  Sendable
{
  public let text: String

  public init(text: String) {
    self.text = text
  }
}

public struct ComputerUseHelperClipboardWriteResult: Codable, Equatable,
  Sendable
{
  public let written: Bool

  public init(written: Bool) {
    self.written = written
  }
}

public struct HelperOperationError: Error, Equatable, Sendable {
  public let code: String
  public let message: String

  public init(code: String, message: String) {
    self.code = code
    self.message = message
  }
}
