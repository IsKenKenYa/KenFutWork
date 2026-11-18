# 电脑使用与浏览器使用集成设计（Computer Use + Browser Use）

> **角色**:方案稿(CU-A…D 已拍板执行;里程碑 1(P0+P1 macOS 可用回路)已于 2026-10-01 交付,回执见《日志》§六十四)。调研依据见《调研/07-ComputerUse集成调研》,下称《07》。2026-11-16 合并《电脑使用与浏览器使用统一方案》(原文件删除)与《ComputerUse原生Helper设计》(并入 §12);浏览器轴的现状、共用行为规则与未实施批次见 §9,macOS Helper 的协议、TCC、签名与迁移见 §12。
> **一句话**:以 ZCode CUA 的协议形状为准绳,走内核 `ctx.tools` 注册表交付,执行层「nut-js + JXA 过渡 → 独立 helper 目标态」两档演进,权限/会话/预算语义第一天进契约;桌面形态装配,自托管不装配。
> **边界**:本文设计两条能力轴——Computer Use(原生桌面与操作系统界面)与 Browser Use(网页内操作);两条轴共用观察→动作→再观察的规则,工具面与执行层分别独立。

## 1. 目标与非目标

**目标**:
1. 主 agent 能观察(文本优先)与操控用户桌面上的原生应用,模型无关(BYOK 三协议都可玩);
2. 复用已照搬的 CUA 渲染链——服务端产出协议形状即点亮 UI,不做新 UI;
3. 每个动作可审批、可中止、可审计;权限授予与身份验证 fail loud;
4. 桌面形态(Tauri 内嵌服务端)首发;Windows/Linux 按平台矩阵后置。

**非目标**:
- 不做裸执行模型生成代码的通道(Agent-S 模式,《07》§2.3);
- 不允许子代理使用 CUA(ZCode 同款纪律);
- 自托管/Docker 形态不装配(控制服务器侧桌面无意义且危险);
- 不引入 OmniParser/Agent-S/OpenAdapt 运行时依赖(只借思想,《07》§2)。

## 2. 总体架构

```
┌─ 模型面(任意 BYOK 模型)────────────────────────────┐
│  工具调用 mcp__computer-use__<action>(文本观察树 + raster)│
└──────────────┬───────────────────────────────┘
┌─ 工具缝(kernel ctx.tools,scope: shared)────────────┐
│  ComputerUseService(会话/lease/预算/受信 targetApp 记录) │
│  工具组:观察 3 + 动作 8 + 会话 2(§3)                    │
└──────────────┬───────────────────────────────┘
┌─ 执行层缝(ComputerUseExecutor,§5)────────────────┐
│  A 档:nut-js(截屏+输入)+ JXA(AX 树)─ 服务进程身份     │
│  B 档:独立 helper 进程 + unix socket broker(目标态)    │
└──────────────┬───────────────────────────────┘
   OS:AX API / CGEvent / ScreenCapture / TCC
```

事件/呈现侧:工具事件沿既有 WS 流,`display: kind:"cua"` 投影 + 截图走 ToolArtifact(§7),点亮 web 端已照搬的 12 个 cua renderer 与贴底操作组。

## 3. 工具面设计(模型可见)

**命名与注册**:工具名 **`mcp__computer-use__<action>`**,注册进内核 `ctx.tools`(命名符合 `kernel/types.ts:232` 的 `mcp__<server>__<tool>` 约定),`scope: "shared"`(2026-11-16 用户确认 code/design 全模式开放;子代理与派生深度仍拒绝)。**不进 `createMainAgentTools` 遗留工具带**——Code/Design 混装问题(《07》§4.1)不允许再添一案;`runtime.ts` 的 `kernelToolRegistry.list(preset)` 过滤天然生效。插件 bundle 随装附带 `skills/computer-use/SKILL.md`(何时用桌面控制、观察→动作→再观察、平台限制),与 zcode `computer-use 0.6.5` 的技能投递方式一致;浏览器工具的选择规则由 browser 插件的提示段承担(`tools.browser`)。

**动作集**(对齐 cua 收敛形状,《07》§3;★=P0 必需):

| 组 | 工具 | 参数要点 | 说明 |
| --- | --- | --- | --- |
| 观察 | `list_apps` ★ | `{}` | 应用清单 {pid,name,bundle_id,active} |
| 观察 | `list_windows` ★ | `{app_ref}` | 窗口行(window_id/title/subrole/bounds) |
| 观察 | `get_app_state` ★ | `{app_ref, include_screenshot?, disable_diffing?}` | a11y 树 + 可选 raster;绑定即透明拉起 |
| 观察 | `screenshot` ★ | `{app_ref}` | 窗口级 raster(独立工具,UI 有专属渲染) |
| 动作 | `left_click` ★ | `{target, mouse_button?, click_count?, modifiers?, app_ref?, return_state?}` | target=元素索引或坐标(§4) |
| 动作 | `type` ★ | `{text, target?, app_ref?, return_state?}` | Unicode 走剪贴板通道 |
| 动作 | `key` / `scroll` / `left_click_drag` | 见 cua 形状 | P1 |
| 动作 | `set_value` / `select_text` / `perform_action` / `paste` / `hold_key` / `mouse_move` / `read_clipboard` / `write_clipboard` / `wait` / `zoom` | — | P2(zoom 与剪贴板属能力扩展,先声明后实现,fail loud 报 unavailable) |
| 会话 | `request_access` ★ | `{capabilities?}` | TCC 状态 + 引导;结果内嵌 permissionStatus |
| 会话 | `stop_computer_control` ★ | `{reason?}` | 释放 lease/停止注入 |

`app_ref` 形状:`{name}|{bundle_id}|{pid}`(+`window_id` 钉窗口),裸字符串按 bundle_id 读——照 cua 语义。`return_state ∈ compact|full|none` 让动作自带回读,减少往返。

**子代理禁用(双层)**:①派发缝——子代理工具白名单(`subagent-definitions` 的 resolveChildToolbelt)结构性不含 CUA,请求即 `ConfigurationError`;②运行期——CUA 工具 execute 首先断言非派生上下文(事件按 agentCallId 归因,派生调用直接拒绝)。

**模型侧说明**:Computer Use 用法做成插件 bundle 技能(`plugins/computer-use/skills/computer-use/SKILL.md`,装即进入技能目录,由 `use_skill` 读取),与 ZCode 以 skill 交付同构;浏览器与电脑控制的取舍、浏览器侧的观察纪律由 browser 插件的提示段 `tools.browser` 承担,code/design 两种 preset 都注入。

## 4. 观察协议

- **a11y 树为主通路**:元素行 `[index] kind title (=value) (pressable/editable/disabled) actions=[…]`;全树 ≤32KB,超限裁剪保祖先并在头部声明;`elements()` 语义合并进 get_app_state 的 structuredContent。
- **A 档降级**:executor 无 a11y 能力时(nut-js 档),`get_app_state` 返回 `{state:"unavailable", reason:"a11y_not_supported", raster}`——截图照发,模型走视觉;**显式声明降级,不冒充树**。JXA 档补上 AX 树后自动回到文本主通路。
- **截图(raster)**:默认窗口级(隐私默认,《07》§7-A 实证 ZCode 同款);`has_image` 语义照抄(false=没要像素,非失败);单张 ≤256KB、内联 base64 ≤200KB,超限落 blob 走 ToolArtifact URL。
- **坐标纪律**:坐标只能引用**最近一次返回的 raster**(帧绑定 frame_id),服务端 owns raster→屏幕的换算(Retina pixelDensity);元素 bounds 是诊断字段,模型坐标禁用之;元素索引寻址优先于坐标,消失元素 fail closed(`element_unavailable`)。
- **delta 观察树(§P2)**:`state_id` 单调 + `changes{added,removed,changed}`;P0 一律全量树——已照搬 UI 对缺失 diff 容忍(《07》§2.1-zcode 笔记)。
- **错误码**:`element_stale / element_unavailable / foreground_required / not_settable / app_not_found / controller_busy / permission_denied / timeout / internal`,配 `suggested_action`(UI 对 element_stale 有专属文案,《07》§4.5)。

