import ApplicationServices
import CoreGraphics
import HelperCore
import HelperProtocol

public enum MacOSPermissionProbe {
  public static func currentStatus(
    identity: HelperPermissionIdentity,
    probe: Bool = false
  ) -> ComputerUseHelperPermissionStatus {
    let accessibility = AXIsProcessTrusted()
    let screenRecording = CGPreflightScreenCaptureAccess()
    var accessibilityProbeOk: Bool?
    var screenCaptureProbeOk: Bool?
    var reason = "由 Helper 进程读取 macOS 权限状态"
    if probe {
      if accessibility {
        accessibilityProbeOk = probeAccessibility()
      }
      if screenRecording {
        screenCaptureProbeOk = probeScreenCapture()
      }
      if accessibilityProbeOk == false || screenCaptureProbeOk == false {
        reason = "权限预检通过但实际读取失败，请重启 Helper 或重新授权"
      }
    }
    return HelperPermissionStatusBuilder.make(
      identity: identity,
      accessibility: accessibility,
      screenRecording: screenRecording,
      accessibilityProbeOk: accessibilityProbeOk,
      screenCaptureProbeOk: screenCaptureProbeOk,
      reason: reason
    )
  }

  /// 只读查询：能读到当前焦点应用元素说明 AX 通道真的可用，而不只是预检标记。
  static func probeAccessibility() -> Bool {
    let system = AXUIElementCreateSystemWide()
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(
      system,
      kAXFocusedApplicationAttribute as CFString,
      &value
    ) == .success && value != nil
  }

  /// 抓 2x2 像素验证屏幕录制；只在显式 probe 时调用，不在普通状态查询里主动采集。
  static func probeScreenCapture() -> Bool {
    CGWindowListCreateImage(
      CGRect(x: 0, y: 0, width: 2, height: 2),
      .optionOnScreenOnly,
      kCGNullWindowID,
      [.boundsIgnoreFraming, .nominalResolution]
    ) != nil
  }
}
