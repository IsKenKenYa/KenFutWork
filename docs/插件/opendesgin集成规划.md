# OpenDesign 集成规划

> **角色声明**：方案稿——OpenDesign（Figma 类似物，写代码 / 原型用的设计引擎）的集成实施蓝图。**尚未拍板**：文内决策用 `OD-*` 本地编号占位，拍板后归并《[改造计划](../方案设计/改造计划.md)》§6 并分配 `DEC-*` 编号；结论与理由以《改造计划》§6 为准。外部仓库、许可证以各上游仓库为准，代码现状数字以代码为准。插件交付形态与入口纪律同《[flow 插件集成规划](./flow插件集成规划.md)》（`FORM-11` / `DEC-10`…`DEC-13`），模式主区不变量遵循 `AGENTS.md`「产品行为不变量」。

## 1. 背景与定位

- 用户要在 design / code / flow / work 之外引入 **OpenDesign**——一个 **Figma 类似物**。定位澄清（用户口径）：**design 侧重图片 / 视频创作**；**OpenDesign 是写代码 / 原型用的**（design-to-code：把自然语言或设计稿变成可运行原型、落地页、仪表盘、幻灯片，导出 HTML/PDF/PPTX/MP4）。
- **它不叫"创作"**（用户明确否决了把它当第四个创作画布的做法）：它不是给创作者画图 / 剪片子的画布，而是给开发者"边写边看"的**代码联动画布**。因此它**不该单独占一个模式**（见 `OD-1`）。
- **集成结论（用户拍板）**：OpenDesign **直接作为 Code 模式连接的画布，放在右侧、和浏览器面板同一个位置**，原生支持链接即可——即 Code 模式的**右侧栏第二个常驻视图**（浏览器 ↔ OpenDesign 切换）。这是"和 flow 一样做成插件"的落地方式：**插件交付形态，但挂在 Code 模式右侧，不新增模式**。

### 为什么不是独立模式（`OD-1`）

| 方案 | 评价 | 结论 |
| --- | --- | --- |
| 独立第四/五模式 | 它本质是"代码 + 预览"，与 Code 同源；单独成模式会把一个辅助视图抬成模式，徒增一个空壳入口 | **否决**（用户原话：那个不叫创作、没有分得很开） |
| Code 右侧面板（与浏览器同位） | 浏览器面板已是"代码跑起来的实时视图"的现成位置；OpenDesign 是它的设计向兄弟，复用同一槽位最自然 | **采纳** |

- 这同时守住 AGENTS.md 不变量：**Code 模式主区仍是对话**（`resolveWorkbenchSurface` 的 code 分支不变，不返回 `conversation` 的回归锁不受影响）；OpenDesign 只占用**右侧栏**，与浏览器面板互斥切换，不碰主区、不新增 `WorkbenchMode`。

## 2. 待拍板决策（`OD-*` 本地编号，拍板后归并《改造计划》§6 分配 `DEC-*`）

| ID | 决策 | 对集成的影响 |
| --- | --- | --- |
| `OD-1` | OpenDesign **不作为独立模式**，作为 **Code 模式右侧画布面板**（与浏览器面板同位、互斥切换） | 不改 `WorkbenchMode` / `projectKindSchema`；主区判定 code 分支不变；纯右侧栏槽位扩展 |
| `OD-2` | **插件形态交付**（同 flow `FORM-11`），入口按插件安装态出现 | 复用插件 `ui` 能力 + 侧栏槽位机制；未安装时不摆空壳 |
| `OD-3` | **原生支持链接**：右侧面板以 iframe 嵌入 OpenDesign，支持双向链接（宿主 ↔ OpenDesign 的深链 / 状态同步） | 复用 `/canvas` / flow `ff-embed` 的 iframe 同源鉴权 + postMessage 通道范式 |
| `OD-4` | **BYOK 接入**：OpenDesign 支持 20+ CLI（Claude Code / Codex / Cursor / DeepSeek Harness / OpenCode）经 BYOK 驱动 | 凭证走本仓 BYOK 实例（`DEC-7`）；不引远程托管引擎（同 `DEC-11` 精神） |
| `OD-5` | OpenDesign **本地 daemon + PATH 扫描 agent 检测**（其 multica 血统架构）作为**唯一特权进程** | 桌面承载复用本仓 engineRuntime / sidecar 思路；启动探活 + 失败可读原因 |

## 3. 外部依赖核实（OpenDesign，2026-10）

> **OpenDesign 与本仓架构高度同源**：它自称 "Best DeepSeek Harness Design Plugin"，本仓正是 deepseek-harness 式「一切皆插件」架构——这不是外挂，是同一设计哲学的现成实现。

