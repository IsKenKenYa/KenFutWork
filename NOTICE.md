# NOTICE

本仓库包含源自 **ZCode**（`references/zcode/`，Apache License 2.0）的移植代码。

- 移植位置：`apps/web/src/components/workbench/zcode/`（仓库内别名 `@zui/*`）
- 范围：Code 模式对话流 UI——markdown 渲染栈（`components/ai-elements/`，含
  streamdown 管线、代码块、表格/列表/引用/图片组件）、工具调用块体系
  （`ToolCallBlocks/`，含 read/edit/execute/search/todo/agent 等 renderer）、
  思考折叠组件、配套 lib（shiki 高亮、文件展示、diff 预览等）与视觉原语
  （`components/ui/`）
- 每个移植文件头部带「zcode 照搬」来源注释与适配注记；适配点仅限 import
  路径映射与宿主能力 stub（详见仓库 `docs/方案设计/Code模式ZCode-UI照搬执行手册.md`）
- 上游版权与许可证文本：`references/zcode/LICENSE`（Apache-2.0）、
  `references/zcode/NOTICE.md`
