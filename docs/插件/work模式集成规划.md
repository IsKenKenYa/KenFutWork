# Work 模式集成规划

> **角色声明**：方案稿——Work 第四模式（办公 / 生产力创作）的集成实施蓝图。**尚未拍板**：文内决策用 `WD-*` 本地编号占位，拍板后归并《[改造计划](../方案设计/改造计划.md)》§6 并分配 `DEC-*` 编号；结论与理由以《改造计划》§6 为准。外部仓库、体积与许可证以各上游仓库为准，代码现状数字以代码为准。模式主区不变量遵循 `AGENTS.md`「产品行为不变量」与《[多端产品设计](../方案设计/多端产品设计.md)》。

## 1. 背景与定位

- 主仓现有 **code / design / flow** 三模式。**Work 是第四模式**，与三者并列；模式切换器需从三图标扩展到四图标并保持并排美观（`apps/web/src/components/workbench/canvas-workbench/canvas-sidebar.tsx` 的 `availableModes` / `modeItems`）。
- **Work = 办公 + 生产力创作**：**原生 Office（PPT / Word / Excel）编辑** + **图片编辑 + 视频编辑**。这才叫 work——不是把 Code 的对话框换个皮。用户口径：Code 虽能处理 work 类任务（生成文件、跑命令），但 Code 主区是对话 + 工作目录；Work 主区是**编辑器**，提供接近桌面 Office / Photoshop / Premiere 的原生编辑体验，**对话退为辅助、不占主区**。
- **形态分层（关键设计判断）**：
  - **模式壳 = 内核**：`WorkbenchMode` 加 `work`、`projectKindSchema` 加 `work`、DB CHECK 前向迁移、主区判定、模式切换器——与 flow 的 P1 同构，进内核。
  - **编辑引擎 = 扩展包**：Office / PS / PR / LR 等具体编辑器是体量庞大的原生 Rust 应用（用户原话「6 那不得几个 G」），**不随安装包分发**，按需下载挂载。这与 flow 引擎 `FORM-11`（按需下载、双 Provider）同思路，复用 `scripts/fetch-runtimes.mjs` 的「下载 + 官方校验和 + 不留半截 + 可取消可重试」范式。
  - **"现在先打进去" 的口径**：先在扩展包注册表登记这些编辑器的**元数据与挂载点**（名称 / 来源 / 平台 / 校验和 / 体积 / WASM 或原生 / 许可），实际二进制**按需拉取**——先接线、后下载，不阻塞模式壳落地。

## 2. 待拍板决策（`WD-*` 本地编号，拍板后归并《改造计划》§6 分配 `DEC-*`）

| ID | 决策 | 对集成的影响 |
| --- | --- | --- |
| `WD-1` | Work 作为**内核第四模式**（`code / design / flow / work` 并列） | `WorkbenchMode` / `projectKindSchema` / DB CHECK / 切换器四处同改；与 flow P1 同构 |
| `WD-2` | Work 主区**恒为编辑器画布**，永不被对话顶掉（同 design / flow 不变量） | `resolveWorkbenchSurface` 的 work 分支走「画布优先」；`workbench-surface.test.ts` 全矩阵扩到四模式 |
| `WD-3` | 编辑引擎以**扩展包按需下载**交付，不随安装包 | 复用 `fetch-runtimes` 校验和范式；体积与磁盘代价前置明示；失败给可读报错 + 手动放置路径 |
| `WD-4` | Work 模式**自带 office 相关 skill**（PPTX / DOCX / XLSX 生成与编辑的 agent 技能） | 走既有 skills 能力注入；属模式 prompt / skills 配置，非新增内核能力 |
| `WD-5` | 编辑器**内嵌两档**：① **WASM iframe**（craft 系列提供 `*-web-<ver>.zip` 静态站点，web / 桌面都能内嵌）② **原生窗口**（桌面完整体验，子进程 / sidecar 拉起，同 flow 引擎承载思路） | 内嵌缝与 flow `/canvas` iframe 同源鉴权 + postMessage 复用；原生档走 `engineRuntime` 式 Provider |
| `WD-6` | kind 扩展必须**契约枚举 + 库 CHECK 同改**，由 `tests/workspace.test.mjs`「契约枚举 ↔ 库 CHECK」门禁对账 | 前向迁移 `projects_kind_check` 加 `work`；`projectKindSchema` 加 `work`；`contracts.test.ts` 补封闭枚举断言 |

## 3. 外部依赖核实（ArtCraft 系列，2026-10）

> 用户转述的"Claude Opus 5.5 纯 Rust 手撕 Adobe 全家桶"中，**仓库与套件属实、模型版本号未获公开报道印证**（Ars Technica 报道仅称由 AI 辅助从零重写）。本规划不依赖具体模型假设，只依赖仓库事实。

`storytold` org（ArtCraft 团队）的 Crafting Apps，**纯 Rust、clean-room 重写、Apache-2.0 / MIT、native（mac/Win/Linux）+ WebAssembly + 声明可被 agent 驱动**：

