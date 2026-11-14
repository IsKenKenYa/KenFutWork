public enum HelperPermissionRequestKind: String, Codable, Sendable {
  case accessibility
  case screenRecording = "screen_recording"
}

public struct HelperPermissionRequestResult: Equatable, Sendable {
  public let requested: Bool
  public let granted: Bool?
  public let reason: String?

  public init(requested: Bool, granted: Bool?, reason: String?) {
    self.requested = requested
    self.granted = granted
    self.reason = reason
  }
}
