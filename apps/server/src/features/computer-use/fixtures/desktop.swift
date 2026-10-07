// 第一方验收窗口：只记录本窗口事件，避免真实应用和私有内容进入测试证据。
import AppKit

final class ProbeView: NSView {
  var label = NSTextField(labelWithString: "点击数：0")
  var count = 0
  override var acceptsFirstResponder: Bool { true }
  override init(frame: NSRect) {
    super.init(frame: frame)
    let button = NSButton(title: "验收按钮", target: self, action: #selector(clicked))
    button.frame = NSRect(x: 40, y: 200, width: 150, height: 40)
    addSubview(button)
    label.frame = NSRect(x: 40, y: 160, width: 200, height: 24)
    addSubview(label)
    let field = NSTextField(frame: NSRect(x: 40, y: 100, width: 260, height: 30))
    field.placeholderString = "验收输入"
    field.setAccessibilityIdentifier("验收输入")
    addSubview(field)
  }
  required init?(coder: NSCoder) { fatalError() }
  @objc func clicked() { count += 1; label.stringValue = "点击数：\(count)"; emit("click", count) }
  override func mouseMoved(with event: NSEvent) { emit("move", Int(event.locationInWindow.x)) }
  override func mouseDragged(with event: NSEvent) { emit("drag", Int(event.locationInWindow.x)) }
  override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self); emit("down", event.clickCount) }
  override func mouseUp(with event: NSEvent) { emit("up", event.clickCount) }
  override func rightMouseDown(with event: NSEvent) { emit("right", event.clickCount) }
  override func scrollWheel(with event: NSEvent) { emit("scroll", Int(event.scrollingDeltaY)) }
  override func keyDown(with event: NSEvent) { emit("key", Int(event.keyCode)) }
  func emit(_ name: String, _ value: Int) { print("EVENT \(name) \(value)"); fflush(stdout) }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let menu = NSMenu()
menu.addItem(NSMenuItem(title: "验收", action: nil, keyEquivalent: ""))
let edit = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
edit.submenu = NSMenu(title: "编辑")
edit.submenu!.addItem(NSMenuItem(title: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
menu.addItem(edit)
app.mainMenu = menu
let frame = NSRect(x: 150, y: 150, width: 420, height: 300)
let window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
window.title = "KenFutWork 桌面能力验收"
window.contentView = ProbeView(frame: NSRect(origin: .zero, size: frame.size))
window.acceptsMouseMovedEvents = true
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
window.isReleasedWhenClosed = false
let inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { event in
  if event.type == .flagsChanged {
    print("SHIFT \(event.modifierFlags.contains(.shift) ? 1 : 0)")
  } else {
    let responder = window.firstResponder.map { String(describing: type(of: $0)) } ?? "none"
    let clipboardBytes = NSPasteboard.general.string(forType: .string)?.utf8.count ?? 0
    print("KEY \(event.keyCode) CMD \(event.modifierFlags.contains(.command) ? 1 : 0) FOCUS \(responder) CLIPBOARD_BYTES \(clipboardBytes)")
  }
  fflush(stdout)
  return event
}
var extraWindows: [NSWindow] = []
DispatchQueue.global().async {
  while let command = readLine() {
    DispatchQueue.main.async {
      if command == "second" {
        let second = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        second.setFrame(window.frame, display: true)
        second.title = "KenFutWork 第二窗口"
        second.contentView = ProbeView(frame: NSRect(origin: .zero, size: frame.size))
        second.isReleasedWhenClosed = false
        extraWindows.append(second)
        second.makeKeyAndOrderFront(nil)
      } else if command == "close-main" {
        window.close()
      } else if command == "rename-main-button" {
        window.contentView?.subviews.compactMap { $0 as? NSButton }.first?.title = "变更后的按钮"
      }
      print("COMMAND \(command)"); fflush(stdout)
    }
  }
}
DispatchQueue.main.async {
  print("READY \(ProcessInfo.processInfo.processIdentifier)"); fflush(stdout)
}
app.run()
