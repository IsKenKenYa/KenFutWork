import Foundation

/// Helper 的输入与剪贴板能力；由 macOS 实现，socket 层只做协议解析与错误映射。
public protocol HelperInputProviding {
  func click(
    pid: Int,
    x: Double,
    y: Double,
    button: String,
    clickCount: Int
  ) throws -> ComputerUseHelperActionResult
  func typeText(
    pid: Int,
    text: String,
    delayMs: Int
  ) throws -> ComputerUseHelperActionResult
  func key(
    pid: Int,
    key: String,
    modifiers: [String],
    repeatCount: Int
  ) throws -> ComputerUseHelperActionResult
  func scroll(
    pid: Int,
    x: Double?,
    y: Double?,
    deltaX: Double,
    deltaY: Double,
    unit: String
  ) throws -> ComputerUseHelperActionResult
  func drag(
    pid: Int,
    fromX: Double,
    fromY: Double,
    toX: Double,
    toY: Double,
    durationMs: Int
  ) throws -> ComputerUseHelperActionResult
  func readClipboard() -> ComputerUseHelperClipboardReadResult
  func writeClipboard(text: String) -> ComputerUseHelperClipboardWriteResult
}