- 上游：`nexu-io/open-design`（Apache-2.0，100k+ stars，3721 commits），官网 `open-design.ai`。
- **定位**：开源的 Claude Design 替代品；**local-first 桌面应用**；你的 coding agent 就是设计引擎——原型、落地页、仪表盘、幻灯片、图片、视频，导出真实文件（HTML/PDF/PPTX/MP4）。
- **平台**：本地优先桌面 app（macOS / Windows / Linux / Docker）。
- **BYOK**：Claude Code / Codex / Cursor / **DeepSeek Harness** / OpenCode 等 20+ CLI 经 BYOK 接入。
- **血统与架构**：daemon + adapter 架构（源自 `multica-ai/multica`：PATH 扫描 agent 检测，本地 daemon 作为唯一特权进程）；采用 Claude Code skills 的 `SKILL.md` 约定；集成了 `guizang-ppt` / `html-ppt` / `web-clone` / `hyperframes` 等 bundled skills（各自保留其 MIT 许可）。
- **成熟度**：高星高活跃，但同属 2026-10 新项目，issue/PR 数量大（525 issues / 625 PRs），按"方向可用、版本漂移快"对待（同 flow `DEC-13` 策略）。
- **许可证**：主仓 Apache-2.0；bundled skills / templates 保留各自 license（`guizang-ppt` MIT、`html-ppt` MIT、`web-clone` MIT）。Apache-2.0 ⊂ GPL-3.0 单向兼容，可并入。

## 4. 架构与接缝清单

OpenDesign 挂在 **Code 模式右侧栏**，与浏览器面板互斥切换。右侧栏现状（`apps/web/src/components/workbench/zcode/app-shell/`）：`isBrowserOpen` / `supportsEmbeddedBrowser` / `sidePaneState` / `shellPanelIds` / `recentClosedSidePaneTabs` 已构成一套可扩展的右侧面板 tab 体系——OpenDesign 作为**新增的一个右侧 tab**接入，而非新造面板机制。

| # | 接缝 | 现有机制 | OpenDesign 要动什么 | 风险 |
| --- | --- | --- | --- | --- |
| 1 | 右侧栏 tab | ZCode app-shell 的 side pane tab 体系（浏览器 / git / summary 等多 tab） | 新增「OpenDesign」tab 入口，与浏览器 tab 同位互斥；tab 增删不改主区判定 | 中（ZCode 照搬区，改动须守 UI 保真） |
| 2 | 插件交付与入口门控 | 插件 `ui` 能力 + 侧栏槽位（`plugin-panels.tsx`）+ flow 式安装态门控（`use-flow-host.ts`） | 以插件形态交付；未安装 / daemon 未就绪时不出现入口（不摆空壳） | 低（机制现成） |
| 3 | iframe 内嵌与链接 | `/canvas` iframe 同源鉴权 + `ff-embed/v1` postMessage 通道范式 | 右侧面板 iframe 嵌入 OpenDesign；`OD-3` 双向链接（深链打开文件 / 选中态同步） | 中（跨源消息校验 + origin 白名单） |
| 4 | BYOK 凭证 | 本仓 BYOK 实例（`DEC-7`，本地明文凭据文件 + 授权设置可读） | OpenDesign 驱动 CLI 的 key 经本仓 BYOK 下发；不引远程引擎（`OD-4`） | 中（凭证边界，禁泄漏进日志 / 面板 URL） |
| 5 | 本地 daemon 承载 | flow `engineRuntime` Provider（WSL2 / 本机容器）类比 | OpenDesign daemon 按需拉起 + 启动探活；失败给可读原因（`OD-5`） | 中（平台矩阵 + 探活失败面） |
| 6 | 主区不变量 | `workbench-surface.ts` code 分支（有会话看对话） | **不改**——OpenDesign 只占右侧栏，code 主区恒为对话的回归锁不受影响 | 低（不动即安全，需回归确认） |

**入口纪律（同 flow）**：OpenDesign 以插件形态交付，**未安装插件或本地 daemon 未配齐时不出现入口**——不摆空壳、不放假开关。判定条件各自可探（插件安装态 + daemon 健康探针），任一失败 fail loud 给 reason，不猜"也许能用"。

## 5. 为什么放右侧、和浏览器同位（设计理由）

- **浏览器面板 = "代码跑起来的实时视图"**：Code 模式写代码 → 右侧浏览器看效果。OpenDesign = **"设计稿 ↔ 代码"的联动画布**：它把设计意图变成可运行原型 / 落地页，与浏览器预览是同一职责的两种形态（一个偏设计生成、一个偏运行预览）。
- **与 design 模式的创作画布彻底分开**：design 画布给创作者画图 / 剪片（Excalidraw 式）；OpenDesign 给开发者"边写边看、设计即代码"。放在 Code 右侧，职责边界清晰，不会出现"design 画布被对话框顶掉"那类主区混乱。
- **复用而非新造**：右侧 tab 体系、iframe 鉴权、postMessage 通道、插件门控、BYOK——全部现成，OpenDesign 是这些机制的又一个消费者，不是新子系统。

