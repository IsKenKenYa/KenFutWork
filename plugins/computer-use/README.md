# Computer Use 插件

安装后，Code 模式的 agent 获得 8 个桌面操控工具（`mcp__computer-use__<action>`）：
观察（list_apps / list_windows / get_app_state / screenshot）+ 动作（click / type）+
会话（request_access / stop_computer_control）。

- **首次使用**：agent 会先调 `request_access` 检查权限；需在 系统设置 → 隐私与安全性 里
  为运行 KenFutWork 服务端的应用授予「辅助功能」与「屏幕录制」。
- **审批**：所有动作默认走权限审批（dangerous `mcp__` 档），可在审批弹窗选择
  「本会话记住」。
- **平台**：里程碑 1 仅 macOS（JXA 无障碍树 + nut-js 截屏/注入）；其他平台工具会
  如实报告不可用。
- **治理**：动作超时 / 观察树预算 / 截图预算 / 每 run 动作上限 / 会话时长均可在
  设置中调整（`computerUse*` 治理键）。
