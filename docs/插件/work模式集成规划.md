# Work 模式集成规划

> **角色声明**：方案稿——Work 第四模式（办公 / 生产力创作）的集成实施蓝图。**尚未拍板**：文内决策用 `WD-*` 本地编号占位，拍板后归并《[改造计划](../方案设计/改造计划.md)》§6 并分配 `DEC-*` 编号；结论与理由以《改造计划》§6 为准。外部仓库、体积与许可证以各上游仓库为准，代码现状数字以代码为准。模式主区不变量遵循 `AGENTS.md`「产品行为不变量」与《[多端产品设计](../方案设计/多端产品设计.md)》。

## 本轮收敛边界（2026-10-15）

Code/Design先统一为一个原ZCode会话UI、Task宿主与Harness。项目是资源和会话容器，kind仅表示默认工作方式，enabledModes表示显式启用方式；文档、目录、会话分别创建。Work后续沿同一宿主贡献Office/媒体文档能力，不新增Agent UI或Task状态聚合。本轮不实现Office编辑器，不扩future OpenDesign或Flow编辑逻辑。本规划下文的交付阶段均仍是后续方案，不是已交付事实。

> **交付状态（2026-10-25，日志 §258）**：W0（契约 `work` 进 `projectKindSchema`/导航桥 + 库 CHECK 前向迁移）与 W1（服务端 `features/work` 注册表+探针路由、产品插件 `plugins/work`、壳层四模式 + 只读「Work 引擎」信息页 + 父页双路探针）**已落地**——提交 `9fcbee3c` / `9d21608f` / `c689103c` / `9610373b`。W2（首个编辑器按需下载 + WASM iframe 内嵌）起**仍是后续方案**，编辑器二进制未下载、未落位。

## 1. 背景与定位

- 主仓现有 **code / design / flow** 三模式。**Work 是第四模式**，与三者并列；模式切换器需从三图标扩展到四图标并保持并排美观（共享壳 `host/WorkbenchModeNavigation.tsx` 的 `availableModes` / `modeItems`）。
- **Work = 办公 + 生产力创作**：**原生 Office（PPT / Word / Excel）编辑** + **图片编辑 + 视频编辑**。这才叫 work——不是把 Code 的对话框换个皮。用户口径：Code 虽能处理 work 类任务（生成文件、跑命令），但 Code 主区是对话 + 工作目录；Work 主区是**编辑器**，提供接近桌面 Office / Photoshop / Premiere 的原生编辑体验，**对话退为辅助、不占主区**。
- **形态分层（关键设计判断）**：
  - **共享宿主 = 内核**：`WorkbenchMode` 加 `work`、`projectKindSchema` 加 `work`、DB CHECK 前向迁移、主区判定、模式切换器——复用统一工作台、原会话和Task，不新增独立会话壳。
  - **编辑引擎 = 扩展包**：Office / PS / PR / LR 等具体编辑器是体量庞大的原生 Rust 应用（用户原话「6 那不得几个 G」），**不随安装包分发**，按需下载挂载。这与 flow 引擎 `FORM-11`（按需下载、双 Provider）同思路，复用 `scripts/fetch-runtimes.mjs` 的「官方校验值 + 幂等跳过 + 原子落位（不留半截）+ fail loud」范式；下载进度 / 取消 / 重试沿用 flow 引擎安装的既有 UX（`FlowSurface.tsx` 内部 hook `useFlowEngineInstall`，非现成模块——复用前先提取为共享 hook）。
  - **"现在先打进去" 的口径**：先在扩展包注册表登记这些编辑器的**元数据与挂载点**（名称 / 来源 / 平台 / 校验和 / 体积 / WASM 或原生 / 许可），实际二进制**按需拉取**——先接线、后下载，不阻塞模式壳落地。**这是对用户原话的一种读法**（另一种是"二进制直接打进安装包"）；2026-10-09 实测单个应用发行包 15–70MB（§3），全套才是「几个 G」量级——按需下载是不把桌面包撑爆的落法。

