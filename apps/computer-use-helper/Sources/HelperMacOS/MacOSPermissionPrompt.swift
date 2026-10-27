import ApplicationServices
import CoreGraphics
import HelperProtocol

public enum MacOSPermissionPrompt {
  public static func request(
    _ kind: HelperPermissionRequestKind
  ) -> HelperPermissionRequestResult {
    switch kind {
    case .accessibility:
      let options =
        [
          kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
        ] as CFDictionary
      let granted = AXIsProcessTrustedWithOptions(options)
      return HelperPermissionRequestResult(
        requested: true,
        granted: granted,
        reason: granted ? nil : "请在系统设置中开启辅助功能"
      )
    case .screenRecording:
      if CGPreflightScreenCaptureAccess() {
        return HelperPermissionRequestResult(
          requested: true,
          granted: true,
          reason: nil
        )
      }
      let granted = CGRequestScreenCaptureAccess()
      return HelperPermissionRequestResult(
        requested: true,
        granted: granted,
        reason: granted ? nil : "请在系统设置中允许屏幕录制"
      )
    }
  }
}