## 5. 执行层(ComputerUseExecutor 缝)

```ts
interface ComputerUseExecutor {
  accessStatus(): Promise<CuaRequestAccessStatus>;      // TCC 查询 + 黑帧检测
  listApps(): Promise<AppInfo[]>;
  listWindows(appRef: AppRef): Promise<WindowRow[]>;
  observe(appRef: AppRef): Promise<AxTree | { unavailable: reason }>;  // A 档可降级
  capture(appRef: AppRef): Promise<Raster>;             // 窗口级
  act(action: CuAction): Promise<ActionResult>;         // status: sent|not_sent
}
```

| 档 | 组成 | a11y | 身份/TCC | 阶段 |
| --- | --- | --- | --- | --- |
| A-1 | `@computer-use/nut-js`(截屏 82ms 实测 + CGEvent 注入 + node-mac-permissions 引导) | 无(降级视觉) | 服务进程;辅助功能+屏幕录制两项授权 | P1 |
| A-2 | + JXA 桥(`osascript -l JavaScript` 读 System Events AX 树,零原生代码) | 有(秒级,够用) | 同上(同一 TCC 主体) | P1(与 A-1 同 PR 或紧随) |
| B | 独立 Swift Helper.app + unix socket JSON-RPC;AX 读取/截屏/注入/枚举全进 helper | 有(原生性能) | 独立可验签身份;TCC 主体是 Helper;授权后只重启 Helper | 本期目标(2026-10-26 用户确认);实施规格见 §12 |

**A→B 不换协议**:工具面、观察协议、事件形状全不变,executor 是纯内部缝——这正是 UI-TARS Operator 抽象(《07》§2.2)的教训。

**Windows 执行器**(`executor-windows.ts`):UIAutomation + User32 SendInput,进程以当前用户权限运行,受 UIPI 限制;后端 `windows-native.ps1`/`.cs` 以 `-Serve` 常驻,按行读写 JSON 请求/结果,C# 只编译一次,后续动作不再重启 PowerShell(真机验收场景 59.5s → 8.8s)。客户端 `windows-host.ts` 负责子进程复用、请求串行、单请求超时与取消;超时或取消即结束进程,下次调用重新拉起,启动探针失败只重试一次。

**A 档强制护栏**(实测教训,《07》§7-B):①截屏后做黑帧检测,全黑即报 `permission_denied` 并附引导,**不信 `getAuthStatus` 单边结论**;②`screen.width()` 等 AX 依赖调用包上 fail loud 封装,禁静默降级;③输入注入前自检辅助功能状态。

## 6. 权限、会话与安全

- **审批**:全工具前缀 `mcp__computer-use__` 进 permissions default 档(逐 mutating 动作 ask);`evaluate({scenario:"automation"})` 时**默认 deny**(无人值守轮次不开 CUA);auto-approve 由用户显式开档。拒绝经 `tool-denial` 记账(连续 3 次中止)。
- **会话与 lease**:CUA 会话 = run 级;同工作区同时只允许一个活跃 lease(第二个 run 报 `controller_busy` 并透出持有方);run 中止/完成的清理钩子必调 `stop_computer_control`;**kill switch**:前端停止按钮既有 abort 链路即触发。
- **actionSent 语义**:动作结果必带 `status: sent|not_sent`——非幂等动作只有 `not_sent` 才允许模型重试(照 ZCode 事故语义,《07》§2.1)。
- **受信通道**:display 投影里的 `targetApp`、`permissionStatus` 由服务端在工具执行时自行记录,**不采信模型转述**;权限引导 fail closed(broker/executor 缺席→工具显式 unavailable,不注空环境)。
- **隐私与注入防护**:默认窗口级截屏;全屏截屏为显式参数;截屏进模型上下文的事实写入权限档文案;`type`/`paste` 内容视为模型输出、目标元素仍走审批;网页内容(a11y 文本里)视为不可信数据,不作为指令源——系统提示/技能里写明。
- **剪贴板**:P0 不做读写工具;`type` 的 Unicode 通道用剪贴板时**先备份后还原**(UI-TARS win32 同款技巧,《07》§2.2)。

## 7. 数据与事件流(契约先行)

按单源链纪律,契约先改 `packages/shared`:

1. `ws-protocol.ts`:工具事件增加可选 `display` 投影字段(zod 判别联合,首成员 `kind:"cua"`:state/text 预算、media(≤4 张/256KB/总 512KB)、targetApp、permissionStatus、errorCode/suggestedAction)。
2. 输出形状 = MCP CallToolResult(`content[{type:"text"}|{type:"image",mimeType,data}]`、`isError`、`structuredContent`)——已照搬 renderer 的解析契约(《07》§4.5)。
3. 截图大图走 `ToolArtifact`(image url/mime/尺寸,`artifacts.ts:10`)——既有通道零新增。
4. `request_access` 成功后发一次性**权限观察事件**(zod strict)点亮 `cuaPermissionAction` 恢复流程;历史恢复不补造副作用事件。
5. 连续 `mcp__computer-use__*` 行由已照搬 `conversationCuaGroups` 自动聚合(无需服务端处理)。

**UI 验收清单(P0)**:CUA 工具行(cua.tsx 渲染 25 动作)✓ / 贴底操作组 ✓ / 截图缩略 ✓ / 权限行 + 设置返回恢复 ✓ / 错误码专属文案 ✓。

## 8. 服务缝与治理

**三元组**(插件化纪律):
- **Service Definition**:`features/computer-use/service.ts`——`ComputerUseService`(accessStatus/observe/act/lease 生命周期/预算执行);
- **Provider**:`executor-nutjs.ts`、`executor-jxa.ts`、`executor-broker.ts` + `plugin.ts` 按 profile 装配(桌面 profile 且平台匹配才注册;自托管 profile 不注册,前端入口不渲染——对齐 flow 插件「不摆空壳」纪律);
- **Consumer**:①`ctx.tools` 工具注册(scope shared);②WS display 投影;③设置页治理项。

**治理表新键**(`governance.ts` 唯一属主,禁止字面量):`computerUseActionTimeoutMs`(单动作)、`computerUseObserveMaxBytes`(树 32KB 默认)、`computerUseScreenshotMaxBytes`(256KB)、`computerUseMaxActionsPerRun`、`computerUseSessionMaxMs`;默认值与区间进 `AGENT_GOVERNANCE_DEFAULTS/LIMITS`,`workspace_settings` 可调。

## 9. 浏览器使用（Browser Use）

网页内的任务走 `features/browser` 的 `browser_*` 工具与右侧浏览器面板；原生桌面与操作系统界面走 Computer Use。两者共用同一套观察、寻址、动作结果与控制权规则。

**现状（2026-11-16）**：

- 工具面 8 个 `scope: "shared"` 工具：`browser_open` / `browser_navigate` / `browser_snapshot` / `browser_screenshot` / `browser_console` / `browser_network` / `browser_act` / `browser_eval`；面板由 `/api/browser/cdp/*` 路由提供画面流、输入、调试控制台、元素选择器与截图。
- 观察以渲染后的 DOM 文本与可交互元素为主；`browser_act` 支持 CSS 选择器点击、坐标点击、输入文本与按键；页面报错读 `browser_console`，网络读 `browser_network`。
- 权限门控：浏览器控制、调试读取与页面执行脚本分别由设置开关控制，默认按最小权限。

**四条共用行为规则**（与 Computer Use 一致）：

1. 观察优先给文字与树，像素作补充；像素不可信时说明原因，不把全黑或遮挡内容交给模型。
2. 元素引用优先，坐标只对最近一帧有效；编号与帧在动作后失效，必须重新观察。
3. 动作结果区分已发出与未发出；已发出的动作只允许重新观察后决定，不直接重试。
4. 同一时刻只有一个控制者；电脑使用用 run 级 lease，浏览器用标签占用，都向用户透出当前持有方。

