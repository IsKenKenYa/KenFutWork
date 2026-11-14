import AppKit
import HelperProtocol

public enum MacOSDisplayCatalog {
  /// 坐标转换为与窗口/截屏一致的左上原点全局逻辑坐标；主屏高度用于翻转 NSScreen 的右下原点。
  public static func list() -> ComputerUseHelperDisplaysResult {
    let screens = NSScreen.screens
    guard let primary = screens.first else {
      return ComputerUseHelperDisplaysResult(displays: [])
    }
    let primaryHeight = primary.frame.size.height
    let displays = screens.enumerated().map { index, screen in
      let frame = screen.frame
      let id =
        (screen.deviceDescription[
          NSDeviceDescriptionKey("NSScreenNumber")
        ] as? NSNumber)?.stringValue ?? String(index + 1)
      return ComputerUseHelperDisplay(
        id: id,
        name: screen.localizedName.isEmpty
          ? "显示器 \(index + 1)"
          : screen.localizedName,
        bounds: ComputerUseHelperBounds(
          x: frame.origin.x,
          y: primaryHeight - frame.origin.y - frame.size.height,
          width: frame.size.width,
          height: frame.size.height
        ),
        scaleFactor: Double(screen.backingScaleFactor),
        primary: index == 0
      )
    }
    return ComputerUseHelperDisplaysResult(displays: displays)
  }
}
