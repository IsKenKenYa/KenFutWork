import CoreGraphics
import Foundation
import HelperProtocol
import ImageIO
import UniformTypeIdentifiers

public enum MacOSWindowCapture {
  public static let defaultMaxBytes = 8 * 1024 * 1024
  public static let defaultMaxDimension = 2_560

  /// 截图与窗口帧在同一次 CGWindow 查询里绑定，避免窗口移动后把旧图配到新位置。
  public static func capture(
    pid: Int,
    windowId: Int,
    maxBytes: Int = defaultMaxBytes,
    maxDimension: Int = defaultMaxDimension
  ) throws -> ComputerUseHelperScreenshotResult {
    guard CGPreflightScreenCaptureAccess() else {
      throw HelperOperationError(
        code: "permission_denied",
        message: "屏幕录制未授权，无法截图"
      )
    }
    guard pid > 0, windowId > 0 else {
      throw HelperOperationError(
        code: "invalid_request",
        message: "截图需要合法的进程号与窗口号"
      )
    }
    let bounds = try windowBounds(pid: pid, windowId: windowId)
    guard
      let captured = CGWindowListCreateImage(
        .null,
        .optionIncludingWindow,
        CGWindowID(windowId),
        [.boundsIgnoreFraming, .bestResolution]
      )
    else {
      throw HelperOperationError(
        code: "capture_unavailable",
        message: "窗口当前不可截图，可能已关闭或最小化"
      )
    }

    var image = captured
    let scale = min(
      1,
      Double(maxDimension) / Double(max(image.width, image.height))
    )
    if scale < 1 {
      image = try resize(image, scale: scale)
    }
    var data = try pngData(image)
    while data.count > maxBytes && max(image.width, image.height) > 64 {
      image = try resize(image, scale: 0.8)
      data = try pngData(image)
    }
    guard data.count <= maxBytes else {
      throw HelperOperationError(
        code: "capture_too_large",
        message: "截图超过允许的大小，请缩小窗口后重试"
      )
    }

    return ComputerUseHelperScreenshotResult(
      pid: pid,
      windowId: windowId,
      frame: bounds,
      width: image.width,
      height: image.height,
      imageBase64: data.base64EncodedString(),
      blackFrame: isBlackFrame(image),
      capturedAt: isoTimestamp()
    )
  }

  /// 判断近黑画面：平均亮度与亮度跨度都很小。用于提示模型截图可能尚未渲染。
  public static func isBlackFrame(_ image: CGImage) -> Bool {
    let width = 16
    let height = 16
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    guard
      let context = CGContext(
        data: &pixels,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    else { return false }
    context.interpolationQuality = .medium
    context.draw(
      image,
      in: CGRect(x: 0, y: 0, width: width, height: height)
    )
    var minimum = 255.0
    var maximum = 0.0
    var sum = 0.0
    var count = 0
    for index in stride(from: 0, to: pixels.count, by: 4) {
      let alpha = Double(pixels[index + 3]) / 255
      guard alpha > 0.01 else { continue }
      let red = Double(pixels[index]) * alpha
      let green = Double(pixels[index + 1]) * alpha
      let blue = Double(pixels[index + 2]) * alpha
      let luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
      minimum = min(minimum, luminance)
      maximum = max(maximum, luminance)
      sum += luminance
      count += 1
    }
    guard count > 0 else { return true }
    return sum / Double(count) < 8 && maximum - minimum < 8
  }

  private static func windowBounds(
    pid: Int,
    windowId: Int
  ) throws -> ComputerUseHelperBounds {
    let info =
      CGWindowListCopyWindowInfo(
        .optionIncludingWindow,
        CGWindowID(windowId)
      ) as? [[String: Any]] ?? []
    guard
      let entry = info.first(where: {
        ($0[kCGWindowNumber as String] as? Int) == windowId
      }),
      (entry[kCGWindowOwnerPID as String] as? Int) == pid,
      let bounds = entry[kCGWindowBounds as String] as? [String: Any]
    else {
      throw HelperOperationError(
        code: "window_not_found",
        message: "目标窗口不存在或不属于该应用"
      )
    }
    return ComputerUseHelperBounds(
      x: (bounds["X"] as? NSNumber)?.doubleValue ?? 0,
      y: (bounds["Y"] as? NSNumber)?.doubleValue ?? 0,
      width: (bounds["Width"] as? NSNumber)?.doubleValue ?? 0,
      height: (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
    )
  }

  private static func resize(_ image: CGImage, scale: Double) throws
    -> CGImage
  {
    let width = max(1, Int(Double(image.width) * scale))
    let height = max(1, Int(Double(image.height) * scale))
    guard
      let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    else {
      throw HelperOperationError(
        code: "capture_failed",
        message: "截图缩放失败"
      )
    }
    context.interpolationQuality = .high
    context.draw(
      image,
      in: CGRect(x: 0, y: 0, width: width, height: height)
    )
    guard let resized = context.makeImage() else {
      throw HelperOperationError(
        code: "capture_failed",
        message: "截图缩放失败"
      )
    }
    return resized
  }

  private static func pngData(_ image: CGImage) throws -> Data {
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data,
        UTType.png.identifier as CFString,
        1,
        nil
      )
    else {
      throw HelperOperationError(
        code: "capture_failed",
        message: "截图编码失败"
      )
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
      throw HelperOperationError(
        code: "capture_failed",
        message: "截图编码失败"
      )
    }
    return data as Data
  }

  private static func isoTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
  }
}