| 上游仓库 | 对应套件 | 与 Work 的关系 | Stars |
| --- | --- | --- | --- |
| `storytold/photocraft` | Photoshop | 图片编辑 | 28.1k |
| `storytold/vectorcraft` | Illustrator | 矢量 / 图片 | 4.0k |
| `storytold/filmcraft` | Premiere Pro | 视频编辑 | 5.5k |
| `storytold/lightcraft` | Lightroom | 图片 / RAW | 5.9k |
| `storytold/pdfcraft` | Acrobat（**用户口误 printcraft，实为 pdfcraft**） | PDF 阅读 / 整理 / 保护 | 4.8k |
| `storytold/effectcraft` | After Effects | 动效 / 视频 | 2.9k |
| `storytold/designcraft` | InDesign | 排版 / 出版 | — |
| `storytold/deckcraft` | **PowerPoint** | office 三件套之一 | 0.5k |
| `storytold/gridcraft` | **Excel** | office 三件套之一 | 0.6k |
| `storytold/soundcraft` | Pro Tools | 音频（可选） | 0.6k |
| `storytold/cadcraft` | AutoCAD | CAD（可选） | 0.8k |

- **成熟度**：套件 2026-10 爆火但仍在早期高频迭代（open issues / PR 数量大），按"方向可用、版本漂移快"对待——扩展包锚定具体发布 + 校验和，升级走回归，不为某一版本写长期兼容（同 flow `DEC-13` 对 Dify 的策略）。
- **Office 三件套现状**：PPT（`deckcraft`）、Excel（`gridcraft`）有对应仓库；**Word 目前无独立 craft 仓库**——office 能力优先用 skill（`WD-4`，agent 生成 / 编辑 docx）+ 现有库，Word 原生编辑器列为开放问题（§9）。

## 4. 架构分层与接缝清单

按主仓「能力缝三元组」（Definition + Provider + Consumer）组织；Work 与 flow 共享同一套「模式壳进内核、重型引擎按需下载」的形状。

| # | 接缝 | 现有机制 | Work 要动什么 | 风险 |
| --- | --- | --- | --- | --- |
| 1 | 模式切换器 | `canvas-sidebar.tsx` 的 `availableModes`（flow 按插件安装态出现） | 扩到含 `work`；四图标并排需控制宽度 / 收起态布局 | 中（四图标拥挤，需真机看布局） |
| 2 | 主区判定 | `workbench-surface.ts` 纯函数 + 全矩阵测试 | `WorkbenchMode` / `WorkbenchSurface` 加 `work`（主区恒编辑器画布）；`resolveWorkbenchSurface` 加 work 分支 + 穷举回归 | 高（历史事故高发区，必须全矩阵锁死） |
| 3 | 项目类型 kind | `projectKindSchema` 枚举 → DB CHECK → 前端按 kind 取列表 | 枚举 + 前向迁移 + `contracts.test.ts` 同改；work 项目列表 / 侧栏 / 建项目 | 中 |
| 4 | 编辑器内嵌 | `/canvas?id=` iframe 同源鉴权 + postMessage 通道 | `/work` 路由页 + 主区 iframe 分支；WASM 静态站点内嵌 / 原生窗口拉起 | 中（见 §5） |
| 5 | 扩展包注册与下载 | `scripts/fetch-runtimes.mjs`（下载 + 校验和 + 断点续传范式） | 新增 work 编辑引擎扩展包清单（元数据 + 挂载点）；按需下载 + 卸载清理 | 中（体积 / 磁盘 / 失败面） |
| 6 | office skill | 既有 skills 能力（模式 prompt / skills 配置） | 声明 PPTX / DOCX / XLSX 编辑 skill，随 work 模式注入 | 低 |
| 7 | 作用域绑定 | run 必绑项目（AGENTS.md 硬约束） | work run 绑 `kind='work'` 项目；编辑器产物即作用域 | 中 |

**入口纪律（同 flow）**：Work 模式壳进内核后，模式入口**常驻可切**；但某个具体编辑器（如 PS / PR）**按扩展包安装态出现**——未装扩展包时不摆该编辑器的空壳、不放假开关。模式与扩展包是两层：模式是壳（内核），编辑器是内容（按需下载）。

## 5. 编辑器内嵌两档（`WD-5`）

| 档 | 形态 | 适用 | 接入方式 |
| --- | --- | --- | --- |
| A | **WASM iframe** | web + 桌面通用 | craft 系列提供 `*-web-<ver>.zip` 静态站点，宿主静态托管后 iframe 内嵌；复用 `/canvas` 同源鉴权 + `workbench:project-created` 式 postMessage |
| B | **原生窗口 / sidecar** | 桌面完整体验 | 扩展包含原生二进制，按需下载后由宿主拉起（本地端口 + iframe 或独立窗口）；同 flow `engineRuntime` Provider 思路（按平台 native 二进制） |

- 两档共用同一「编辑器挂载点」抽象（`WorkEditorSlot`），差异落在 Provider；**禁止**在内嵌层写 `if (wasm)` 之外的业务分支渗入。
- WASM 档是**默认**（跨端一致、无平台二进制分发负担）；原生档是桌面增强（性能 / 完整工具集）。

