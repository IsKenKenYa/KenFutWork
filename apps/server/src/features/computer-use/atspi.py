"""第一方AT-SPI provider；只读取已绑定进程/窗口或执行指定元素动作。"""
import json
import sys

request = json.load(sys.stdin)
try:
    import pyatspi
except ImportError:
    print(json.dumps({"available": False, "reason": "未安装python3-pyatspi；可安装同桌面会话AT-SPI依赖或选择其他后端"}))
    sys.exit(0)

limits = request["limits"]
desktop = pyatspi.Registry.getDesktop(0)
application = next((child for child in desktop if child.get_process_id() == request["pid"]), None)
if application is None:
    print(json.dumps({"available": False, "reason": "AT-SPI总线上未发现该进程；目标可能未导出无障碍接口"}))
    sys.exit(0)

def bounds(element):
    rect = element.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    return [rect.x, rect.y, rect.width, rect.height]

windows = [child for child in application if child.getRole() in (pyatspi.ROLE_FRAME, pyatspi.ROLE_DIALOG, pyatspi.ROLE_WINDOW)]
matches = [child for child in windows if child.name == request["title"] and bounds(child) == request["bounds"]]
if len(matches) != 1:
    print(json.dumps({"available": False, "reason": "AT-SPI窗口标题/几何不能唯一匹配X11窗口，请重新观察"}))
    sys.exit(0)
window = matches[0]
elements = []

def describe(element, depth):
    elements.append(element)
    role = element.getRoleName().lower().replace(" ", "")
    aliases = {"pushbutton": "button", "entry": "textfield", "text": "text", "check box": "checkbox"}
    node = {"role": aliases.get(role, role), "title": element.name[:limits["titleMaxChars"]]}
    states = element.getState()
    node["states"] = [name for flag, name in ((pyatspi.STATE_FOCUSED, "focused"), (pyatspi.STATE_EDITABLE, "editable")) if states.contains(flag)]
    try:
        node["value"] = element.queryText().getText(0, -1)[:limits["valueMaxChars"]]
    except NotImplementedError:
        pass
    try:
        action = element.queryAction()
        node["actions"] = [action.getName(index) for index in range(min(action.nActions, limits["maxActions"]))]
    except NotImplementedError:
        pass
    if depth < limits["maxDepth"]:
        node["children"] = [describe(element[index], depth + 1) for index in range(min(element.childCount, limits["maxChildren"]))]
    return node

root = describe(window, 0)
if request["operation"] == "observe":
    print(json.dumps({"available": True, "root": root}, ensure_ascii=False))
else:
    index = request["index"]
    if not isinstance(index, int) or index < 0 or index >= len(elements):
        raise ValueError("element_stale: 元素不在当前AT-SPI树中")
    target = elements[index]
    if request["operation"] == "click":
        actions = target.queryAction()
        names = [actions.getName(i).lower() for i in range(actions.nActions)]
        selected = next((i for i, name in enumerate(names) if name in ("click", "press", "activate")), None)
        if selected is None or not actions.doAction(selected):
            raise ValueError("element_unavailable: 元素不支持点击")
    elif request["operation"] == "type":
        if not target.queryComponent().grabFocus():
            raise ValueError("element_unavailable: 无法聚焦输入目标")
        if not target.queryEditableText().setTextContents(request["text"]):
            raise ValueError("element_unavailable: 元素不支持文本编辑")
    else:
        raise ValueError("未知AT-SPI操作")
    print(json.dumps({"available": True, "actionSent": True}))
