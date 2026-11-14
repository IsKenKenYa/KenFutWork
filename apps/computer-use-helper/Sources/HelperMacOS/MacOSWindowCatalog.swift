import CoreGraphics
import Foundation
import HelperProtocol

public enum MacOSWindowCatalog {
  /// 包含屏幕外窗口（最小化/被遮挡），由 onScreen 标记真实可见性。
  public static func list(pid: Int) -> ComputerUseHelperWindowsResult {
    guard pid > 0 else {
      return ComputerUseHelperWindowsResult(windows: [])
    }
    let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
    guard
      let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID)
        as? [[String: Any]]
    else {
      return ComputerUseHelperWindowsResult(windows: [])
    }
    let pidValue = Int32(pid)
    let windows = raw.compactMap { entry -> ComputerUseHelperWindow? in
      guard
        let ownerPid = entry[kCGWindowOwnerPID as String] as? Int,
        ownerPid == Int(pidValue),
        let windowNumber = entry[kCGWindowNumber as String] as? Int,
        let layer = entry[kCGWindowLayer as String] as? Int,
        let bounds = entry[kCGWindowBounds as String] as? [String: Any]
      else { return nil }
      let width = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
      let height = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
      guard width > 0, height > 0 else { return nil }
      let alpha = (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
      guard alpha > 0 else { return nil }
      let onScreen = (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
      return ComputerUseHelperWindow(
        windowId: windowNumber,
        pid: pid,
        title: (entry[kCGWindowName as String] as? String) ?? "",
        layer: layer,
        onScreen: onScreen,
        bounds: ComputerUseHelperBounds(
          x: (bounds["X"] as? NSNumber)?.doubleValue ?? 0,
          y: (bounds["Y"] as? NSNumber)?.doubleValue ?? 0,
          width: width,
          height: height
        )
      )
    }
    .sorted { left, right in
      if left.layer != right.layer { return left.layer < right.layer }
      return left.windowId < right.windowId
    }
    return ComputerUseHelperWindowsResult(windows: windows)
  }
}
