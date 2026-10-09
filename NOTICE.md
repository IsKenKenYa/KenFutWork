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

## LangChain 发行入口补丁

本仓库通过标准 pnpm 补丁修复官方 npm **langchain 1.5.11** 的 afterModel 显式模型续跑路由。ESM/CJS 发行入口的原代码采用 MIT；原许可完整保存在 `patches/LICENSE-langchain.txt`，来源哈希、修改与验证见 `patches/LangChain路由修复说明.md`。

## flow 子系统（聚合接入，不含衍生代码）

flow 模式（`features/flow/` + `plugins/flow/`）依赖两个外部组件，均**以独立进程 / 容器 + API 通信**接入，属聚合（aggregation）而非衍生作品——**本仓库不复制它们的代码**：

- **Dify**（`langgenius/dify`）：**Apache-2.0 附加条款的 source-available 项目**，不是纯开源许可。接入方式 = 用户按需拉取官方镜像、以 `dify/docker-compose.dify.yml` 的无头 profile 起栈（`DEC-11`），版本保持可升级、不锁版本（`DEC-13`）。
  - 多租户限制条款：本产品为单用户 / 单 workspace 的本机部署，不触发；未来若做多 workspace 的 SaaS，须先取得书面商业授权。
  - logo / 版权条款仅约束其前端：无头部署不跑 `dify-web` / `nginx`，明文不适用。
  - 分发与升级口径见 `docs/插件/flow插件集成规划.md` §7。
- **futureFlow**（`future73807/futureFlow`，MIT）：以 git 子模块挂载于根级 `flow/`（作者即本仓协作者）；其代码按集成方案分阶段并入，子模块内容不在此文件重复声明。