**已确认事项（2026-10-23 用户确认，随原文并入）**：建立 `BrowserBackend` 接口（本期只提供 `cdp` 实现）；画面流默认后台、面板打开即启动；元素身份加严；权限引导（系统原生授权框、把应用加入列表的提示、`grantOwner`、「自动化」一行与未完成状态）。权限引导批次已完成第一版，验证见《日志》同日回执；`BrowserBackend` 与其他批次尚未实施。

**未实施批次**（按测试驱动切片接续，一次一个测试推进一步实现）：

| 批次 | 内容 | 验收 |
| --- | --- | --- |
| B 观察与寻址 | 快照给可交互元素写入稳定编号并返回；`browser_act` 接受编号，旧编号报 `element_stale`；可选 `Accessibility.getFullAXTree` 作为首选观察 | 同一次观察内编号稳定，页面跳转后全部失效；旧编号点击被拒绝 |
| C 启动与连接 | `--remote-debugging-port=0` + 读取资料目录下的 `DevToolsActivePort`；连接失败按端口占用、权限拒绝、浏览器缺失、启动超时分类 | 连续启动 5 次都能连上；每种失败有错误码与处理办法 |
| D 可见性与占用 | 画面流默认不启动，面板可见时才推流；用户与 agent 共用标签时先取得占用，冲突报当前持有方 | 未打开面板不产生截图帧；打开后 2 秒内出画面；第二个调用方被拒绝并看到持有方 |

**未落地的治理键**（实施时写入 `packages/shared/src/governance.ts`，业务代码不写固定数值）：`browserActionTimeoutMs`、`browserSnapshotMaxBytes`、`browserScreenshotMaxBytes`、`browserMaxActionsPerRun`。`fetch-page.ts` 的 8 秒与 512 KiB 是静态抓取的一次性限制，保留原处并保留行内注释。

**验收**：

```bash
pnpm --filter @kenfutwork/server exec vitest run src/features/computer-use src/features/browser
pnpm --filter @kenfutwork/server typecheck
```

真机回路：打开本地开发页面 → 读取渲染后的页面与元素 → 点击/输入 → 再次读取确认结果；用过期元素编号操作必须被拒绝。

## 10. 分阶段落地

| 阶段 | 内容 | 验收门 |
| --- | --- | --- |
| **P0 协议点亮** | shared 契约(display 投影)→ `features/computer-use/` 服务缝 + 工具组(6 个 ★)注册 ctx.tools(scope code)→ 权限档/automation deny 接线 → 治理键。executor 未装配时全部显式 unavailable | 真机:工具行/操作组/权限行点亮;code preset 才可见;design run 与子代理不可见;typecheck/test 过 |
| **P1 macOS A 档** | nut-js executor(截屏+注入+黑帧检测+权限引导)+ JXA AX 树 + lease/kill switch/actionSent + 内置技能注入 | 真机:计算器全回路(观察树→索引点击→delta 再观察→窗口截图);无 TCC 时工具报 permission_denied 并给出引导;审批档逐动作生效 |
| **P2 观察与治理深化** | delta 观察树、元素索引寻址强化、set_value/select_text/perform_action 等语义动作、剪贴板工具、截图预算全链 | 大树应用(如浏览器/IDE)观察 ≤32KB 裁剪正确;错误码文案全点亮 |
| **P3 多平台** | Windows(UIA+SendInput);anthropic 协议实例叠挂 `tools.computer_20251124` 复用 executor;`deliveryKind: web-remote-replayable`(多端回放) | 同一工具面回归全绿;Windows 冒烟;DMG 打包线签验通过 |
| **全模式与 Windows** | 工具 scope 改 `shared`、运行扩展 preset 改 `shared`、执行上下文放宽 Task 依赖;Windows 执行器容错解析、显式 `hasText`、动作内聚焦与常驻后端 | code/design 主 Run 均可用;子代理/外部 Run 仍拒绝;Windows 真机 UIA/输入/截图测试 |
| **浏览器对齐（未实施）** | 快照元素编号与 `browser_act` 按编号动作;随机调试端口;画面流按需启动与标签占用;`BrowserBackend` 接口 | 旧编号被拒绝;连续启动可连接;未打开面板不推流;同一标签的第二个调用方被拒绝 |

每阶段一个 PR(行为不变→能力递增),验证命令:`pnpm --filter @kenfutwork/server test` + `pnpm typecheck` + 真机走查;契约改动全量 `pnpm test`。

## 11. 待拍板(承接《07》§6,含本设计的推荐)

| 项 | 问题 | 本设计推荐 |
| --- | --- | --- |
| CU-A | 交付形态 | 内嵌能力缝 + `mcp__computer-use__` 命名(点亮已照搬 UI);第三方 CUA server 未来走 `features/mcp` 用户自配缝 |
| CU-B | macOS 执行层 | **2026-10-26 用户确认直接采用 B 档原生 Swift Helper**；A 档只保留源码与测试兜底。实施规格见 §12，协议按 Helper 的 JSON-RPC 形状确定 |
| CU-C | 首个观察通路 | P0 协议先行;P1 落 JXA 文本树(比纯视觉多一档,零原生代码);raster 同版可用 |
| CU-D | 审批粒度 | 逐 mutating 动作 ask 起步;P2 引入会话级授权 + lease 内免逐次(对齐 ZCode 体验) |
| CU-E | anthropic 原生通道 | P3 叠挂,复用同一 executor;不作基座 |
| CU-F | deliveryKind | P3 随多端立项;P0 契约里预留字段避免返工 |
| CU-G(新) | scope 取值 | 2026-11-16 用户确认 code/design 全模式开放:工具 `scope: "shared"`,运行扩展 `preset: "shared"`;子代理与派生深度继续拒绝 |

---

## 12. macOS 原生 Swift Helper 实施规格

> 角色：macOS 原生 Helper 的实施规格与阶段回执（2026-11-16 自《ComputerUse原生Helper设计》并入本章，原文件删除）。
>
> 决策：`CU-B` 于 2026-10-26 修订——macOS 执行层直接采用原生 Swift Helper；当前 nut-js + JXA 的 A 档只保留为源码环境和测试兜底，桌面发布默认使用 Helper。

### 12.1 目标与边界

#### 12.1.1 要解决的问题

当前 macOS Computer Use 由服务端 Node 进程直接执行：

- JXA 通过 `osascript` 读取 System Events 的无障碍树；
- `nut-js` 负责截图和输入注入；
- `input-worker.cjs` 是 Node 子进程；
- `@computer-use/node-mac-permissions` 在服务端进程查询 TCC。

因此系统隐私授权的主体是服务端 Node 或它启动的子进程，而不是 KenFutWork 桌面应用。开发环境给 `KenFutWork.app`、`node` 或终端授权都可能对不上，授权后还常要重启整个应用，表现为“已经授权但仍显示未授权”。

#### 12.1.2 目标

1. macOS 的 Accessibility 与 Screen Recording 只授权给一个固定的 Helper 应用。
2. 服务端不再直接调用需要 TCC 的接口，只通过本地 Unix socket 调 Helper。
3. 授权后只重启 Helper，不退出主应用、不重启数据库、不丢当前任务。
4. 开发 Helper 与发布 Helper 都有固定 bundle ID、固定安装路径和可验证签名。
5. 保持现有工具面、审批、lease、截图预算、错误码和 UI 投影不变。
6. 为 Windows 保留同一套 JSON-RPC 协议，只替换平台 Helper。

#### 12.1.3 非目标

- 不绕过 macOS 的用户同意。Accessibility 和 Screen Recording 仍需要用户在系统设置确认。
- 不把 Helper 做成可被任意本机进程调用的通用自动化服务。
- 不在本期实现 Windows Helper；只确定协议和 UAC 边界。
- 不把 ZCode 或 Codex 的闭源 Helper 代码复制进仓库。

### 12.2 现状证据

