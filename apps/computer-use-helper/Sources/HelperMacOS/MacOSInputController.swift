import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import HelperProtocol

public struct MacOSInputController: HelperInputProviding {
  public init() {}

  /// 所有键盘与鼠标注入都要求辅助功能；没有授权时在动作发出前失败关闭。
  private func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
      throw HelperOperationError(
        code: "permission_denied",
        message: "辅助功能未授权，无法发送输入事件"
      )
    }
  }

  private func activate(pid: Int) throws {
    guard
      let application = NSRunningApplication(
        processIdentifier: pid_t(pid)
      )
    else {
      throw HelperOperationError(
        code: "application_not_found",
        message: "目标应用不存在"
      )
    }
    if #available(macOS 14.0, *) {
      application.activate()
    } else {
      application.activate(options: [.activateIgnoringOtherApps])
    }
    usleep(50_000)
  }

  private func source() -> CGEventSource? {
    CGEventSource(stateID: .hidSystemState)
  }

  public func click(
    pid: Int,
    x: Double,
    y: Double,
    button: String,
    clickCount: Int
  ) throws -> ComputerUseHelperActionResult {
    try requireAccessibility()
    try activate(pid: pid)
    let point = CGPoint(x: x, y: y)
    let mouseButton: CGMouseButton
    let downType: CGEventType
    let upType: CGEventType
    switch button {
    case "right":
      mouseButton = .right
      downType = .rightMouseDown
      upType = .rightMouseUp
    case "middle":
      mouseButton = .center
      downType = .otherMouseDown
      upType = .otherMouseUp
    default:
      mouseButton = .left
      downType = .leftMouseDown
      upType = .leftMouseUp
    }
    let eventSource = source()
    CGEvent(
      mouseEventSource: eventSource,
      mouseType: .mouseMoved,
      mouseCursorPosition: point,
      mouseButton: mouseButton
    )?.post(tap: .cghidEventTap)
    for count in 1...max(1, clickCount) {
      for type in [downType, upType] {
        guard
          let event = CGEvent(
            mouseEventSource: eventSource,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: mouseButton
          )
        else { continue }
        event.setIntegerValueField(
          .mouseEventClickState,
          value: Int64(count)
        )
        event.post(tap: .cghidEventTap)
      }
    }
    return ComputerUseHelperActionResult(performed: true)
  }

  public func typeText(pid: Int, text: String, delayMs: Int) throws
    -> ComputerUseHelperActionResult
  {
    try requireAccessibility()
    try activate(pid: pid)
    var buffer: [UniChar] = []
    for character in text.utf16 {
      if character == 10 || character == 13 {
        flush(&buffer)
        pressKey(keyCode: 36, flags: [], repeatCount: 1)
        delay(delayMs)
      } else if character == 9 {
        flush(&buffer)
        pressKey(keyCode: 48, flags: [], repeatCount: 1)
        delay(delayMs)
      } else {
        buffer.append(character)
      }
    }
    flush(&buffer)
    return ComputerUseHelperActionResult(performed: true)
  }

  public func key(
    pid: Int,
    key: String,
    modifiers: [String],
    repeatCount: Int
  ) throws -> ComputerUseHelperActionResult {
    let normalized = key.lowercased()
    guard let keyCode = Self.keyCode(for: normalized) else {
      throw HelperOperationError(
        code: "invalid_request",
        message: "不支持的按键：\(key)"
      )
    }
    try requireAccessibility()
    try activate(pid: pid)
    var flags: CGEventFlags = []
    for modifier in modifiers {
      switch modifier {
      case "cmd": flags.insert(.maskCommand)
      case "shift": flags.insert(.maskShift)
      case "option": flags.insert(.maskAlternate)
      case "control": flags.insert(.maskControl)
      default: break
      }
    }
    pressKey(
      keyCode: keyCode,
      flags: flags,
      repeatCount: repeatCount
    )
    return ComputerUseHelperActionResult(performed: true)
  }

  public func scroll(
    pid: Int,
    x: Double?,
    y: Double?,
    deltaX: Double,
    deltaY: Double,
    unit: String
  ) throws -> ComputerUseHelperActionResult {
    try requireAccessibility()
    try activate(pid: pid)
    if let x, let y {
      CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
    }
    let units: CGScrollEventUnit = unit == "line" ? .line : .pixel
    guard
      let event = CGEvent(
        scrollWheelEvent2Source: source(),
        units: units,
        wheelCount: 2,
        wheel1: Int32(clamping: Int(deltaY.rounded())),
        wheel2: Int32(clamping: Int(deltaX.rounded())),
        wheel3: 0
      )
    else {
      throw HelperOperationError(
        code: "input_unavailable",
        message: "无法创建滚动事件"
      )
    }
    event.post(tap: .cghidEventTap)
    return ComputerUseHelperActionResult(performed: true)
  }

  public func drag(
    pid: Int,
    fromX: Double,
    fromY: Double,
    toX: Double,
    toY: Double,
    durationMs: Int
  ) throws -> ComputerUseHelperActionResult {
    try requireAccessibility()
    try activate(pid: pid)
    let start = CGPoint(x: fromX, y: fromY)
    let end = CGPoint(x: toX, y: toY)
    let eventSource = source()
    guard
      let down = CGEvent(
        mouseEventSource: eventSource,
        mouseType: .leftMouseDown,
        mouseCursorPosition: start,
        mouseButton: .left
      )
    else {
      throw HelperOperationError(
        code: "input_unavailable",
        message: "无法创建拖拽事件"
      )
    }
    down.setIntegerValueField(.mouseEventClickState, value: 1)
    down.post(tap: .cghidEventTap)
    let steps = 12
    let interval = max(1, durationMs / steps)
    for index in 1...steps {
      let progress = Double(index) / Double(steps)
      let point = CGPoint(
        x: start.x + (end.x - start.x) * progress,
        y: start.y + (end.y - start.y) * progress
      )
      CGEvent(
        mouseEventSource: eventSource,
        mouseType: .leftMouseDragged,
        mouseCursorPosition: point,
        mouseButton: .left
      )?.post(tap: .cghidEventTap)
      usleep(useconds_t(interval * 1_000))
    }
    CGEvent(
      mouseEventSource: eventSource,
      mouseType: .leftMouseUp,
      mouseCursorPosition: end,
      mouseButton: .left
    )?.post(tap: .cghidEventTap)
    return ComputerUseHelperActionResult(performed: true)
  }

  public func readClipboard() -> ComputerUseHelperClipboardReadResult {
    ComputerUseHelperClipboardReadResult(
      text: NSPasteboard.general.string(forType: .string) ?? ""
    )
  }

  public func writeClipboard(
    text: String
  ) -> ComputerUseHelperClipboardWriteResult {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    return ComputerUseHelperClipboardWriteResult(
      written: pasteboard.setString(text, forType: .string)
    )
  }

  private func flush(_ buffer: inout [UniChar]) {
    guard !buffer.isEmpty else { return }
    let characters = buffer
    buffer.removeAll(keepingCapacity: true)
    guard
      let down = CGEvent(
        keyboardEventSource: source(),
        virtualKey: 0,
        keyDown: true
      ),
      let up = CGEvent(
        keyboardEventSource: source(),
        virtualKey: 0,
        keyDown: false
      )
    else { return }
    for event in [down, up] {
      characters.withUnsafeBufferPointer { pointer in
        guard let base = pointer.baseAddress else { return }
        event.keyboardSetUnicodeString(
          stringLength: characters.count,
          unicodeString: base
        )
      }
      event.post(tap: .cghidEventTap)
    }
    usleep(5_000)
  }

  private func pressKey(
    keyCode: CGKeyCode,
    flags: CGEventFlags,
    repeatCount: Int
  ) {
    for _ in 0..<max(1, repeatCount) {
      let down = CGEvent(
        keyboardEventSource: source(),
        virtualKey: keyCode,
        keyDown: true
      )
      let up = CGEvent(
        keyboardEventSource: source(),
        virtualKey: keyCode,
        keyDown: false
      )
      down?.flags = flags
      up?.flags = flags
      down?.post(tap: .cghidEventTap)
      up?.post(tap: .cghidEventTap)
      usleep(20_000)
    }
  }

  private func delay(_ milliseconds: Int) {
    guard milliseconds > 0 else { return }
    usleep(useconds_t(milliseconds * 1_000))
  }

  static func keyCode(for key: String) -> CGKeyCode? {
    keyCodes[key.lowercased()]
  }

  private static let keyCodes: [String: CGKeyCode] = [
    "a": 0,
    "s": 1,
    "d": 2,
    "f": 3,
    "h": 4,
    "g": 5,
    "z": 6,
    "x": 7,
    "c": 8,
    "v": 9,
    "b": 11,
    "q": 12,
    "w": 13,
    "e": 14,
    "r": 15,
    "y": 16,
    "t": 17,
    "1": 18,
    "2": 19,
    "3": 20,
    "4": 21,
    "6": 22,
    "5": 23,
    "=": 24,
    "equal": 24,
    "9": 25,
    "7": 26,
    "-": 27,
    "minus": 27,
    "8": 28,
    "0": 29,
    "]": 30,
    "rightbracket": 30,
    "o": 31,
    "u": 32,
    "[": 33,
    "leftbracket": 33,
    "i": 34,
    "p": 35,
    "l": 37,
    "j": 38,
    "'": 39,
    "quote": 39,
    "k": 40,
    ";": 41,
    "semicolon": 41,
    "\\": 42,
    "backslash": 42,
    ",": 43,
    "comma": 43,
    "/": 44,
    "slash": 44,
    "n": 45,
    "m": 46,
    ".": 47,
    "period": 47,
    "`": 50,
    "backtick": 50,
    "return": 36,
    "enter": 36,
    "tab": 48,
    "space": 49,
    "delete": 51,
    "backspace": 51,
    "escape": 53,
    "esc": 53,
    "forwarddelete": 117,
    "left": 123,
    "right": 124,
    "down": 125,
    "up": 126,
    "home": 115,
    "end": 119,
    "pageup": 116,
    "pagedown": 121,
    "f1": 122,
    "f2": 120,
    "f3": 99,
    "f4": 118,
    "f5": 96,
    "f6": 97,
    "f7": 98,
    "f8": 100,
    "f9": 101,
    "f10": 109,
    "f11": 103,
    "f12": 111,
  ]
}