## 2. 待拍板决策（`WD-*` 本地编号，拍板后归并《改造计划》§6 分配 `DEC-*`）

| ID | 决策 | 对集成的影响 |
| --- | --- | --- |
| `WD-1` | Work 作为**共享工作台的第四种工作方式**（`code / design / flow / work` 并列） | 复用统一Task与原SessionPane；新增工作方式由插件贡献文档、工具、上下文和媒体展示，契约/前向迁移/切换器同步 |
| `WD-2` | Work 主区**恒为编辑器画布**，永不被对话顶掉（同 design / flow 不变量） | 沿统一内容标签打开Office文档；显式内容切换以外的会话事件不得抢占编辑器，保留文档编辑状态 |
| `WD-3` | 编辑引擎以**扩展包按需下载**交付，不随安装包 | 复用 `fetch-runtimes` 校验和范式；体积与磁盘代价前置明示；失败给可读报错 + 手动放置路径 |
| `WD-4` | Work 模式**自带 office 相关 skill**（PPTX / DOCX / XLSX 生成与编辑的 agent 技能） | 走既有 skills 能力注入；属模式 prompt / skills 配置，非新增内核能力 |
| `WD-5` | 编辑器**内嵌两档**：① **WASM iframe**（craft 系列提供 `*-web-<ver>.zip` 静态站点，web / 桌面都能内嵌）② **原生窗口**（桌面完整体验，子进程 / sidecar 拉起，同 flow 引擎承载思路） | 内嵌缝与 flow `/canvas` iframe 同源鉴权 + postMessage 复用；原生档走 `engineRuntime` 式 Provider |
| `WD-6` | 工作方式扩展必须**契约枚举 + 默认工作方式/启用列表 + 库 CHECK 同改**，由 `tests/workspace.test.mjs`「契约枚举 ↔ 库 CHECK」门禁对账 | 前向迁移 `projects_kind_check` 加 `work`；`projectKindSchema` 加 `work`；`contracts.test.ts` 补封闭枚举断言 |
| `WD-7` | 编辑器**双向驱动**：界面内嵌（给人用）之外，agent 经编辑器官方 **MCP / CLI** 直接生成与编辑产物（craft 系列 README 明确 "Every button is also a command that the CLI and AI agents (through MCP) can drive"，wordcraft 带 "Agent-drivable over MCP" 徽章） | 工具面走本仓 `ctx.tools` + `apps/server/src/features/mcp/`（stdio / http 两传输现成）；编辑器自身早期（v0.3.x），契约锚定版本 + 回归 |

## 3. 外部依赖核实（ArtCraft 系列，2026-10-09 复核）

> 用户转述的"Claude Opus 5.5 纯 Rust 手撕 Adobe 全家桶"中，**仓库与套件属实、模型版本号未获公开报道印证**（Ars Technica 报道仅称由 AI 辅助从零重写）。本规划不依赖具体模型假设，只依赖仓库事实。本节事实经 GitHub API + 各仓 README / Release 逐项复核（2026-10-09）。

`storytold` org（ArtCraft 团队，官网 `getartcraft.com`）的 Crafting Apps，**纯 Rust、clean-room 重写、MIT OR Apache-2.0 双许可、native（mac/Win/Linux/FreeBSD）+ WebAssembly + CLI/MCP 可被 agent 驱动**：

| 上游仓库 | 对应套件 | 与 Work 的关系 | Stars（2026-10-09） |
| --- | --- | --- | --- |
| `storytold/photocraft` | Photoshop | 图片编辑 | 28.9k |
| `storytold/filmcraft` | Premiere Pro | 视频编辑 | 5.7k |
| `storytold/lightcraft` | Lightroom | 图片 / RAW | 6.2k |
| `storytold/effectcraft` | After Effects | 动效 / 视频 | 3.0k |
| `storytold/vectorcraft` | Illustrator | 矢量 / 图片 | 4.1k |
| `storytold/designcraft` | InDesign | 排版 / 出版 | 1.8k |
| `storytold/pdfcraft` | Acrobat（**用户口误 printcraft，`printcraft` 仓库名已 301 跳转到 pdfcraft**） | PDF 阅读 / 整理 / 保护 | 4.9k |
| `storytold/wordcraft` | **Word** | office 三件套之一（.docx 读写，含修订/引用/邮件合并） | 949 |
| `storytold/deckcraft` | **PowerPoint** | office 三件套之一（.pptx 读写） | 549 |
| `storytold/gridcraft` | **Excel** | office 三件套之一（表格） | 660 |
| `storytold/soundcraft` | Pro Tools | 音频（可选） | 621 |
| `storytold/cadcraft` | AutoCAD | CAD（可选） | 904 |

