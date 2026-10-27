import HelperProtocol

public struct HelperPermissionIdentity: Equatable, Sendable {
  public let bundleId: String
  public let path: String
  public let teamIdentifier: String?

  public init(
    bundleId: String,
    path: String,
    teamIdentifier: String?
  ) {
    self.bundleId = bundleId
    self.path = path
    self.teamIdentifier = teamIdentifier
  }
}

public enum HelperPermissionStatusBuilder {
  public static func make(
    identity: HelperPermissionIdentity,
    accessibility: Bool?,
    screenRecording: Bool?,
    accessibilityProbeOk: Bool? = nil,
    screenCaptureProbeOk: Bool? = nil,
    reason: String? = nil
  ) -> ComputerUseHelperPermissionStatus {
    let accessibilityState: ComputerUseHelperPermissionState
    if let accessibility {
      accessibilityState =
        accessibility
        ? (accessibilityProbeOk == false ? .stale : .granted)
        : .denied
    } else {
      accessibilityState = .unknown
    }

    let screenRecordingState: ComputerUseHelperScreenRecordingState
    if let screenRecording {
      // 预检通过但实际抓不到像素：按未授权呈现，让设置页继续引导用户。
      screenRecordingState =
        screenRecording
        ? (screenCaptureProbeOk == false ? .denied : .granted)
        : .denied
    } else {
      screenRecordingState = .unknown
    }

    return ComputerUseHelperPermissionStatus(
      available: true,
      helperBundleId: identity.bundleId,
      helperPath: identity.path,
      teamIdentifier: identity.teamIdentifier,
      accessibility: accessibilityState,
      screenRecording: screenRecordingState,
      accessibilityProbeOk: accessibilityProbeOk,
      screenCaptureProbeOk: screenCaptureProbeOk,
      grantOwner: identity.path,
      reason: reason
    )
  }
}