## 6. 分阶段路线

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| O0 | **右侧 tab 骨架（纯前端，无 OpenDesign）**：在 ZCode app-shell 加一个「OpenDesign」tab 占位入口，按插件安装态门控显隐；主区判定零改动 | `workbench-surface.test.ts` code 分支回归（不因新增 tab 变化）；tab 显隐单测；UI 保真 |
| O1 | **插件形态交付 + daemon 探活**：插件 `ui` 槽位 + `use-flow-host` 式门控；daemon 拉起 + 健康探针 + 失败可读原因 | 未安装不出现入口；daemon 未就绪 fail loud；安装后入口出现 |
| O2 | **iframe 内嵌 + 双向链接（`OD-3`）**：右侧面板 iframe 嵌入；深链打开文件 / 选中态同步；origin 白名单 + 入站消息 schema 校验 | 内嵌 + 鉴权 + 链接往返；跨源消息安全用例 |
| O3 | **BYOK 接入（`OD-4`）**：OpenDesign 驱动 CLI 的凭证经本仓 BYOK 下发；凭证不回显、不进面板 URL / 日志 | 凭证边界单测（脱敏）；端到端跑通一个 design-to-code 流程 |
| O4 | **（远期）深度收编评估** | 届时另立方案 |

纪律：每阶段一个可验证行为变化 + 测试护航；ZCode 照搬区改动守 UI 保真（同《Code 模式 ZCode-UI 照搬执行手册》）；《日志》台账同提交记账。

## 7. 许可证与合规

- OpenDesign 主仓 **Apache-2.0** ⊂ GPL-3.0 单向兼容，可并入。**bundled skills / templates 保留各自 license**（`guizang-ppt` MIT、`html-ppt` MIT、`web-clone` MIT），分发时逐一随附。
- 集成方式与 flow 对 Dify 的判断一致：若以 **daemon + API / iframe** 接入（容器 / 独立进程边界），属聚合而非衍生作品；**不得把 OpenDesign 源码复制进本 monorepo 后再改**，保持子系统边界，除非走"收编"（O4）并重审许可。
- 商标：OpenDesign 自称 "Claude Design 的替代品"，宿主 UI 表述不得误导为官方关联产品。

## 8. 风险清单

| # | 风险 | 对策 |
| --- | --- | --- |
| 1 | **误把它做成独立模式**（抬辅助视图为模式） | `OD-1` 写死：只占 Code 右侧 tab；`WorkbenchMode` 不加项；回归确认 code 主区判定不变 |
| 2 | **ZCode 照搬区被改花**（右侧 tab 属照搬 UI） | 改动守 UI 保真；只加 tab 不改既有面板行为；对照执行手册验收 |
| 3 | **版本漂移快**（2026-10 新项目，issue/PR 多） | 锚定具体发布 + 校验和；daemon 适配层收敛兼容差异；升级走回归（同 `DEC-13`） |
| 4 | **daemon 跨平台 / 探活失败** | 平台矩阵明示；探活失败 fail loud 给可读原因 + 手动放置路径，不静默失败 |
| 5 | **跨源 iframe 消息安全** | origin 白名单 + 入站消息 schema 校验 + 版本协商；宿主 sub 服务端验签（同 `ff-embed` 口径） |
| 6 | **BYOK 凭证泄漏** | 凭证只经服务端下发，禁入面板 URL / query / 日志；脱敏单测 |
| 7 | **与浏览器面板抢右侧空间 / 状态互相覆盖** | 明确 tab 互斥切换语义；`sidePaneOwnerId` 按对话隔离，不跨会话串味 |

## 9. 开放问题

1. **右侧 tab 的确切挂点**：作为 ZCode app-shell 的一等 tab（改照搬区），还是作为插件 `ui` 槽位注入的视图（零改照搬区但受插件面板 iframe 80vh 弹层形态限制，非真正"常驻右侧栏"）？前者体验正确但动照搬区，后者零侵入但形态是弹层——需在"UI 保真"与"零改照搬区"间取舍。
2. **双向链接的深度**：最小可用 = 深链打开文件；完整 = 选中态 / 光标双向同步。本期先做哪档？
3. **daemon 是否复用 flow 的 engineRuntime Provider 抽象**，还是 OpenDesign 自带 multica daemon 独立承载？影响 O1/O3 的实现位置。
4. **与 work 模式的编辑器是否共用"右侧画布"概念**：OpenDesign 在 Code 右侧，work 的 craft 编辑器在主区——两者都是"代码 ↔ 设计/编辑"的联动面，远期是否统一为一套"联动画布"抽象？