| 事实 | 位置 |
| --- | --- |
| 执行层是 `ComputerUseExecutor` 接口，可替换 Provider | `apps/server/src/features/computer-use/executor.ts:185` |
| macOS 执行器使用 JXA、nut-js 和 `node-mac-permissions` | `apps/server/src/features/computer-use/executor-macos.ts:326` |
| 当前 `build-helper.mjs` 只构建输入 worker 并复制原生依赖 | `apps/server/src/features/computer-use/build-helper.mjs:27` |
| Tauri 只把 `release/computer-use` 映射为 `app/computer-use` | `apps/desktop/src-tauri/tauri.macos.conf.json` |
| 发布链当前只有 ad-hoc 封印，没有 Developer ID 与公证 | `apps/desktop/scripts/macos-signing.mjs:1`、`docs/方案设计/CI-CD与发版方案.md:48` |
| 设计文档已把独立 Helper + Unix socket 定为 B 档目标 | 本文 §2 总体架构、§5 执行层、§10 分阶段落地 |
| 实际签名应用与 TCC 授权仍标注为待完成 | `docs/日志.md:4145`、`:4531` |

结论：独立 Helper 不是新方向，而是既定 B 档目标的正式实施。当前 A 档可以继续作为源码环境兜底，但不能作为发布形态的权限主体。

### 12.3 目标架构

```mermaid
flowchart LR
    MODEL["模型工具调用<br/>mcp__computer-use__*"] --> SERVICE["ComputerUseService<br/>lease / 预算 / 审批"]
    SERVICE --> EXEC["ComputerUseExecutor"]
    EXEC --> CLIENT["HelperClient<br/>Unix socket JSON-RPC"]
    CLIENT --> HELPER["KenFutWork Computer Use.app<br/>Swift / LSUIElement"]
    HELPER --> AX["Accessibility API<br/>AXUIElement"]
    HELPER --> CAP["ScreenCaptureKit<br/>CGWindow fallback"]
    HELPER --> INPUT["CGEvent / NSPasteboard"]
    HELPER --> TCC["TCC<br/>Accessibility / Screen Recording"]
```

#### 12.3.1 职责划分

| 层 | 职责 | 不负责 |
| --- | --- | --- |
| Agent 工具面 | 工具名、参数、审批、结果投影 | TCC、AX、截图、输入 |
| `ComputerUseService` | run 级 lease、预算、超时、`actionSent`、停止 | 平台 API |
| `HelperClient` | socket 连接、握手、协议版本、请求超时、重连 | 用户授权与系统设置 |
| Swift Helper | AX 树、应用/窗口枚举、截图、输入、剪贴板、权限状态与引导 | 模型审批、任务编排、业务日志 |
| 桌面壳 | 启动/停止 Helper、显示 Helper 路径、返回设置后重启 Helper | 直接执行 AX 或截图 |

#### 12.3.2 关键原则

- TCC 主体只有 Helper。服务端 Node、Electron 主进程和 WebView 都不申请 Accessibility 或 Screen Recording。
- Helper 通过 LaunchServices 启动为独立应用，不作为服务端子进程 `fork`。
- 特权操作必须在 Helper 进程内完成，或由 Helper 进程内的原生扩展完成；不能再让 `osascript` 或独立输入子进程成为实际 TCC 主体。
- Helper 不决定“是否允许动作”。审批仍由服务端权限层处理，Helper 只执行已批准的请求并记录执行结果。

### 12.4 Helper 应用设计

#### 12.4.1 产物与身份

| 项目 | 发布 Helper | 开发 Helper |
| --- | --- | --- |
| 应用名 | `KenFutWork Computer Use.app` | `KenFutWork Computer Use Dev.app` |
| Bundle ID | `com.kenfutwork.cua-helper` | `com.kenfutwork.cua-helper.dev` |
| 安装位置 | `KenFutWork.app/Contents/Resources/cua-helper/` | `<数据目录>/cua-helper/dev/` |
| 启动方式 | `open` / `NSWorkspace` | `open` / `NSWorkspace` |
| 签名 | Developer ID + 公证 | 固定自签名开发证书，或 Apple Development |
| UI 形态 | `LSUIElement=true`，无 Dock 图标 | 同上 |
| 最低系统 | macOS 12.0；ScreenCaptureKit 路径 12.3+，低版本回退 CGWindow | 同左 |

开发 Helper 必须使用独立 bundle ID，不能与发布 Helper 共用。这样开发授权不会污染正式安装，正式应用也不会误用开发 Helper。

#### 12.4.2 目录与模块

```text
apps/computer-use-helper/
  Package.swift
  Sources/
    HelperApp/
      main.swift
      AppDelegate.swift
      OnboardingWindow.swift
    Protocol/
      Envelope.swift
      Methods.swift
      Errors.swift
    Socket/
      UnixSocketServer.swift
      PeerVerifier.swift
      FrameCodec.swift
    Permissions/
      PermissionController.swift
      PermissionState.swift
    Accessibility/
      AppCatalog.swift
      WindowCatalog.swift
      AXTree.swift
      AXActions.swift
    Capture/
      ScreenCapture.swift
      WindowCapture.swift
      FrameStore.swift
    Input/
      MouseInput.swift
      KeyboardInput.swift
      Clipboard.swift
    Session/
      LeaseController.swift
      RequestContext.swift
    Support/
      Logging.swift
      Limits.swift
  Resources/
    Info.plist
    AppIcon.icns
  scripts/
    build.sh
    bundle.sh
    sign-dev.sh
```

#### 12.4.3 原生能力

| 能力 | 实现 | 说明 |
| --- | --- | --- |
| 应用枚举 | `NSWorkspace.runningApplications` | 返回 pid、bundle ID、显示名、是否活跃、路径 |
| 窗口枚举 | AXUIElement + CGWindowList | 只返回可绑定窗口；排除合成表面 |
| 无障碍树 | AXUIElement、AXObserver | 元素索引、角色、标题、值、状态、可用 actions |
| 元素动作 | AXUIElementPerformAction | 按元素索引执行 press/raise/show menu 等 |
| 窗口截图 | ScreenCaptureKit；旧系统 CGWindowListCreateImage | 窗口级；返回 frameId、bounds、scale、PNG |
| 输入 | CGEvent | 鼠标移动、点击、拖拽、滚动、组合键、文本 |
| 剪贴板 | NSPasteboard | Unicode 文本先备份再还原 |
| 权限状态 | AXIsProcessTrusted、CGPreflightScreenCaptureAccess | 只在 Helper 进程内查询 |
| 权限引导 | AXIsProcessTrustedWithOptions、CGRequestScreenCaptureAccess、打开系统设置面板 | 用户确认后重启 Helper |

#### 12.4.4 线程与取消

- AX 与 UI 相关操作在主 actor 或专用串行队列执行，避免阻塞主线程。
- 截图、输入、AX 读取各自有超时；取消时释放按下的鼠标按钮和键盘按键。
- 所有请求带 `requestId` 和 `runId`；`stop` 后拒绝新的动作请求。
- 非幂等动作的响应必须带 `actionSent`，服务端据此决定是否允许重试。

### 12.5 JSON-RPC 协议

#### 12.5.1 传输

- Unix domain socket，路径固定在应用数据目录：
  `~/Library/Application Support/com.kenfutwork.desktop/cua-helper.sock`
- 目录权限 `0700`，socket 权限 `0600`。
- 换行分隔 JSON；单帧上限建议 32 MiB；截图超过预算时返回错误或仅返回元数据。
- 每个请求带 `id`、`method`、`params`；响应带 `id`、`ok`、`result` 或 `error`。
- 连接建立后先 `hello`；协议版本不匹配直接关闭连接并返回可读原因。

#### 12.5.2 握手

```json
{
  "id": "1",
  "method": "hello",
  "params": {
    "protocolVersion": 1,
    "client": "kenfutwork-desktop",
    "clientVersion": "0.1.3",
    "token": "<64-hex-token>"
  }
}
```

```json
{
  "id": "1",
  "ok": true,
  "result": {
    "protocolVersion": 1,
    "helperVersion": "0.1.0",
    "bundleId": "com.kenfutwork.cua-helper",
    "pid": 12345,
    "teamIdentifier": "TEAMID",
    "permissions": {
      "accessibility": "denied",
      "screenRecording": "denied"
    }
  }
}
```

#### 12.5.3 方法表