- **office 三件套齐备**：Word（`wordcraft`）/ Excel（`gridcraft`）/ PPT（`deckcraft`）都有对应仓库，用户要的"原生 ppt、word、excel 编辑"不缺件（此前版本误判"Word 无仓库"，已更正）。
- **发布与产物体量（实测）**：office 三件套刚在 2026-10-08 齐发 **v0.3.0**，`photocraft` 同日 **v0.5.0**。每仓发布 23 个资产：macOS universal `.dmg`、Windows x64/arm64 `.msi` + portable `.zip`、Linux AppImage / deb / rpm / flatpak、FreeBSD tarball、**`<app>-web-<ver>.zip`（WASM 静态站点，即 `WD-5` A 档的现成分发物）**、`<app>-cli-<ver>-*.zip`（CLI）、`SHA256SUMS.txt`。单个应用发行包 15–70MB（`gridcraft` AppImage ≈15MB，`wordcraft` ≈52MB，`photocraft` ≈61MB，`deckcraft` ≈67MB）——**全套预置才是「几个 G」**。
- **agent 驱动面（`WD-7` 依据）**：各仓 README 明确 CLI 与 AI agents 经 **MCP** 驱动（"every button is also a command"）；wordcraft 默认可读写 `.docx`，deckcraft（PPT）、gridcraft（Excel）同理。给 Work 模式的 agent 一条"直接改产物"的强通路，不必等 UI 内嵌落地。
- **成熟度**：套件 2026-10 爆火但仍在早期（README 自标 early alpha / early development，v0.3.x–v0.5.0），按"方向可用、版本漂移快"对待——扩展包锚定具体发布 + 校验和，升级走回归，不为某一版本写长期兼容（同 flow `DEC-13` 对 Dify 的策略）。

## 4. 架构分层与接缝清单

按主仓「能力缝三元组」（Definition + Provider + Consumer）组织；Work沿Code/Design统一会话、Task与内容标签贡献文档插件；Flow现有内容面保持不变。

| # | 接缝 | 现有机制 | Work 要动什么 | 风险 |
| --- | --- | --- | --- | --- |
| 1 | 模式切换器 | 共享壳 `WorkbenchModeNavigation` 的 `availableModes`（Flow 按插件安装态出现） | 扩到含 `work`；四图标并排需控制宽度 / 收起态布局 | 中（四图标拥挤，需真机看布局） |
| 2 | 主区判定 | 原工作台WorkspaceShellLayout + useAppPanels内容槽 | 扩工作方式与已安装文档renderer，保留原会话/标签协议与Task，覆盖显式切换和后台事件 | 高（历史事故高发区，必须全矩阵锁死） |
| 3 | 项目类型 kind | `projectKindSchema` + `enabledModes` → DB CHECK → 前端按启用方式取列表 | 枚举 + 前向迁移 + `contracts.test.ts` 同改；复用项目/会话导航；默认工作方式与enabledModes控制隔离和显式共享 | 中 |
| 4 | 编辑器内嵌 | `/canvas?id=` iframe 同源鉴权 + postMessage 通道 | `/work` 路由页 + 主区 iframe 分支；WASM 静态站点内嵌 / 原生窗口拉起 | 中（见 §5） |
| 5 | 扩展包注册与下载 | `scripts/fetch-runtimes.mjs`（官方校验值 + 幂等 + 原子落位）；flow 引擎安装 UX（进度 / 取消，`FlowSurface.tsx` 内部 hook `useFlowEngineInstall`，复用前先提取共享） | 新增 work 编辑引擎扩展包清单（元数据 + 挂载点）；按需下载 + 卸载清理 | 中（体积 / 磁盘 / 失败面） |
| 6 | office skill | 既有 skills 能力（模式 prompt / skills 配置） | 声明 PPTX / DOCX / XLSX 编辑 skill，随 work 模式注入 | 低 |
| 7 | 作用域绑定 | run 必绑项目（AGENTS.md 硬约束） | Work Run复用项目的统一Task固定目录，接纳时冻结工作方式/模型/能力/资源/代际；选中文档不增加文件授权 | 中 |
| 8 | agent 驱动编辑器（MCP / CLI） | 本仓 `features/mcp`（stdio / http 传输）+ `ctx.tools` | 编辑器官方 MCP server 接入（`WD-7`）；与 skill 生成文件两条路互不阻塞 | 中（上游早期，契约漂移） |

