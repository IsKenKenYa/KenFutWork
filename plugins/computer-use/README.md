# Computer Use 插件

安装后，code/design 两种模式的 agent 都获得桌面操控工具（`mcp__computer-use__<action>`）：

- **观察**：`list_apps` / `list_windows` / `list_displays` / `get_app_state` / `screenshot`
- **动作**：`click` / `type` / `key` / `scroll` / `drag` / `mouse_move` / `focus_window`
- **剪贴板**：`clipboard_read` / `clipboard_write`
- **会话与后端**：`request_access` / `stop_computer_control` / `list_backends` / `select_backend`
- **技能**：随插件安装 `computer-use` 技能（`skills/computer-use/SKILL.md`），告诉 agent 何时用桌面控制、观察→动作→再观察的循环与平台限制。

- **首次使用**：agent 先调 `request_access` 检查权限。
- **macOS**：在 系统设置 → 隐私与安全性 里为运行 KenFutWork 服务端的应用授予「辅助功能」与「屏幕录制」。
- **Windows**：使用 UIAutomation 与 User32 输入，不需要额外系统授权；以管理员运行的目标应用受 UIPI 限制，需要以相同权限运行服务端。
- **审批**：所有动作默认走权限审批（dangerous `mcp__` 档），可在审批弹窗选择「本会话记住」。
- **隔离**：只允许主 Run 调用；子代理与其它实例的 Run 会被拒绝。
- **治理**：动作超时 / 观察树预算 / 截图预算 / 每 run 动作上限 / 会话时长均可在设置中调整（`computerUse*` 治理键）。