| 方法 | 参数 | 结果 | 说明 |
| --- | --- | --- | --- |
| `ping` | `{}` | `{pong:true}` | 健康检查 |
| `broker_info` | `{}` | `{bundleId,pid,version,teamIdentifier}` | 身份与版本 |
| `permission.status` | `{probe?:boolean}` | `PermissionStatus` | 权限状态与 Helper 路径 |
| `permission.request` | `{kind:"accessibility"\|"screen_recording"}` | `{opened:boolean}` | 弹系统提示或打开设置面板 |
| `apps.list` | `{}` | `{apps:AppInfo[]}` | 运行中的应用 |
| `windows.list` | `{app:AppRef}` | `{windows:WindowInfo[]}` | 目标窗口 |
| `state.get` | `{app:AppRef, includeScreenshot?:boolean, disableDiff?:boolean}` | `{state:string, frame?:Frame}` | 无障碍树与可选截图 |
| `screen.capture` | `{app:AppRef}` | `Frame` | 窗口截图 |
| `action.perform` | `{action:Action, runId:string}` | `{actionSent:boolean, frame?:Frame}` | 点击、输入、按键、滚动、拖拽 |
| `session.stop` | `{runId:string}` | `{stopped:boolean}` | 释放租约与输入状态 |
| `helper.shutdown` | `{}` | `{ok:boolean}` | 主应用退出或重启 Helper |

#### 12.5.4 权限状态结构

```ts
type PermissionStatus = {
  available: boolean;
  helperBundleId: string;
  helperPath: string;
  teamIdentifier: string | null;
  accessibility: "granted" | "stale" | "denied" | "unknown";
  screenRecording: "granted" | "denied" | "unknown";
  automation?: "granted" | "denied" | "unknown";
  accessibilityProbeOk?: boolean;
  screenCaptureProbeOk?: boolean;
  grantOwner: string | null;
  reason?: string;
};
```

- `grantOwner` 必须是 Helper 的 bundle ID 或 Helper 应用路径，不能是主应用或 Node。
- `stale` 表示系统已有授权记录，但当前 Helper 进程读到的状态不可用；UI 应提示重启 Helper。
- `available=false` 时给出具体原因，禁止返回空对象。

#### 12.5.5 帧与坐标

```ts
type Frame = {
  frameId: string;
  app: { pid: number; bundleId: string; name: string };
  windowId: number;
  bounds: { x: number; y: number; width: number; height: number };
  scale: number;
  mimeType: "image/png";
  dataBase64: string;
  blank: boolean;
  capturedAt: number;
};
```

- 坐标动作必须引用最近一帧的 `frameId`；Helper 校验帧与应用/窗口身份。
- 窗口关闭、位置变化、应用退出时返回 `element_stale` 或 `foreground_required`。
- 黑帧必须标 `blank=true` 并返回 `permission_denied`，不能冒充成功截图。

#### 12.5.6 错误码

沿用现有工具错误码：

`permission_denied`、`element_stale`、`element_unavailable`、`foreground_required`、`app_not_found`、`controller_busy`、`timeout`、`invalid_target`、`internal`。

Helper 返回的错误必须包含 `code`、`message`、`actionSent`，时给出可执行的恢复建议。

#### 12.5.7 共享类型

- 服务端与 Web 的 TypeScript 类型放在 `packages/shared/src/computer-use-helper-protocol.ts`，用 zod 校验。
- Swift 侧用 Codable 镜像同一字段；协议版本号 `1` 在两端硬编码为常量。
- 新增字段必须保持向后兼容；删除或改义字段必须提升协议版本。
- 协议变更同步更新 `docs/api/` 或对应模块说明；该 socket 不进入公开 OpenAPI。

### 12.6 权限与 TCC

#### 12.6.1 需要的系统权限

| 权限 | 用途 | 是否必需 |
| --- | --- | --- |
| Accessibility | AX 读取、元素动作、CGEvent 输入 | 必需 |
| Screen Recording | 窗口/屏幕截图 | 必需 |
| Automation | 仅在 Helper 需要操作 System Events 时 | 核心路径不使用；可选 |
| Full Disk Access | 不申请 | 不需要 |
| Input Monitoring | 不单独申请；输入由 Accessibility 覆盖 | 不需要 |

核心路径必须使用原生 AX 和 CGEvent，不使用 JXA、System Events 或 `osascript`。这样可以避免 Helper 之外的进程成为 TCC 主体。

#### 12.6.2 授权状态机

```mermaid
stateDiagram-v2
    [*] --> unknown
    unknown --> checking: permission.status
    checking --> denied: accessibility 或 screen 未授权
    checking --> granted: 两项均授权
    denied --> granted: 用户在系统设置授权并重启 Helper
    granted --> denied: 用户撤销授权
    granted --> stale: 旧进程缓存或签名变化
    stale --> granted: 重启 Helper 后重新查询
    stale --> denied: 重启后仍未授权
```

#### 12.6.3 授权引导

1. 用户点击“打开辅助功能设置”或首次调用 `request_access`。
2. Helper 在自身进程内调用 `AXIsProcessTrustedWithOptions` 弹出系统提示；或打开 `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`。
3. 用户把 Helper 加入并开启。Helper 是列表中的 `KenFutWork Computer Use`，不是 KenFutWork 主应用。
4. 屏幕录制调用 `CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess`；用户确认后，Helper 需要新进程才能生效。
5. 主应用收到授权返回后，通过 `helper.shutdown` 停掉 Helper，再用 `open` 拉起新 Helper。
6. 新 Helper 查询状态并返回 `granted`；主应用刷新设置页。

#### 12.6.4 为什么只重启 Helper

- Accessibility 的 `AXIsProcessTrusted` 是进程级缓存；新进程才能读到新授权。
- Screen Recording 的授权通常要求捕获进程重启。
- Helper 是独立 `.app`，主应用可以只停止和拉起 Helper，不触碰数据库、任务、WebView 或当前会话。
- 如果 Helper 仍以子进程方式运行，TCC 可能把它归到父进程；必须通过 LaunchServices 启动独立应用。

#### 12.6.5 签名与授权稳定性

TCC 授权与 Helper 的代码身份绑定。要让授权在应用更新后继续有效：

- 固定 bundle ID；
- 固定签名身份（Developer ID 或固定开发证书）；
- 固定安装路径与 Helper 名称；
- 不每次构建都更换签名或重命名应用。

当前仓库发布链只有 ad-hoc 签名，没有 Developer ID 与公证。ad-hoc Helper 可以在本机开发时授权，但重新编译后可能被系统视为新身份，导致再次授权。因此：

- 开发态：使用固定自签名开发证书，或 Apple Development 证书；Helper bundle ID 固定为 `.dev`。
- 发布态：使用 Developer ID Application + 公证；这是“升级后不重新授权”的先决条件。
- 如果暂时没有 Developer ID，必须如实告知测试用户：重新构建或更新 Helper 后可能需要重新授权；不能承诺无感升级。

### 12.7 开发环境

#### 12.7.1 构建与安装

新增独立构建目标：

```bash
# 构建 Swift Helper
swift build -c release --package-path apps/computer-use-helper

# 生成 .app、写入 Info.plist 并签名
node apps/computer-use-helper/scripts/build-helper.mjs \
  --out release/cua-helper \
  --configuration dev \
  --version 0.1.0

# 需要固定证书时追加 --identity "KenFutWork CUA Dev"
# 启动开发 Helper
open -n -a "release/cua-helper/KenFutWork Computer Use Dev.app"
```

开发脚本需要完成：

- 复制 Info.plist、图标和 Swift 产物；
- 使用固定开发证书签名；
- 写入固定数据目录；
- 校验 bundle ID、签名和可执行文件；
- 输出 Helper 路径与健康检查结果。

#### 12.7.2 开发签名

推荐顺序：

1. 在本机钥匙串创建固定的自签名证书，例如 `KenFutWork CUA Dev`；
2. 用同一证书签 Helper 和开发主应用；
3. 固定 bundle ID 与安装路径；
4. 每次重建后验证 TCC 授权是否仍保留；
5. 如果 ad-hoc 签名下授权每次失效，明确记录为开发限制，不把 ad-hoc 结果当作发布结论。

