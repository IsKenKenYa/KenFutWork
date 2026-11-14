import Foundation

public enum ComputerUseHelperProtocol {
  public static let version = 1
}

public struct ComputerUseHelperHelloPermissions: Codable, Equatable, Sendable {
  public let accessibility: ComputerUseHelperPermissionState
  public let screenRecording: ComputerUseHelperScreenRecordingState

  public init(
    accessibility: ComputerUseHelperPermissionState,
    screenRecording: ComputerUseHelperScreenRecordingState
  ) {
    self.accessibility = accessibility
    self.screenRecording = screenRecording
  }
}

public struct ComputerUseHelperHelloResult: Codable, Equatable, Sendable {
  public let protocolVersion: Int
  public let helperVersion: String
  public let bundleId: String
  public let pid: Int
  public let teamIdentifier: String?
  public let permissions: ComputerUseHelperHelloPermissions

  private enum CodingKeys: String, CodingKey {
    case protocolVersion
    case helperVersion
    case bundleId
    case pid
    case teamIdentifier
    case permissions
  }

  public init(
    protocolVersion: Int,
    helperVersion: String,
    bundleId: String,
    pid: Int,
    teamIdentifier: String?,
    permissions: ComputerUseHelperHelloPermissions
  ) {
    self.protocolVersion = protocolVersion
    self.helperVersion = helperVersion
    self.bundleId = bundleId
    self.pid = pid
    self.teamIdentifier = teamIdentifier
    self.permissions = permissions
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
    guard protocolVersion == ComputerUseHelperProtocol.version else {
      throw ComputerUseHelperProtocolError.unsupportedProtocolVersion(
        protocolVersion
      )
    }
    let pid = try container.decode(Int.self, forKey: .pid)
    guard pid > 0 else {
      throw ComputerUseHelperProtocolError.invalidPermissionStatus(
        "Helper pid 必须是正整数"
      )
    }

    self.init(
      protocolVersion: protocolVersion,
      helperVersion: try container.decode(
        String.self,
        forKey: .helperVersion
      ),
      bundleId: try container.decode(String.self, forKey: .bundleId),
      pid: pid,
      teamIdentifier: try container.decodeIfPresent(
        String.self,
        forKey: .teamIdentifier
      ),
      permissions: try container.decode(
        ComputerUseHelperHelloPermissions.self,
        forKey: .permissions
      )
    )
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(protocolVersion, forKey: .protocolVersion)
    try container.encode(helperVersion, forKey: .helperVersion)
    try container.encode(bundleId, forKey: .bundleId)
    try container.encode(pid, forKey: .pid)
    if let teamIdentifier {
      try container.encode(teamIdentifier, forKey: .teamIdentifier)
    } else {
      try container.encodeNil(forKey: .teamIdentifier)
    }
    try container.encode(permissions, forKey: .permissions)
  }
}