## 6. 分阶段路线

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| W0 | **模式壳（纯内核，无编辑器）**：kind 加 `work` + 前向迁移 + `WorkbenchMode` / 主区判定 + 切换器四图标 + office skill 声明 | 契约枚举 ↔ 库 CHECK 对账门禁；`workbench-surface.test.ts` 四模式全矩阵；类型 / 测试 / biome 全绿 |
| W1 | **扩展包注册表**：登记 ArtCraft 系列元数据 + 挂载点（先接线，二进制不下载）；一个只读「Work 引擎」信息页（同 flow「引擎」页） | 注册表单测；信息页真机看图 |
| W2 | **首个编辑器按需下载 + WASM iframe 内嵌**（建议 `gridcraft`=Excel 或 `deckcraft`=PPT，直接对应 office 需求） | 下载 + 校验和 + 失败 / 取消路径；iframe 内嵌 + 鉴权；卸载无残留 |
| W3 | **图片 / 视频编辑器接入**（`photocraft` / `filmcraft`）+ 原生窗口档（桌面） | 两档各自跑通；体积与磁盘代价明示；平台矩阵 |
| W4 | **agent 联动**：work run 绑 `kind='work'` 项目；skill 生成 / 编辑产物落到编辑器作用域 | 执行作用域测试；产物往返（agent 生成 → 编辑器打开） |

纪律：每阶段一个可验证行为变化 + 测试护航；跨端契约（`packages/shared`）改动全量门禁；《日志》台账同提交记账。

## 7. 许可证与合规

- ArtCraft 各仓库 **Apache-2.0（部分 MIT 双许可）**，clean-room、不复制 Adobe 资产。GPL-3.0 主仓 ⊃ Apache-2.0 / MIT：宽松 → copyleft **单向兼容，可并入**（同 flow 对 MIT futureFlow 的结论）。分发保留各仓库 `LICENSE` / `NOTICE` / `ATTRIBUTION.md`。
- **商标红线**：Adobe / Photoshop / Illustrator 等为 Adobe 注册商标；仓库 README 已声明"独立项目、仅描述兼容的工作流"。宿主 UI **不得**把这些 craft 应用标成 Adobe 官方产品；fork / 修改版须移除 ArtCraft 品牌资产（其 `docs/brand/` 有单独许可）。
- **按需下载的许可随附**：扩展包下载时连同 LICENSE / NOTICE 落盘，不得只取二进制。

## 8. 风险清单

| # | 风险 | 对策 |
| --- | --- | --- |
| 1 | **体积（几个 G）**：全套 craft 二进制巨大 | 只按需下载**单个**编辑器，不做全家桶预置；体积与磁盘代价前置明示；卸载即删 |
| 2 | **版本漂移快**（2026-10 早期、issue/PR 多） | 扩展包锚定具体发布 + 校验和；升级走回归；不为某版本写长期兼容（同 `DEC-13`） |
| 3 | **WASM 档能力阉割**：浏览器版功能可能少于原生 | 明确 wasm 为默认档但列能力差异；桌面走原生档补全；不假装 wasm == 原生 |
| 4 | **四图标并排美观** | 切换器布局需真机看图；必要时收起到图标栏（`sidebarCollapsed` 已有收起态） |
| 5 | **主区判定回归**（design 历史事故） | `resolveWorkbenchSurface` work 分支走画布优先 + 全矩阵测试锁死 |
| 6 | **Word 无对应 craft 仓库** | office Word 优先走 skill（`WD-4`）；原生 Word 编辑器列开放问题，不硬凑 |
| 7 | **跨平台二进制分发**（wasm 例外） | 原生档按平台矩阵下载；平台不支持时落 wasm 档，不静默失败 |
| 8 | **误把编辑器当沙箱运行时**（flow 踩过的坑） | 编辑器是独立引擎，承载走扩展包 / Provider，禁止用 `danger-full-access` 兜底 |

## 9. 开放问题

1. **首个落地的编辑器选谁**：`gridcraft`（Excel）/ `deckcraft`（PPT）直接命中 office 三件套；还是直接上 `photocraft`（PS，星最高、图片编辑受众广）？建议先轻（gridcraft/deckcraft）验证按需下载 + wasm 内嵌全链路，再上重量级。
2. **Word 原生编辑器**：无 craft 对应仓库。是否接受"Word 走 skill 生成 docx + 轻量预览"，把原生 Word 编辑排除本期？
3. **原生窗口档的平台优先级**：Windows 优先（本仓主战场）还是三平台齐发？sidecar 拉起方式（本地端口 iframe vs 独立窗口）待定。
4. **编辑器产物与 Code/Design 的互通**：work 产出的文件能否被 Code 模式继续处理（文件系统互通）、被 Design 画布引用——跨模式产物边界待设计。
5. **扩展包注册表的存储与更新**：清单放内置常量、随包分发，还是服务端可更新（可追加新 craft 应用而不发版）？
