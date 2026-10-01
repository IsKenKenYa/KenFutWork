# Computer Use 集成设计(方案稿)

> **角色**:方案稿(CU-A…D 已拍板执行;里程碑 1(P0+P1 macOS 可用回路)已于 2026-10-01 交付,回执见《日志》§六十四)。调研依据见《调研/07-ComputerUse集成调研》,下称《07》。
> **一句话**:以 ZCode CUA 的协议形状为准绳,走内核 `ctx.tools` 注册表交付,执行层「nut-js + JXA 过渡 → 独立 helper 目标态」两档演进,权限/会话/预算语义第一天进契约;桌面形态装配,自托管不装配。
> **边界**:本文只设计 Computer Use(桌面 GUI 操控)轴;Browser 轴(`features/browser` 已有 CDP 基建)另线,不在此展开。

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
┌─ 工具缝(kernel ctx.tools,scope: code)─────────────┐
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

**命名与注册**:工具名 **`mcp__computer-use__<action>`**,注册进内核 `ctx.tools`(命名符合 `kernel/types.ts:232` 的 `mcp__<server>__<tool>` 约定),`scope: "code"`(首发绑定 Code 模式主 agent;Design 模式接入是后续决策)。**不进 `createMainAgentTools` 遗留工具带**——Code/Design 混装问题(《07》§4.1)不允许再添一案;`runtime.ts` 的 `kernelToolRegistry.list(preset)` 过滤天然生效。

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

**模型侧说明**:不改主系统提示。CUA 用法说明做成**内置工作区技能**(`workspace-skills.ts` 机制,按需注入:a11y 优先、坐标纪律、错误恢复),与 ZCode 以 skill 交付同构。

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
| B | 独立 helper 进程 + unix socket broker(换行 JSON RPC + token + 只读分级,照 ZCode 契约形状);AX 读取/截屏/注入/枚举全进 helper | 有(原生性能) | 独立可验签身份;拖拽授权 + inode/ctime/size 指纹 TOCTOU 门 | P2/P3(Windows 可参照其开源 host 三件套) |

**A→B 不换协议**:工具面、观察协议、事件形状全不变,executor 是纯内部缝——这正是 UI-TARS Operator 抽象(《07》§2.2)的教训。

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
- **Consumer**:①`ctx.tools` 工具注册(scope code);②WS display 投影;③设置页治理项。

**治理表新键**(`governance.ts` 唯一属主,禁止字面量):`computerUseActionTimeoutMs`(单动作)、`computerUseObserveMaxBytes`(树 32KB 默认)、`computerUseScreenshotMaxBytes`(256KB)、`computerUseMaxActionsPerRun`、`computerUseSessionMaxMs`;默认值与区间进 `AGENT_GOVERNANCE_DEFAULTS/LIMITS`,`workspace_settings` 可调。

## 9. 分阶段落地

| 阶段 | 内容 | 验收门 |
| --- | --- | --- |
| **P0 协议点亮** | shared 契约(display 投影)→ `features/computer-use/` 服务缝 + 工具组(6 个 ★)注册 ctx.tools(scope code)→ 权限档/automation deny 接线 → 治理键。executor 未装配时全部显式 unavailable | 真机:工具行/操作组/权限行点亮;code preset 才可见;design run 与子代理不可见;typecheck/test 过 |
| **P1 macOS A 档** | nut-js executor(截屏+注入+黑帧检测+权限引导)+ JXA AX 树 + lease/kill switch/actionSent + 内置技能注入 | 真机:计算器全回路(观察树→索引点击→delta 再观察→窗口截图);无 TCC 时工具报 permission_denied 并给出引导;审批档逐动作生效 |
| **P2 观察与治理深化** | delta 观察树、元素索引寻址强化、set_value/select_text/perform_action 等语义动作、剪贴板工具、截图预算全链 | 大树应用(如浏览器/IDE)观察 ≤32KB 裁剪正确;错误码文案全点亮 |
| **P3 目标态与多平台** | B 档 helper + broker(独立签名身份、拖拽授权、TOCTOU 指纹);Windows(UIA+SendInput);anthropic 协议实例叠挂 `tools.computer_20251124` 复用 executor;`deliveryKind: web-remote-replayable`(多端回放) | A/B 档同一工具面回归全绿;Windows 冒烟;DMG 打包线签验通过 |

每阶段一个 PR(行为不变→能力递增),验证命令:`pnpm --filter @kenfutwork/server test` + `pnpm typecheck` + 真机走查;契约改动全量 `pnpm test`。

## 10. 待拍板(承接《07》§6,含本设计的推荐)

| 项 | 问题 | 本设计推荐 |
| --- | --- | --- |
| CU-A | 交付形态 | 内嵌能力缝 + `mcp__computer-use__` 命名(点亮已照搬 UI);第三方 CUA server 未来走 `features/mcp` 用户自配缝 |
| CU-B | macOS 执行层 | A 档(nut-js+JXA)先行,B 档 helper 为目标态;**协议按 B 档形状定死** |
| CU-C | 首个观察通路 | P0 协议先行;P1 落 JXA 文本树(比纯视觉多一档,零原生代码);raster 同版可用 |
| CU-D | 审批粒度 | 逐 mutating 动作 ask 起步;P2 引入会话级授权 + lease 内免逐次(对齐 ZCode 体验) |
| CU-E | anthropic 原生通道 | P3 叠挂,复用同一 executor;不作基座 |
| CU-F | deliveryKind | P3 随多端立项;P0 契约里预留字段避免返工 |
| CU-G(新) | scope 取值 | `"code"` 起步;Design 模式是否开放 CUA(画布助手操控 Figma 类场景)单独拍板 |