#### 12.7.3 主应用启动与生命周期

- 主应用或服务端在首次需要 CUA 时启动 Helper；不随应用启动无条件拉起。
- 使用 `open -n` 或 `NSWorkspace.openApplication`，传入 socket 路径和启动参数；不要用 `fork`。
- Helper 单实例：socket 锁 + pid 文件；旧 socket 需清理但不能误杀其他进程。
- Helper 空闲超时退出；主应用退出时先 `helper.shutdown`，再退出。
- 服务端重启后优先重连已有 Helper；连接失败再拉起新 Helper。
- Helper 崩溃时，当前请求失败关闭，服务端按需重启 Helper；不自动重放非幂等动作。

### 12.8 安全设计

#### 12.8.1 本地通道

- socket 只位于用户数据目录，目录 `0700`、socket `0600`。
- 32 字节随机 token 以 64 位小写十六进制字符串写入 `0600` 文件；启动参数或握手时传递，不写入日志。
- Helper 验证客户端进程的代码签名（audit token），只接受 KenFutWork 主应用或服务端；拒绝其他本机进程。
- 客户端验证 Helper bundle ID、TeamIdentifier、可执行文件路径和版本；不匹配则拒绝连接。
- 不监听 TCP 端口，不暴露网络接口。

#### 12.8.2 动作边界

- Helper 只执行明确的 action 请求，不执行 shell、脚本或任意 AppleScript。
- `runId` 与 lease 由服务端下发；Helper 拒绝没有有效 run 的动作。
- `stop` 后立即释放按键、鼠标按钮和租约；迟到的动作请求失败。
- 截图预算、AX 树预算、动作超时由服务端治理值控制，Helper 只执行上限。
- 默认窗口级截图；全屏截图需要显式参数。
- 日志不记录用户输入文本、剪贴板内容和截图内容；只记录请求类型、目标应用、耗时和错误码。

### 12.9 打包与签名

#### 12.9.1 资源映射

```json
{
  "bundle": {
    "resources": {
      "../../../release/cua-helper": "app/cua-helper"
    }
  }
}
```

#### 12.9.2 签名顺序

1. 编译 Swift 可执行文件；
2. 生成 Helper `.app`；
3. 签名 Helper 内部所有 Mach-O；
4. 使用 `codesign --options runtime --timestamp --sign "Developer ID Application: ..."` 签 Helper；
5. 签主应用；
6. 提交公证并 staple；
7. 运行 `spctl --assess` 与 `codesign --verify --deep --strict`。

当前 `apps/desktop/scripts/macos-signing.mjs` 只支持 ad-hoc 补封。需要扩展为：

- 检测已有 Developer ID 签名时，使用同一身份重签内部 Mach-O；
- 禁止把 Developer ID 降级为 ad-hoc；
- 把 Helper 的签名状态、TeamIdentifier、公证结果写入 `dist-manifest.json`；
- 在未配置 Developer ID 时明确记录 `adhoc`，不冒称公证完成。

#### 12.9.3 开发与发布差异

| 项目 | 开发 | 发布 |
| --- | --- | --- |
| Helper 名称 | `KenFutWork Computer Use Dev.app` | `KenFutWork Computer Use.app` |
| Bundle ID | `com.kenfutwork.cua-helper.dev` | `com.kenfutwork.cua-helper` |
| 安装目录 | 数据目录 `cua-helper/dev/` | 应用资源 `Contents/Resources/cua-helper/` |
| 签名 | 固定开发证书 | Developer ID + 公证 |
| TCC 授权 | 开发 Helper 单独授权 | 发布 Helper 单独授权 |
| 更新 | 重建后验证授权是否保留 | 固定签名下保持授权 |

### 12.10 Windows 对照

Windows 没有 macOS 的 TCC 两项授权。普通应用的 UI Automation、Windows Graphics Capture、SendInput 和剪贴板访问不需要用户逐项授权；只有目标应用以管理员权限运行并受 UIPI 保护时，非管理员进程不能操作它，需要 Helper 以管理员权限启动，并经过 UAC 确认。

| 项目 | macOS | Windows |
| --- | --- | --- |
| 系统隐私授权 | Accessibility + Screen Recording | 无 |
| 首次引导 | Helper 的 TCC 提示与系统设置 | 无；只有提升权限时出现 UAC |
| 屏幕捕获 | ScreenCaptureKit / CGWindow，需要 TCC | Windows Graphics Capture / GDI，无需同意 |
| 输入 | CGEvent，需要 Accessibility | SendInput / UIA，无需同意 |
| 管理员目标应用 | 不适用 | 非提升 Helper 被 UIPI 阻止；需要提升 Helper 或拒绝 |
| 代码签名 | Developer ID + 公证，影响 TCC 稳定性 | Authenticode 可选，主要影响 SmartScreen |
| Helper 形态 | 必需，TCC 主体 | 可选；仍建议独立进程，便于隔离与提升权限 |

Windows Helper 可以复用同一套 JSON-RPC 协议：

- `apps/computer-use-helper-windows/`，Rust 或 C#；
- 命名管道传输；
- UIA 读取与动作，SendInput 输入，Windows Graphics Capture 截图；
- 普通权限 Helper 先运行；需要控制管理员窗口时，明确提示 UAC，不自动提升；
- 不需要在服务端保存 Windows 权限状态；只返回 `elevated` 与目标进程完整性级别。

### 12.11 迁移计划

#### 12.11.1 阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 原型 | 最小 Swift Helper：权限查询、系统提示、一个 AX 读取、一个截图、一个 CGEvent；通过 `open` 启动 | 只授权 Helper，主应用不授权；授权后只重启 Helper；主应用不退出 |
| P1 协议 | Unix socket、握手、权限状态、应用/窗口枚举、错误码 | 服务端客户端可连接；协议版本不匹配失败关闭 |
| P2 能力 | AX 树、截图、点击、输入、滚动、拖拽、剪贴板 | 与 A 档同一工具面和错误码一致 |
| P3 桌面接入 | 主应用启动/停止 Helper、设置页显示 Helper 路径、授权返回重启 | 开发与打包应用都能只重启 Helper |
| P4 签名发布 | 开发证书、Developer ID、公证、嵌套签名、更新验证 | `spctl` 通过；升级后授权保留；无 Developer ID 时如实标 ad-hoc |

#### 12.11.2 代码落点

| 文件 | 动作 |
| --- | --- |
| `apps/computer-use-helper/` | 新增 Swift Package、Helper 应用与脚本 |
| `packages/shared/src/computer-use-helper-protocol.ts` | 新增协议类型与 zod 校验 |
| `apps/server/src/features/computer-use/executor-helper.ts` | 新增 Helper 客户端执行器 |
| `apps/server/src/features/computer-use/executor.ts` | 工厂优先选择 Helper |
| `apps/server/src/features/computer-use/plugin.ts` | helper 状态、权限 RPC、生命周期 |
| `apps/desktop/src-tauri/src/` | 启动/停止 Helper、转发 socket 路径、退出清理 |
| `apps/desktop/src-tauri/tauri.macos.conf.json` | 增加 Helper 资源映射 |
| `scripts/package-mac.mjs` | 构建、复制、签名 Helper |
| `apps/desktop/scripts/macos-signing.mjs` | 支持 Developer ID 嵌套签名，不降级 |
| `apps/web/src/components/workbench/zcode/settings/ComputerUseSection.tsx` | 显示 Helper 路径与重启入口 |
| `apps/server/src/features/computer-use/*.test.ts` | 协议、权限、生命周期回归 |

#### 12.11.3 兼容与回退

- 新增开关 `KENFUTWORK_CUA_HELPER=1` 或配置项 `cuaHelperEnabled`；发布默认开启。
- Helper 不可用、版本不匹配或签名校验失败时，工具显式返回 `unavailable`，不静默回退到 A 档。
- 源码环境可以显式设置 `KENFUTWORK_CUA_HELPER=0` 使用 A 档；A 档仍保留测试覆盖。
- 回退只切换执行层，不改工具面、审批、lease、UI 投影或存储。