**入口纪律（同 flow）**：Work文档插件接通后才出现对应工作方式入口；某个具体编辑器（如 PS / PR）**按扩展包安装态出现**——未装扩展包时不摆该编辑器的空壳、不放假开关。模式与扩展包是两层：模式是壳（内核），编辑器是内容（按需下载）。

## 5. 编辑器内嵌两档（`WD-5`）

| 档 | 形态 | 适用 | 接入方式 |
| --- | --- | --- | --- |
| A | **WASM iframe** | web + 桌面通用 | craft 系列提供 `*-web-<ver>.zip` 静态站点，宿主静态托管后 iframe 内嵌；复用 `/canvas` 同源鉴权 + `kenfutwork:*` 前缀 postMessage 通道（如 `kenfutwork:canvas-create`；仓库无 `workbench:*` 通道） |
| B | **原生窗口 / sidecar** | 桌面完整体验 | 扩展包含原生二进制，按需下载后由宿主拉起（本地端口 + iframe 或独立窗口）；同 flow `engineRuntime` Provider 思路（按平台 native 二进制） |

- 两档共用同一「编辑器挂载点」抽象（`WorkEditorSlot`），差异落在 Provider；**禁止**在内嵌层写 `if (wasm)` 之外的业务分支渗入。
- WASM 档是**默认**（跨端一致、无平台二进制分发负担）；原生档是桌面增强（性能 / 完整工具集）。

## 6. 分阶段路线

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| W0 | **共享Harness与文档契约**：工作方式、Task冻结、文档授权与内容标签回归；编辑器未接通前不展示Work入口 | 契约枚举 ↔ 库 CHECK 对账门禁；壳层现存测试扩成四模式全矩阵（切换器 `host-workbench-mode-navigation.test.tsx`、主区 `workbench-modes.test.tsx`；历史 `workbench-surface.test.ts` 已删）；类型 / 测试 / biome 全绿 |
| W1 | **扩展包注册表**：登记 ArtCraft 系列元数据 + 挂载点（先接线，二进制不下载）；一个只读「Work 引擎」信息页（同 flow「引擎」页） | 注册表单测；信息页真机看图 |
| W2 | **首个编辑器按需下载 + WASM iframe 内嵌**（office 三件套任一：`gridcraft`=Excel / `wordcraft`=Word / `deckcraft`=PPT，直接对应 office 需求） | 下载 + 校验和 + 失败 / 取消路径；iframe 内嵌 + 鉴权；卸载无残留 |
| W3 | **图片 / 视频编辑器接入**（`photocraft` / `filmcraft`）+ 原生窗口档（桌面） | 两档各自跑通；体积与磁盘代价明示；平台矩阵 |
| W4 | **agent 联动**：Work Run复用统一Task；skill与文档工具按可信文件/文档授权处理产物 | 执行作用域测试；产物往返（agent 生成 → 编辑器打开） |

