"""窄JSON/RPC helper：真实XDG portal授权、PipeWire帧与输入；不执行模型代码。"""
import base64
import json
import os
import signal
import sys
import threading
import uuid
import dbus
import dbus.mainloop.glib
import gi
gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
dbus.mainloop.glib.threads_init()
Gst.init(None)
bus = dbus.SessionBus()
portal_object = bus.get_object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
remote = dbus.Interface(portal_object, "org.freedesktop.portal.RemoteDesktop")
screen = dbus.Interface(portal_object, "org.freedesktop.portal.ScreenCast")
loop = GLib.MainLoop()
threading.Thread(target=loop.run, daemon=True).start()
session = None
streams = {}
pipe_fd = None
requests = set()
pressed_buttons = set()
pressed_keys = set()

def request(interface, method, args, options, timeout):
    token = "kfw" + uuid.uuid4().hex
    path = "/org/freedesktop/portal/desktop/request/" + bus.get_unique_name().replace(":", "").replace(".", "_") + "/" + token
    done = threading.Event()
    result = {}
    def response(code, values):
        result.update(code=int(code), values=values)
        done.set()
    match = bus.add_signal_receiver(response, signal_name="Response", dbus_interface="org.freedesktop.portal.Request", path=path)
    requests.add(path)
    try:
        getattr(interface, method)(*args, dbus.Dictionary(dict(options, handle_token=token), signature="sv"), timeout=timeout)
        if not done.wait(timeout):
            raise RuntimeError("timeout: portal请求未在治理deadline内完成")
        if result["code"] != 0:
            raise RuntimeError("permission_denied: 用户拒绝或取消了portal桌面授权")
        return result["values"]
    finally:
        match.remove()
        if not done.is_set():
            try: dbus.Interface(bus.get_object("org.freedesktop.portal.Desktop", path), "org.freedesktop.portal.Request").Close()
            except dbus.DBusException: pass
        requests.discard(path)

def capture_callback(sink, record):
    sample = sink.emit("pull-sample")
    buffer = sample.get_buffer()
    ok, data = buffer.map(Gst.MapFlags.READ)
    if ok:
        record["png"] = bytes(data.data)
        structure = sample.get_caps().get_structure(0)
        record["width"] = int(structure.get_value("width"))
        record["height"] = int(structure.get_value("height"))
        buffer.unmap(data)
        record["ready"].set()
    return Gst.FlowReturn.OK

def close(notify=True):
    global session, pipe_fd
    if session and notify:
        for button in list(pressed_buttons):
            try: remote.NotifyPointerButton(session, {}, dbus.Int32(button), dbus.UInt32(0))
            except dbus.DBusException: pass
        for key in list(pressed_keys):
            try: remote.NotifyKeyboardKeysym(session, {}, dbus.Int32(key), dbus.UInt32(0))
            except dbus.DBusException: pass
    pressed_buttons.clear()
    pressed_keys.clear()
    for record in streams.values(): record["pipeline"].set_state(Gst.State.NULL)
    streams.clear()
    if pipe_fd is not None:
        os.close(pipe_fd)
        pipe_fd = None
    closing = session
    session = None
    if closing and notify:
        try: dbus.Interface(bus.get_object("org.freedesktop.portal.Desktop", closing), "org.freedesktop.portal.Session").Close()
        except dbus.DBusException: pass

def terminate(*_):
    close()
    loop.quit()
    sys.exit(0)
signal.signal(signal.SIGTERM, terminate)

def open_session(timeout):
    global session, pipe_fd
    if session: return
    created = request(remote, "CreateSession", (), {"session_handle_token": "session" + uuid.uuid4().hex}, timeout)
    session = str(created["session_handle"])
    opened = session
    def session_closed():
        if session == opened:
            close(False)
            print(json.dumps({"event": "session_closed"}), flush=True)
    bus.add_signal_receiver(session_closed, signal_name="Closed", dbus_interface="org.freedesktop.portal.Session", path=opened)
    try:
        request(remote, "SelectDevices", (session,), {"types": dbus.UInt32(3)}, timeout)
        request(screen, "SelectSources", (session,), {"types": dbus.UInt32(3), "multiple": True, "cursor_mode": dbus.UInt32(2)}, timeout)
        started = request(remote, "Start", (session, ""), {}, timeout)
        pipe_fd = screen.OpenPipeWireRemote(session, dbus.Dictionary({}, signature="sv")).take()
        for node, properties in started.get("streams", []):
            node = int(node)
            size = properties.get("size")
            if not size: raise RuntimeError("unavailable: portal未提供可绑定的逻辑尺寸")
            position = properties.get("position", (0, 0))
            record = {"id": str(node), "bounds": [int(position[0]), int(position[1]), int(size[0]), int(size[1])], "ready": threading.Event()}
            pipeline = Gst.parse_launch("pipewiresrc fd=%d path=%d do-timestamp=true ! videoconvert ! video/x-raw,format=RGBA ! pngenc ! appsink name=frames emit-signals=true max-buffers=1 drop=true sync=false" % (pipe_fd, node))
            record["pipeline"] = pipeline
            pipeline.get_by_name("frames").connect("new-sample", capture_callback, record)
            streams[str(node)] = record
            pipeline.set_state(Gst.State.PLAYING)
        if not streams: raise RuntimeError("unavailable: portal未授权任何屏幕/窗口源")
    except Exception:
        close()
        raise