#### 12.11.4 当前进度

#### 协议与权限状态（2026-10-26）

- `packages/shared/src/computer-use-helper-protocol.ts`：hello 参数、成功/错误响应联合、权限状态、逐行请求解析与响应序列化。
- `apps/computer-use-helper` Swift Package：
  - `HelperProtocol`：hello 结果与权限状态的 Codable 解码，版本不匹配、Helper 身份和绝对路径校验；
  - `HelperCore`：权限状态转换 unknown / checking / denied / granted / stale。

#### Socket 握手（2026-10-27）

- `HelperTransport`：POSIX Unix socket 服务，socket 目录/文件权限、64 位十六进制 token、协议版本、hello、permission.status、ping、broker_info、helper.shutdown，以及未握手、错误 token、未知方法、坏 JSON 的错误响应。
- 真实 socket 测试验证：hello 返回 Helper 身份与权限状态；未握手 status 被拒绝；版本不匹配、错误 token、未知方法、坏 JSON 分别返回可读错误；socket 文件权限为 `0600`。
- 验证：
  - `pnpm --filter @kenfutwork/shared exec vitest run src/computer-use-helper-protocol.test.ts`
  - `swift test --package-path apps/computer-use-helper`

#### 可执行入口与 TCC 查询（2026-10-27）

- 新增可执行目标 `kenfutwork-cua-helper`：解析 `--socket`、`--token`、`--bundle-id`、`--helper-path`、`--version`、`--team-id`，启动 Unix socket，收到 `helper.shutdown` 或 SIGTERM/SIGINT 时清理 socket 并退出。
- `HelperLaunchOptions` 对缺失参数、未知参数、短 token、相对 Helper 路径直接报错。
- `MacOSPermissionProbe` 在 Helper 进程内调用 `AXIsProcessTrusted` 与 `CGPreflightScreenCaptureAccess`；`PermissionStatusBuilder` 把结果映射为 granted / denied / unknown，并保留 Helper 身份。
- `permission.request` 的请求与结果已加入 `packages/shared` 协议；socket 通过注入的提示器调用，生产入口接 `MacOSPermissionPrompt`。测试只验证注入提示器的调用与错误分支，不触发真实系统弹窗。
- 进程级测试：真实启动可执行文件，完成 hello/permission.status，发送 `helper.shutdown` 后进程以 0 退出并删除 socket；发送 SIGTERM 后同样清理并退出。
- 验证：
  - `swift test --package-path apps/computer-use-helper`，23 项通过；
  - `pnpm --filter @kenfutwork/shared test`，185 项通过。

#### Helper.app 打包与固定身份（2026-10-27）

- 新增 `bundle-config.mjs` 与 `build-helper.mjs`：
  - dev：`KenFutWork Computer Use Dev.app` / `com.kenfutwork.cua-helper.dev`
  - production：`KenFutWork Computer Use.app` / `com.kenfutwork.cua-helper`
  - 固定 `kenfutwork-cua-helper` 可执行名、`LSUIElement=true`、最低系统 12.0
- 构建脚本支持 ad-hoc 默认签名，也支持 `--identity` 指定固定证书；写入 Info.plist、签名并执行 `codesign --verify --deep --strict`。
- 真实测试：构建 dev `.app`、读取 Info.plist、验签、通过 `open -n -a` 启动、完成 hello/permission.status、发送 shutdown 后 socket 删除；Node 测试 2 项通过。

#### 服务端 Helper 客户端与进程管理（2026-10-27）

- `helper-client.ts`：真实 Unix socket 客户端，64 位 token 校验、协议版本握手、逐行响应、请求超时、断线识别；7 项真实 socket 测试通过。
- `helper-manager.ts`：读取 Helper Info.plist 确认 bundle ID / 版本，创建 `0700` socket 目录，通过 `/usr/bin/open -n -a` 启动 Helper，重试连接，支持 `status`、`requestPermission`、`restart`、`stop`。真实 Helper.app 集成测试覆盖启动、状态、目录权限、重启与 socket 清理。
- `helper-location.ts`：打包壳注入 `KENFUTWORK_CUA_HELPER_PATH` 优先；开发形态落在数据目录 `cua-helper/dev/`。socket 路径超过 macOS `sun_path` 上限时启动期报错。
- `helper-permission-rpc.ts`：`cua-permission.getStatus`、`restartHelper`、`requestPermission` 三个宿主方法改为只调用 Helper；Helper 缺失或启动失败时返回 `available:false` 与可读原因，不再把主应用或 Node 当作授权主体。
- 插件注册与退出清理已接线：服务端关闭时停止 Helper，避免遗留进程。
- 验证：
  - `RUN_CUA_HELPER_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/computer-use/helper-manager.integration.test.ts`
  - `pnpm --filter @kenfutwork/server exec vitest run src/features/computer-use/helper-permission-rpc.test.ts src/features/computer-use/helper-location.test.ts`

#### TCC 授权引导与返回后重启（2026-10-27）

- 原生引导先经 `cua-permission.requestPermission` 让 Helper 自己触发系统权限框；只有 Helper 进程被 TCC 记录，授权才会落在 Helper 上。弹框未通过时继续打开对应系统设置面板。
- `getStatus` 下推 `includeFunctionalProbes`：Helper 用只读 AX 查询验证辅助功能通道、用 2×2 像素抓屏验证屏幕录制；预检通过但实测失败时辅助功能报 `stale`、屏幕录制报 `denied`，设置页继续引导重启或重新授权。
- 授权引导结果改为 `restartHelperAfterReturn: true`；设置页沿用既有恢复流程，在返回后调用 `cua-permission.restartHelper`，由服务端重启 Helper；重启后的首轮状态查询带功能探针，后续轮询保持只读。
- 设置页「授权应用」卡改为显示状态里的 `grantOwner`（Helper 路径），不再显示主应用路径。
- 开发入口 `apps/desktop/scripts/dev-macos.mjs` 每次启动构建 dev Helper，并通过 `KENFUTWORK_CUA_HELPER_PATH` 注入固定路径。
- 验证：`pnpm --filter @kenfutwork/web exec vitest run test/cua-permission-platform.test.ts`，7 项通过。

#### 原生 AX、窗口枚举与截图（2026-10-27）

- 协议新增 `apps.list`、`windows.list`、`displays.list`、`ax.tree`、`screenshot.capture`：应用清单、窗口几何、显示器清单、带深度/子节点/节点数/文本长度上限的 AX 树、绑定窗口帧的 PNG 截图与黑帧标记。
- `MacOSApplicationCatalog`：`NSWorkspace.runningApplications`，跳过后台代理；`MacOSWindowCatalog`：`CGWindowListCopyWindowInfo`，含屏幕外窗口与 `onScreen` 标记。
- `MacOSAccessibilityTree`：`AXUIElementCreateApplication` 递归读取 role/title/value/position/size/actions；安全输入框不采集 value；超限时标记 `truncated`。
- `MacOSWindowCapture`：`CGWindowListCreateImage` 按窗口捕获，返回捕获时的屏幕边界；PNG 超限自动缩小，仍超限报 `capture_too_large`；全黑画面标记 `blackFrame`。
- 服务端 `helper-manager` 新增 `applications`、`windows`、`axTree`、`screenshot`，全部经共享 zod schema 校验。
- 验证：`swift test --package-path apps/computer-use-helper`，38 项通过；真实 Helper 集成测试覆盖应用清单、窗口清单、显示器清单、AX 拒绝路径、功能探针与截图权限分支。

#### 输入、剪贴板与执行器接线（2026-10-27）