纪律：每阶段一个可验证行为变化 + 测试护航；跨端契约（`packages/shared`）改动全量门禁；《日志》台账同提交记账。

## 7. 许可证与合规

- ArtCraft 各仓库 **MIT OR Apache-2.0 双许可**（各仓 README 徽章与 `LICENSE` 文件为准；GitHub API 的 SPDX 字段只报其中一个，勿以单值对待），clean-room、不复制 Adobe 资产。GPL-3.0 主仓 ⊃ Apache-2.0 / MIT：宽松 → copyleft **单向兼容，可并入**（同 flow 对 MIT futureFlow 的结论）。分发保留各仓库 `LICENSE` / `NOTICE` / `ATTRIBUTION.md`。
- **商标红线**：Adobe / Photoshop / Illustrator 等为 Adobe 注册商标；仓库 README 已声明"独立项目、仅描述兼容的工作流"。宿主 UI **不得**把这些 craft 应用标成 Adobe 官方产品；fork / 修改版须移除 ArtCraft 品牌资产（其 `docs/brand/` 有单独许可）。
- **按需下载的许可随附**：扩展包下载时连同 LICENSE / NOTICE 落盘，不得只取二进制。

## 8. 风险清单

| # | 风险 | 对策 |
| --- | --- | --- |
| 1 | **体积**：全套 craft 二进制合计「几个 G」 | 只按需下载**单个**编辑器（实测单应用发行包 15–70MB，§3），不做全家桶预置；体积与磁盘代价前置明示；卸载即删 |
| 2 | **版本漂移快**（2026-10 早期、issue/PR 多） | 扩展包锚定具体发布 + 校验和；升级走回归；不为某版本写长期兼容（同 `DEC-13`） |
| 3 | **WASM 档能力阉割**：浏览器版功能可能少于原生 | 明确 wasm 为默认档但列能力差异；桌面走原生档补全；不假装 wasm == 原生 |
| 4 | **四图标并排美观** | 切换器布局需真机看图；必要时收起到图标栏（`sidebarCollapsed` 已有收起态） |
| 5 | **主区判定回归**（design 历史事故） | 统一内容标签保留编辑器，不由消息、审批或恢复抢占；完整工作方式矩阵回归 |
| 6 | **编辑器与 MCP / CLI 契约早期**（自标 early alpha / early development） | 扩展包与 MCP 适配锚定具体发布 + 校验和；升级走回归；skill 生成（`WD-4`）与 MCP 驱动（`WD-7`）互为兜底，单条路断不阻塞 |
| 7 | **跨平台二进制分发**（wasm 例外） | 原生档按平台矩阵下载；平台不支持时落 wasm 档，不静默失败 |
| 8 | **误把编辑器当沙箱运行时**（flow 踩过的坑） | 编辑器是独立引擎，承载走扩展包 / Provider，禁止用 `danger-full-access` 兜底 |

## 9. 开放问题

1. **首个落地的编辑器选谁**：office 三件套（`gridcraft` / `wordcraft` / `deckcraft`，15–67MB）直接命中用户诉求，建议先轻验证按需下载 + wasm 内嵌全链路；还是直接上 `photocraft`（PS，星最高、图片编辑受众广，61MB）？
2. **`WD-7`（MCP / CLI 驱动）的落地时机**：编辑器 MCP 直连（agent 直接操作编辑器）与 skill 生成文件（agent 落盘、编辑器打开）先做哪条？两条可独立上线——建议 skill 先（不依赖上游 MCP 稳定），MCP 跟随后补。
3. **原生窗口档的平台优先级**：Windows 优先（本仓主战场）还是三平台齐发？sidecar 拉起方式（本地端口 iframe vs 独立窗口）待定。
4. **编辑器产物与 Code/Design 的互通**：显式共享项目后，同一Task可跨工作方式继续；文件授权仍来自固定工作域，文档引用由插件校验。跨项目资源须另行显式授权。
5. **扩展包注册表的存储与更新**：清单放内置常量、随包分发，还是服务端可更新（可追加新 craft 应用而不发版）？