def keysym(name):
    aliases = {"ctrl": 0xffe3, "control": 0xffe3, "shift": 0xffe1, "alt": 0xffe9, "option": 0xffe9, "meta": 0xffeb, "super": 0xffeb, "command": 0xffeb, "cmd": 0xffeb, "enter": 0xff0d, "tab": 0xff09, "escape": 0xff1b, "esc": 0xff1b, "space": 0x20, "backspace": 0xff08, "delete": 0xffff, "left": 0xff51, "right": 0xff53, "up": 0xff52, "down": 0xff54}
    if name.lower() in aliases: return aliases[name.lower()]
    if len(name) == 1: return ord(name) if ord(name) <= 0xff else 0x01000000 | ord(name)
    if name.upper().startswith("F") and name[1:].isdigit() and 1 <= int(name[1:]) <= 35: return 0xffbd + int(name[1:])
    raise RuntimeError("invalid_target: 不支持的portal keysym")

def execute(message):
    timeout = message["timeoutMs"] / 1000
    op = message["operation"]
    if op == "status":
        return {"accessibility": "not_determined", "screen": "granted" if session else "not_determined", "hint": "使用时由真实portal对话框选择屏幕/窗口并授权输入；不会静默共享。"}
    if op == "stop": close(); return {"ok": True}
    open_session(timeout)
    if op == "displays": return [{"id": key, "name": "portal授权源 " + key, "bounds": row["bounds"], "scaleFactor": row.get("width", row["bounds"][2]) / row["bounds"][2], "primary": i == 0} for i, (key, row) in enumerate(streams.items())]
    record = streams.get(message.get("displayId"))
    if record is None: raise RuntimeError("invalid_target: 请选择当前已授权的portal源")
    if op == "capture":
        if not record["ready"].wait(timeout): raise RuntimeError("timeout: PipeWire尚未提供帧")
        return {"width": record["width"], "height": record["height"], "base64": base64.b64encode(record["png"]).decode(), "bounds": record["bounds"], "binding": record["id"]}
    def move(point): remote.NotifyPointerMotionAbsolute(session, {}, dbus.UInt32(int(record["id"])), dbus.Double(point[0]), dbus.Double(point[1]))
    def button(code, state):
        if state: pressed_buttons.add(code)
        remote.NotifyPointerButton(session, {}, dbus.Int32(code), dbus.UInt32(state))
        if not state: pressed_buttons.discard(code)
    def key(code, state):
        if state: pressed_keys.add(code)
        remote.NotifyKeyboardKeysym(session, {}, dbus.Int32(code), dbus.UInt32(state))
        if not state: pressed_keys.discard(code)
    delay = message["inputDelayMs"] / 1000
    def pause():
        if delay: threading.Event().wait(delay)
    if op == "move": move(message["point"])
    elif op == "click":
        move(message["point"])
        code = {"left": 0x110, "right": 0x111, "middle": 0x112}[message["button"]]
        try:
            for _ in range(message["count"]): button(code, 1); pause(); button(code, 0); pause()
        finally: button(code, 0)
    elif op == "drag":
        move(message["from"])
        try: button(0x110, 1); pause(); move(message["to"]); pause()
        finally: button(0x110, 0)
    elif op == "scroll":
        amount = message["amount"]
        direction = message["direction"]
        remote.NotifyPointerAxisDiscrete(session, {}, dbus.UInt32(1 if direction in ("left", "right") else 0), dbus.Int32(-amount if direction in ("left", "up") else amount))
    elif op in ("keys", "type"):
        codes = [keysym(value) for value in message["keys"]] if op == "keys" else [keysym(value) for value in message["text"]]
        try:
            if op == "keys":
                for code in codes: key(code, 1); pause()
            else:
                for code in codes: key(code, 1); pause(); key(code, 0); pause()
        finally:
            for code in reversed(list(pressed_keys)): key(code, 0)
    else: raise RuntimeError("未知portal操作")
    return {"actionSent": True, "detail": "已通过portal下发输入，请重新观察确认"}

try:
    for line in sys.stdin:
        message = json.loads(line)
        try: result = {"id": message["id"], "ok": True, "result": execute(message)}
        except Exception as error: result = {"id": message["id"], "ok": False, "error": str(error)}
        print(json.dumps(result, ensure_ascii=False), flush=True)
finally:
    close()
    loop.quit()
