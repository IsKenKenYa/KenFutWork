import Foundation

public enum ComputerUseHelperProtocolError: Error, Equatable, LocalizedError {
  case invalidPermissionStatus(String)
  case unsupportedProtocolVersion(Int)

  public var errorDescription: String? {
    switch self {
    case .invalidPermissionStatus(let reason):
      return "Helper 权限状态无效：\(reason)"
    case .unsupportedProtocolVersion(let version):
      return "不支持的 Helper 协议版本：\(version)"
    }
  }
}

public enum ComputerUseHelperPermissionState: String, Codable, Sendable {
  case granted
  case stale
  case denied
  case unknown
}

public enum ComputerUseHelperScreenRecordingState: String, Codable, Sendable {
  case granted
  case denied
  case unknown
}

public enum ComputerUseHelperAutomationState: String, Codable, Sendable {
  case granted
  case denied
  case unknown
}

public struct ComputerUseHelperPermissionStatus: Codable, Equatable, Sendable {
  public let available: Bool
  public let helperBundleId: String
  public let helperPath: String
  public let teamIdentifier: String?
  public let accessibility: ComputerUseHelperPermissionState
  public let screenRecording: ComputerUseHelperScreenRecordingState
  public let automation: ComputerUseHelperAutomationState?
  public let accessibilityProbeOk: Bool?
  public let screenCaptureProbeOk: Bool?
  public let grantOwner: String?
  public let reason: String?

  private enum CodingKeys: String, CodingKey {
    case available
    case helperBundleId
    case helperPath
    case teamIdentifier
    case accessibility
    case screenRecording
    case automation
    case accessibilityProbeOk
    case screenCaptureProbeOk
    case grantOwner
    case reason
  }

  public init(
    available: Bool,
    helperBundleId: String,
    helperPath: String,
    teamIdentifier: String?,
    accessibility: ComputerUseHelperPermissionState,
    screenRecording: ComputerUseHelperScreenRecordingState,
    automation: ComputerUseHelperAutomationState? = nil,
    accessibilityProbeOk: Bool? = nil,
    screenCaptureProbeOk: Bool? = nil,
    grantOwner: String?,
    reason: String? = nil
  ) {
    self.available = available
    self.helperBundleId = helperBundleId
    self.helperPath = helperPath
    self.teamIdentifier = teamIdentifier
    self.accessibility = accessibility
    self.screenRecording = screenRecording
    self.automation = automation
    self.accessibilityProbeOk = accessibilityProbeOk
    self.screenCaptureProbeOk = screenCaptureProbeOk
    self.grantOwner = grantOwner
    self.reason = reason
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let available = try container.decode(Bool.self, forKey: .available)
    let helperBundleId = try container.decode(
      String.self,
      forKey: .helperBundleId
    )
    let helperPath = try container.decode(String.self, forKey: .helperPath)
    guard helperPath.hasPrefix("/") else {
      throw ComputerUseHelperProtocolError.invalidPermissionStatus(
        "helperPath 必须是绝对路径"
      )
    }

    let grantOwner = try container.decodeIfPresent(
      String.self,
      forKey: .grantOwner
    )
    if let grantOwner,
      grantOwner != helperBundleId,
      grantOwner != helperPath
    {
      throw ComputerUseHelperProtocolError.invalidPermissionStatus(
        "grantOwner 必须指向 Helper 身份"
      )
    }

    self.init(
      available: available,
      helperBundleId: helperBundleId,
      helperPath: helperPath,
      teamIdentifier: try container.decodeIfPresent(
        String.self,
        forKey: .teamIdentifier
      ),
      accessibility: try container.decode(
        ComputerUseHelperPermissionState.self,
        forKey: .accessibility
      ),
      screenRecording: try container.decode(
        ComputerUseHelperScreenRecordingState.self,
        forKey: .screenRecording
      ),
      automation: try container.decodeIfPresent(
        ComputerUseHelperAutomationState.self,
        forKey: .automation
      ),
      accessibilityProbeOk: try container.decodeIfPresent(
        Bool.self,
        forKey: .accessibilityProbeOk
      ),
      screenCaptureProbeOk: try container.decodeIfPresent(
        Bool.self,
        forKey: .screenCaptureProbeOk
      ),
      grantOwner: grantOwner,
      reason: try container.decodeIfPresent(String.self, forKey: .reason)
    )
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(available, forKey: .available)
    try container.encode(helperBundleId, forKey: .helperBundleId)
    try container.encode(helperPath, forKey: .helperPath)
    if let teamIdentifier {
      try container.encode(teamIdentifier, forKey: .teamIdentifier)
    } else {
      try container.encodeNil(forKey: .teamIdentifier)
    }
    try container.encode(accessibility, forKey: .accessibility)
    try container.encode(screenRecording, forKey: .screenRecording)
    try container.encodeIfPresent(automation, forKey: .automation)
    try container.encodeIfPresent(
      accessibilityProbeOk,
      forKey: .accessibilityProbeOk
    )
    try container.encodeIfPresent(
      screenCaptureProbeOk,
      forKey: .screenCaptureProbeOk
    )
    if let grantOwner {
      try container.encode(grantOwner, forKey: .grantOwner)
    } else {
      try container.encodeNil(forKey: .grantOwner)
    }
    try container.encodeIfPresent(reason, forKey: .reason)
  }
}
