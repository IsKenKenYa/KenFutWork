public enum HelperPermissionState: String, Equatable, Sendable {
  case unknown
  case checking
  case denied
  case granted
  case stale
}

public enum HelperPermissionEvent: Equatable, Sendable {
  case checkStarted
  case checkFinished(granted: Bool)
  case userGranted
  case revoked
  case staleDetected
}

public enum HelperPermissionReducer {
  public static func reduce(
    _ state: HelperPermissionState,
    _ event: HelperPermissionEvent
  ) -> HelperPermissionState {
    switch event {
    case .checkStarted:
      return .checking
    case .checkFinished(let granted):
      return granted ? .granted : .denied
    case .userGranted:
      return .granted
    case .revoked:
      return state == .unknown ? .unknown : .denied
    case .staleDetected:
      return state == .granted ? .stale : state
    }
  }
}
