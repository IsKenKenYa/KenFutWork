"""只记录第一方GTK测试窗口，供真实X11/AT-SPI公共接口验收。"""
import os
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk

window = Gtk.Window(title="KenFutWork Linux 桌面验收")
window.set_default_size(480, 360)
window.move(150, 150)
layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
window.add(layout)
label = Gtk.Label(label="点击数：0")
button = Gtk.Button(label="验收按钮")
entry = Gtk.Entry()
entry.set_placeholder_text("验收输入")
entry.get_accessible().set_name("验收输入")
counter = 0
def clicked(_):
    global counter
    counter += 1
    label.set_text("点击数：" + str(counter))
    print("EVENT click", counter, flush=True)
button.connect("clicked", clicked)
entry.connect("changed", lambda item: print("EVENT input", item.get_text(), flush=True))
layout.pack_start(button, False, False, 0)
layout.pack_start(label, False, False, 0)
layout.pack_start(entry, False, False, 0)
area = Gtk.DrawingArea()
area.set_can_focus(True)
area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.KEY_PRESS_MASK)
area.connect("button-press-event", lambda item, event: (item.grab_focus(), print("EVENT down", event.button, flush=True), False)[-1])
area.connect("button-release-event", lambda item, event: print("EVENT up", event.button, flush=True) or False)
area.connect("motion-notify-event", lambda item, event: print("EVENT drag" if event.state & Gdk.ModifierType.BUTTON1_MASK else "EVENT move", int(event.x), flush=True) or False)
area.connect("scroll-event", lambda item, event: print("EVENT scroll", event.direction, flush=True) or False)
area.connect("key-press-event", lambda item, event: print("EVENT key", event.keyval, flush=True) or False)
layout.pack_start(area, True, True, 0)
window.connect("destroy", Gtk.main_quit)
window.show_all()
window.present()
print("READY", os.getpid(), flush=True)
Gtk.main()