- 协议新增 `input.click`、`input.type`、`input.key`、`input.scroll`、`input.drag`、`clipboard.read`、`clipboard.write`；按钮、按键、修饰键、滚动单位、拖拽时长均有范围校验。
- 工具面的 `keys` 数组按一个组合键解释（`["command","a"]`、`["⌘","f"]`、`["ctrl","shift","s"]`），支持 command/cmd/meta/ctrl/control/alt/option 及 ⌘⌥⌃⇧ 别名；Helper 的 ANSI 虚拟键表覆盖字母、数字与常用标点，不再只支持功能键。
- `MacOSInputController`：CGEvent 注入鼠标与键盘，输入前激活目标应用；无辅助功能授权时在动作发出前失败关闭；剪贴板使用 `NSPasteboard`。
- `executor-helper.ts` 实现 `ComputerUseExecutor`：应用/窗口解析、AX 观察、截图、元素/坐标点击、文本输入、滚动、拖拽、按键、聚焦、剪贴板读写；元素坐标由最近一次观察树解析，坐标动作必须绑定当前 frameId。截图上限使用 `CuOperationContext.screenshotMaxBytes`，禁止复用进程输出预算。
- 工具面新增 `clipboard_read`（只读）与 `clipboard_write`（计入动作预算并走审批），其余原生能力沿用既有 click/type/scroll/drag/key/focus 工具。
- macOS 插件的原生执行器改为 `macos-helper`，不再由 Node 进程持有 TCC；Helper 缺失或启动失败时工具显式不可用，不回退 A 档。
- 验证：`RUN_CUA_HELPER_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/computer-use/helper-manager.integration.test.ts`，真实 Helper 启动/状态/重启/应用/窗口/观察路径通过。

#### Helper 生命周期与 Windows 边界（2026-10-27）

- 服务端拥有 Helper 生命周期：桌面形态（`KENFUTWORK_EMBEDDED_PG=1`）随壳启动预启动 Helper，其他形态按需启动；设置页 `restartHelper`；插件卸载与进程退出时关闭 Helper。
- Helper 启动参数新增 `--parent-pid`；服务端崩溃或被杀时，Helper 每 2 秒检查父进程，父进程消失后清理 socket 并退出，避免残留 TCC 主体。
- 桌面壳不直接管理 Helper 进程：壳负责启动/停止服务端，Helper 由服务端持有 socket、token 与重启；开发壳在启动时构建 dev Helper 并注入 `KENFUTWORK_CUA_HELPER_PATH`。
- Windows 不需要 TCC Helper：保留 `executor-windows.ts` 的 UIAutomation/截图/输入实现，不请求提权、不自动弹 UAC；目标应用以管理员运行时受 UIPI/安全桌面限制，原语失败按 `native_failed` 返回，由模型或用户决定是否手动以管理员启动目标应用。
- 尚未实现：Developer ID 与公证、打包产物内嵌套 Helper 的签名验证、Windows 真机验收。后续切片按 A.11.1 接续。

### 12.12 测试与验收

#### 12.12.1 协议与单元

- 协议编解码、版本不匹配、超大帧、超时、取消。
- socket token、peer 签名校验、错误权限拒绝。
- 权限状态机：unknown、denied、granted、stale、撤销。
- AX 树归一化、元素索引、窗口绑定、帧绑定、坐标换算。
- 动作 `actionSent` 语义；停止后迟到请求拒绝。

#### 12.12.2 原生集成

- 真实 macOS 应用：列出应用、窗口、AX 树、截图、点击、输入、滚动、拖拽、剪贴板。
- 目标窗口关闭、应用退出、元素替换、窗口被遮挡、黑帧。
- 权限撤销后工具报 `permission_denied`；重新授权并重启 Helper 后恢复。
- Helper 崩溃、服务端重启、主应用退出、孤儿进程清理。

#### 12.12.3 TCC 验收矩阵

| 场景 | 预期 |
| --- | --- |
| 新机器，只授权 Helper | 主应用和 Node 不需要授权；状态变为 granted |
| 只授权 Accessibility | Screen Recording 仍为 denied，截图被拒绝 |
| 只授权 Screen Recording | Accessibility 仍为 denied，AX 动作被拒绝 |
| 授权后重启 Helper | 状态变为 granted，主应用不退出 |
| 撤销 Accessibility | 状态变为 denied；动作失败关闭 |
| Helper 更新，签名身份不变 | 授权保留；状态为 granted |
| Helper 使用 ad-hoc 签名重建 | 可能变为 denied；UI 明确提示重新授权 |
| 其他本机进程连接 socket | 被 peer 签名或 token 拒绝 |

#### 12.12.4 打包验收

- Helper 嵌套签名通过 `codesign --verify --strict`；
- 公证与 staple 通过；
- `spctl --assess` 通过；
- 安装后首次启动只出现 Helper 的 TCC 引导；
- 升级应用后 Helper 授权保留；
- 卸载与重装路径不残留旧 Helper 进程或 socket；
- `dist-manifest.json` 记录 Helper 版本、签名状态、TeamIdentifier。

### 12.13 风险与待确认

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 没有 Developer ID | 用户升级后可能重新授权；Gatekeeper 提示 | 发布前取得 Developer ID 与公证；开发使用固定自签名证书 |
| Swift AX 树移植工作量大 | 与现有 TS 行为不一致 | 先做协议与 fixture 对照；保留 A 档做行为参考 |
| ScreenCaptureKit 最低版本 | macOS 12.0 不支持 | 12.0 使用 CGWindow 回退；12.3+ 使用 ScreenCaptureKit |
| TCC 提示不可自动化 | 用户仍需手动开关 | Helper 提供系统提示、深链和自动重启，不承诺完全免手动 |
| Helper 被其他进程调用 | 本机权限被滥用 | socket 权限、token、peer 代码签名、run lease |
| Helper 更新失败 | 旧进程继续持有权限 | 版本握手、健康检查、退出清理、失败关闭 |
| Windows 提升权限 | UAC 打断流程 | 默认非提升；需要时明确提示，不自动提升 |
| 许可证与来源 | 第三方代码进入仓库 | 只使用 Apple 系统 API 和自写代码；新增第三方依赖按 `legal/THIRD-PARTY-NOTICES.md` 登记 |

需要用户或发布负责人确认的事项：

1. 是否购买 Apple Developer ID 并建立公证流程；不购买则无法承诺升级后不重新授权。
2. 开发签名使用自签名证书还是 Apple Development 证书。
3. 发布 Helper 的最低 macOS 版本是否维持 12.0；ScreenCaptureKit 只在 12.3+ 使用。
4. Windows Helper 是否本期同步实现；建议先完成 macOS，再按同一协议接入。

### 12.14 参考资料

#### 12.14.1 Apple 官方资料

- Accessibility：`AXUIElement`、`AXIsProcessTrusted`、`AXIsProcessTrustedWithOptions`
  <https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrustedwithoptions>
- Screen Recording 预检与请求：`CGPreflightScreenCaptureAccess`、`CGRequestScreenCaptureAccess`
  <https://developer.apple.com/documentation/coregraphics/1454852-cgpreflightscreencaptureaccess>
- ScreenCaptureKit
  <https://developer.apple.com/documentation/screencapturekit>
- CGEvent 输入
  <https://developer.apple.com/documentation/coregraphics/cgevent>
- NSPasteboard
  <https://developer.apple.com/documentation/appkit/nspasteboard>
- LSUIElement
  <https://developer.apple.com/documentation/bundleresources/information-property-list/lsuielement>
- macOS 公证
  <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>

#### 12.14.2 对标产物

- ZCode：`/Applications/ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app`
  - Bundle ID `dev.zcode.cua-helper`
  - TeamIdentifier `8A5X4JJ39T`
  - 独立 Helper、`LSUIElement`、公证、broker socket、Helper 重启
- Codex：`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app`
  - Bundle ID `com.openai.sky.CUAService`
  - TeamIdentifier `2DC432GLL2`
  - 原生 Swift 权限控制、TCC 对话框、系统设置入口、锁屏守卫

上述产物只用于行为与结构参照，不复制代码。

#### 12.14.3 仓库资料

- 本文件（§1–§11 集成设计，§12 为 Helper 实施规格）
- `docs/方案设计/CI-CD与发版方案.md`
- `apps/server/src/features/computer-use/executor.ts`
- `apps/server/src/features/computer-use/build-helper.mjs`
- `apps/desktop/scripts/macos-signing.mjs`
- `scripts/package-mac.mjs`
