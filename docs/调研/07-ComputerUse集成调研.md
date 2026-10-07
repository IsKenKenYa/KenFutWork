# Computer Use 集成调研:开源生态 × ZCode CUA 链 × 本项目集成方案

> **角色**:调研(只作方向参考,不构成决策;落地结论拍板后写入《改造计划》§6 与《日志》台账)。生成日期:2026-10-01。
> **动机**:为 KenFutWork agent 运行时(Fastify + LangChain 1.x / deepagents,BYOK 多供应商)集成 Computer Use(桌面 GUI 操控)能力选型。用户前期已有一份生态层面调研(2026-09-30,覆盖 UI-TARS/Agent-S/OpenAdapt/OmniParser/browser-use/Blender-CAD MCP 定位与推荐排序),本文在其基础上**下沉到源码级**:浅克隆 4 个代表仓库深读 + 本仓 `references/zcode` CUA 全链精读 + 本项目集成面盘点,回答「原生控制层用什么、协议怎么定、往哪接」。
> **方法**:全部结论来自源码一手阅读,带 `文件:行号` 引用。克隆快照在 `/tmp/cu-research/`(shallow,HEAD 见各节);`references/zcode` 为本仓子模块快照;ZCode 官方插件缓存在 `~/.zcode/cli/plugins/cache/zcode-plugins-official/computer-use/0.6.3/`(下称「插件缓存」)。
> **边界**:只作方向参考,禁止复制代码/schema/字段名(`AGENTS.md` 既有约定);文末「待拍板」是候选清单,不构成决策。

## 0. 结论速览

1. **ZCode 的 Computer Use(下称 CUA)是「开源的壳 + 闭源的核」**:契约(broker RPC/request-access/frame/pip-session 四组 .d.ts)、权限代理(macOS TCC 拖拽引导 + TOCTOU 防护)、REPL 桥接、子代理双层禁用策略、协议事件(display 投影/权限观察)、桌面权限面板**全部 Apache-2.0 开源且成熟**;闭源的是原生 Helper 二进制(`dev.zcode.cua-helper` 独立签名 .app)、被并入闭源包的 51 个 broker server 文件、插件 SDK 与 25 个工具 schema(§2.1)。
2. **动作协议已跨厂商收敛**:ZCode CUA SDK 的模型可见面与 OpenAI Codex 的 `@oai/cua@0.2.4` **逐字同构**(插件缓存 `scripts/computer-use-client.mjs:1-22` 头注释);动作集(`list_apps/list_windows/get_app_state/left_click/scroll/drag/type/set_value/select_text/key/perform_action/paste/request_access/stop`)同时覆盖 Anthropic computer-use 与 OpenAI cua 的能力面,且语义层(set_value/select_text/perform_action)与治理层(request_access/stop、actionSent、controller lease)是 cua 形状的增量。自建工具缝照这个形状设计,即同时兼容三家心智。
3. **a11y(无障碍树)优先是模型无关的关键**:ZCode 把 a11y 树作为主通路(文本进上下文,任意模型可用)、坐标/截图只作兜底(插件缓存 `skills/computer-use/SKILL.md:39-52`);Agent-S 纯视觉、强制配专职 grounding 模型(§2.3);UI-TARS 同为截图+归一化坐标范式(§2.2)。本项目 BYOK 三协议(anthropic/openai-compatible/gemini)现实下,**a11y 文本树是唯一不被供应商锁死的观察层**。
4. **原生控制层有零自研候选**:`@computer-use/nut-js@4.2.0`(字节 fork nut.js,Apache-2.0,darwin/linux/win32 × x64/arm64 预编译)提供截屏+键鼠注入+剪贴板;配套 `@computer-use/node-mac-permissions` 管 TCC 检查(§2.2)。缺口:无窗口枚举、无 a11y 树——正好与 ZCode 闭源的核(AX 读取/事件注入/窗口枚举)重叠,a11y 读取仍需自研(koffi FFI 或 Swift helper)。
5. **Agent-S 不可直接采用**:`eval()`+`exec()` 双重裸执行任意 Python、审批对话框定义了但全仓无调用点、系统提示词内嵌 sudo 密码(§2.3)。OpenAdapt 是「录制→编译→确定性重放→独立验证」的另一物种,18 万行工程且改变产品形态(先演示后重放),不引依赖,但其效果验证协议(VERIFIED 须独立读回证实)值得作为结果上报蓝本(§2.4)。
6. **「Anthropic 原生 computer-use 工具」在现有栈里开箱可用但锁 Claude**:`@langchain/anthropic@1.5.10` 内置 `tools.computer_20250124/20251124`,execute 回调可注入(`dist/tools/computer.d.ts:14-46`)——可作 anthropic 协议实例的加速通道,不能当全平台基座;官方 demo 证实其工具协议是 Anthropic 私有(beta header + 服务端定义 schema),换 OpenAI 兼容网关≈重写循环层(§2.4)。
7. **本项目集成面已备七成,且有明确的「点亮路径」**:工具注册缝、四档权限审批、拒绝记账、图像工件通道、MCP 子系统、治理表全部就位(§4);**web 端 P2/P5 照搬已带入 CUA 渲染链 12 文件、分组聚合、权限动作库与全部 i18n 文案——UI 全就位、零数据**(§4.5)。服务端只要产出 `mcp__computer-use__<action>` 工具名 + MCP CallToolResult 形状 + `kind:"cua"` display 投影三件,即可点亮全部已照搬 UI;自研最小集只需 6 个动作(list_apps/get_app_state/screenshot/click/type/list_windows),diff 观察树可后置(UI 容忍缺失)。

## 1. 生态扫描(gh CLI 快照,2026-10-01)

| 仓库 | Stars | 主语言 | License | 最近 push | 本调研处理 |
| --- | --- | --- | --- | --- | --- |
| bytedance/UI-TARS-desktop | 39,172 | TypeScript | Apache-2.0 | 2026-09-24 | 浅克隆深读(§2.2) |
| simular-ai/Agent-S | 12,460 | Python | Apache-2.0 | 2026-09-05 | 浅克隆深读(§2.3) |
| OpenAdaptAI/OpenAdapt | 1,754 | Python | MIT | 2026-09-26 | 浅克隆深读(§2.4) |
| microsoft/OmniParser | 25,480 | Jupyter | CC-BY-4.0(权重混合) | 2026-07-20 | 不克隆:定位是 grounding 组件,生态调研已覆盖;license 复杂慎入 |
| anthropics/anthropic-quickstarts(已更名 claude-quickstarts) | 17,772 | TypeScript | MIT | 2026-09-30 | sparse 克隆 computer-use-demo(§2.4) |
| browser-use/browser-use | 116,821 | Python | MIT | 2026-09-30 | 不克隆:属 Browser 轴(另线),与 CUA 互补不重叠 |

结论:**第一梯队候选是 UI-TARS Desktop(TS 同栈、产品化最完整)与 Agent-S(研究标杆、架构最简)**;OpenAdapt 是 RPA 型另一物种(录制→编译→验证);Anthropic demo 是「API 原生工具循环」的最小参考。

## 2. 逐仓深读

### 2.1 ZCode CUA 链(本仓 `references/zcode`,Apache-2.0;主集成参照系)

**一句话:控制面(契约/权限/桥接/策略/协议/UI)全开源且成熟;数据面(原生 Helper 二进制 + 51 个 broker server 文件 + 插件 SDK)闭源,是必须自研或外采的空洞。**

**闭源空洞的确切边界**(占位包实现即证据:`packages/zcode-cua/index.js:1-14` 恒返回 unavailable、`broker.js:39-45` 恒 throw、`broker-server.js:24-130` installer 恒 reject——占位包 = 完整 d.ts 契约 + 全部「拒绝实现」):

- **原生 Helper 二进制**:macOS 独立签名 .app「ZCode Computer Use.app」(`dev.zcode.cua-helper`,`broker-helper-constants.js:1-5`),随桌面产品分发于 `resources/cua-helper/` 并 codesign 验签(`packages/desktop/src/main/desktopCuaHelperInstaller.ts:33-49`);职责从契约反推 = a11y 树读取(AX role→kind 映射,`broker-server.d.ts:70-80`)+ 截屏 + 输入注入(错误码 notSettable/notSelectable/foregroundRequired 暗示 settable 元素语义,`broker.d.ts:17-22`)+ 窗口/应用枚举 + 观察树 diff(state_id/changes)+ PiP 悬浮窗。
- **51 个 broker server 文件**:`references/zcode/packages/services/src/cua-permission-broker/index.ts:9-14` 自述 "consolidated into @zcode/zcode-cua"(闭源包)——brokerServer、cuaHelperHost(macOS 生命周期/原子 rename 让渡)、electronNativeBackend、mcpBrokerInjection、helperAppBundle 等;`broker-server.d.ts:94-129` 留有完整接口形状。
- **插件 SDK 与工具 schema**:`setupComputerUseRuntime` SDK、25 个工具的 zod 输入 schema、prompts 均在闭源 plugin(`ZCODE_CUA_PLUGIN_ROOT`);现役形态 node_repl 是唯一 CUA host(旧 Python MCP 形态已退役,`shared/mcp.ts:226-233`、`mcp-config.ts:181-187`)。
- **例外(开源)**:Windows host 生命周期三件套 ~1320 行(`windowsCuaDevRuntime.ts` 等,Node 进程 helper + runtime-manifest SHA-256 校验 + 两阶段状态机)全开源;但 addon 本体仍闭源。

**开源可照搬的层**(全部带源码、成熟):

| 层 | 关键事实 | 位置 |
| --- | --- | --- |
| 契约 | broker RPC = unix socket 上换行分隔 JSON `{id,method,params}→{ok,result\|error}` + 只读分级;socket 路径/env 约定(`ZCODE_CUA_PERMISSION_BROKER_SOCKET`/`_UNAVAILABLE` 是 fail-closed 信号**绝不注空**);request-access 状态(`accessibility: granted\|stale\|denied` + `screenRecording`)、app-associations(16KB 上限)、frame 完整性、PiP 事件(幂等 sequenceNumber/eventId) | `packages/zcode-cua/*.d.ts`、`broker.js:47-57` |
| 权限 | macOS TCC 引导 = 打开系统设置 URL + 用户把 Helper .app **拖**进 TCC 列表(实测拖入 auth_value 直接 2,比弹窗少一步);**TOCTOU 防护**:bundle 指纹 = inode/ctime/size 树(≤512 项),prepare 抓取、dragstart 同步比对;每 stage 重新验签;应用级返回检测 = 轮询 `lsappinfo front` 比 bundle id | `packages/desktop/src/renderer/cuaAccessibilitySettings.ts:2-137,243-305,421-436`、`desktopCuaPermissionIpc.ts:53-63` |
| 桥接 | REPL kernel 注入 `Symbol.for("zcode.node-repl.computer-use-bridge")`;断言 `runtime_scope!=="subagent"`;目标 App 身份从**模型不可写**的 `_meta[zcode.cua/app-associations-v1]` 读(防模型伪造);每 cell 新 Worker 只传二次 token | `apps/zcode-cli/packages/node-repl-host/src/cua-bridge.ts:43-77,111-148`、`cua-broker.ts` |
| 策略 | 「主 agent only」**双层强制**:spawn 期配置校验(子代理请求任何 CUA 工具直接 ConfigurationError,`apps/zcode-cli/packages/core/src/subagent/subagent.ts:834-878`)+ 运行期 scope 断言 | `subagent/computer-use-policy.ts:82-88` |
| 协议 | CUA 工具结果 → `kind:"cua"` display 投影:text ≤32KB、media ≤4 张/单张 ≤256KB/总 ≤512KB、targetApp/permissionStatus 只信宿主写的 `_meta`;request_access 成功 → 一次性权限观察事件;list_apps → Map<pid,CuaAppIdentity>(同 bundle 多进程无 PID 不猜) | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/result-display.ts:237-347`、`cua-app-snapshot.ts`、`cua-permission-observation.ts` |

**设计要点(插件缓存 SKILL/docs 可证,自研必须保留的语义)**:

- **a11y first,坐标最后**:「Accessibility is the primary action path… Coordinates are the last fallback, for canvas, games and Electron content accessibility cannot see」(`skills/computer-use/SKILL.md:39-52`);观察在后台 app 上工作、不抢焦点;`has_image:false` 表示没要像素而非失败(`SKILL.md:57-61`)。
- **逐字同构 Codex cua**:R1 同名同签、R2 Codex 没有的能力只能进可选键或逃逸口、R3 安全语义只藏不删(state_id 强校验、frame 精确栅格、possibly_sent 防重放、controller lease、kill switch)(`scripts/computer-use-client.mjs:1-22`)。
- **`actionSent` 防重放**:动作失败带 `actionSent`(动作可能已到达 app)——非幂等动作只有 `actionSent:false` 才允许重试(`SKILL.md:239-250`)。
- **controller lease 单会话独占**:`CONTROLLER_BUSY` 不可重试、上报 owner(`SKILL.md:252-254`)。
- **观察树 diffing + 索引寻址**:元素按 index 寻址最新观察、重观察重编号、消失元素 fail closed(`ELEMENT_UNAVAILABLE`)、树裁剪保留祖先(`SKILL.md:128-170`)。
- **坐标必须来自当前 raster**:CUA 内部绑定 raster 并 owns 全部坐标变换;元素 bounds 是诊断值禁入坐标(`SKILL.md:190-209`)。
- **平台语义细节**:macOS 窗口行可能来自 AX 或 CoreGraphics 合并,`subrole` 存在与否区分可操作窗口(`docs/computer-use.md:261-276`);Windows 启动非打包应用抢焦点、`include_screenshot=true` 反最小化(`SKILL.md:274-278`)。

### 2.2 UI-TARS Desktop / Agent TARS(ByteDance,TS,浅克隆 `/tmp/cu-research/ui-tars`,HEAD=2ff41a9 2026-09-24)

**仓库现名 Agent TARS**,pnpm+turbo 双 workspace:外层是第一代(`packages/ui-tars/*` sdk/operators/action-parser + `packages/agent-infra/*` 基础设施 + Electron 桌面应用),内嵌 `multimodal/` 独立 workspace 是第二代(tarko agent 框架 + agent-tars 产品 + gui-agent)。

- **原生控制层(本调研最关键的可用性发现)**:字节 fork 的 nut.js 发布为公开 npm 包 **`@computer-use/nut-js@4.2.0`**,原生二进制 `@computer-use/libnut-{darwin,linux,win32}@2.7.1`(x64+arm64,pnpm-lock.yaml:2139-2158),另有 `@computer-use/node-mac-permissions`(macOS 辅助功能/屏幕录制权限检查)。截屏=`screen.grab()`→Jimp 按 pixelDensity 回缩(`packages/ui-tars/operators/nut-js/src/index.ts:52-92`);键鼠=`mouse/keyboard/clipboard` 注入(:111-313;win32 打字走剪贴板+Ctrl+V 再还原 :243-251,hotkey 平台映射 :120-142)。**局限:无窗口枚举、无 a11y 树**——纯「全屏截图+绝对坐标」范式;scroll 只支持上下(:300-311)。
- **可剥离复用**:`@ui-tars/operator-nut-js`(npm 1.2.3)只依赖 sdk 接口+nut-js+jimp,Operator 契约仅 `screenshot()` + `execute(params)` 两方法(`gui-agent/shared/src/base/operator.ts:80-171`)——包成 LangChain Tool 即用,agent 框架可完全不带。
- **模型协议**:传输层纯 OpenAI 兼容(`sdk/src/Model.ts:116-135`,README 明示支持 anthropic provider);**但输出协议是 UI-TARS 动作字符串**(`Thought:/Action: click(start_box=…)`),由 `@ui-tars/action-parser` 解析(`Model.ts:339-345`)——格式假设硬编码在 prompt+parser,不在 API 层;新版 `GUIAgentToolCallEngine` 把动作串伪装成单 tool 参数(`agent-sdk/src/ToolCallEngine.ts:21-57`)。
- **grounding 在客户端解析层**:模型输出归一化坐标(factors 默认 [1000,1000],`sdk/src/constants.ts:10`),`parseBoxToScreenCoords` 换算像素(`sdk/src/utils.ts:29-56`),scaleFactor 全链路透传——**规避 Retina 坐标错位这一头号坑**。
- **主循环护栏**(一代 `sdk/src/GUIAgent.ts:162-209`):截图重试/图片滑窗/maxLoop/截图连续失败计数四重终止;支持 pause/resume/stop。
- **浏览器层**:puppeteer-core(CDP)非 Playwright;hybrid 三策略=GUI/DOM/混合工具注册集差异(`agent-tars/core/.../browser-control-strategies/` + strategy-factory);浏览器能力本身以 MCP server 形态交付(`@agent-infra/mcp-server-browser`),与 LangChain MCP adapter 天然兼容。
- **权限与安全:无审批/危险动作拦截**——只有 OS 级权限引导(`apps/ui-tars/src/main/utils/systemPermissions.ts:6-50`);tarko 的 `onEachAgentLoopEnd` hook(`loop-executor.ts:174-183`)可作自建审批挂点。
- **平台矩阵**:darwin/linux/win32 均有 prebuilt;官方 README 只宣传 Windows/macOS/Browser,未列 Linux 桌面。**许可证全链 Apache-2.0**(nut.js 上游亦 Apache-2.0),无 GPL 传染。测试 128 个单测,但 nut-js operator 本体无单测。

### 2.3 Agent-S / S3(Simular AI,Python,浅克隆 `/tmp/cu-research/agent-s`,HEAD=3aa272d 2026-09-05)

**架构一句话**:S3 是「无层级单 agent」——Worker(主 VLM)每步产出 `agent.click("自然语言描述",…)` 调用,由 OSWorldACI 层用**专职 grounding 模型**(推荐 UI-TARS-1.5-7B)把描述解析成屏幕坐标,拼成 pyautogui 源码字符串交回 CLI 裸 `exec()`(`gui_agents/s3/cli_app.py:155-226`)。

- **执行层**:纯 PyAutoGUI;模型输出 `agent.click("描述")` → `eval()`(`s3/utils/common_utils.py:31`)→ ACI 方法内调 grounding → 返回 pyautogui 代码 → `exec(code[0])`(`cli_app.py:215`)。动作空间 14 个(click/drag_and_drop/scroll/type/hotkey/open/switch_applications/highlight_text_span/set_cell_values/call_code_agent/wait/done/fail),经 `@agent_action` 装饰器 + `inspect.signature` 自动渲染进系统提示词(`s3/memory/procedural_memory.py:74-85`)。
- **观察层**:纯视觉,`pyautogui.screenshot()` 每步一张,**无 accessibility tree**;仅文本高亮走 pytesseract OCR 旁路(`s3/agents/grounding.py:248-327`)。
- **grounding 协议**:grounding 模型当普通 LLM 端点调用,提示词要求只输出坐标,响应 `re.findall(r"\d+")` 取前两个整数再按分辨率线性缩放(`grounding.py:230-246`、`337-344`);CLI 强制必填 5 个 grounding 参数,无 fallback(`cli_app.py:261-297`)。
- **模型要求**:主模型必须视觉 capable;provider 11 种(openai/anthropic/azure/vllm/gemini/open_router/ollama/deepseek/qwen…,`s3/core/mllm.py:22-102`)。
- **安全(代码事实,不可采用的原因)**:`eval`+`exec` 双重动态执行任意 Python、无沙箱、审批对话框 `show_permission_dialog` 定义了但**全仓无调用点**(`cli_app.py:133-145`)、系统提示词内嵌 OSWorld sudo 密码(`procedural_memory.py:110`)、type 动作甚至会生成 `sudo apt-get install xclip`(`grounding.py:429-437`)。
- **无 server 模式**:官方嵌入先例是 CLI 子进程(`integrations/openclaw/agent_s_wrapper.py:41-84`);若要 sidecar 需自写 ~100 行 wrapper 把「predict(出代码)」与「exec(动鼠标)」拆成两步、审批门放 Node 侧。
- **值得借鉴**:①动作空间单一事实源(装饰器+签名自动生成 prompt);②**描述优先动作空间**——主模型永不输出裸坐标,坐标由 grounding 模型执行期解析,主模型与坐标精度解耦、可随意换;③格式校验失败原因回灌重试环 + 动作失败降级 wait(`common_utils.py:59-127`、`worker.py:326-335`);④长上下文轨迹只裁旧图保文本(`worker.py:100-113`)。

### 2.4 OpenAdapt + Anthropic computer-use-demo(浅克隆 `/tmp/cu-research/{openadapt,openadapt-flow,openadapt-agent,anthropic-quickstarts}`)

**OpenAdapt:录制→编译→确定性重放→独立验证的 RPA 型,另一物种**。

- **结构事实**:主仓已退化为 installer+CLI,编译器/运行时在独立仓 openadapt-flow(约 18.2 万行,MIT,2026-09 仍活跃);浏览器录制走 Playwright 页内 DOM 监听(`openadapt_flow/interactive_recorder.py:1-25`),原生录制走独立包 openadapt-capture。
- **编译产物是 JSON 序列化 pydantic IR**(`ir.py`,`Workflow`/`ProgramGraph`,动作带 Anchor 证据:模板图+OCR+phash+结构化定位器);bundle 内的 `workflow.py` 只给人审阅、**永不回 parse 永不执行**(`compiler/codegen.py:1-8`)。
- **平台适配层**:自研薄壳包系统 API——macOS PyObjC+Quartz 读 AX 树(`backends/macos_backend.py:295`)、Windows UIA(经 VM 内 WAA HTTP)、Linux AT-SPI(`linux_backend.py:974-993`;Wayland 默认拒绝);浏览器是 Playwright。
- **验证哲学**:8 类结局,`VERIFIED` 要求「独立 system-of-record 读回证实业务效果」,屏幕横幅说成功不算(`ir.py:3183-3184`、`3277-3279`);CLI 退出码只有 VERIFIED 才是 0。**默认重放 0 次模型调用**(模型只在编译注释/grounding 兜底 opt-in 出场;VLM 故障一律降级 halt,「停机不可能变成错误点击」)。
- **sidecar 可行**:`openadapt-agent serve` 是 MCP stdio;`openadapt-flow serve-execute` 是 FastAPI HTTP(`POST /v1/executions` 202 异步 + Bearer token,`execute/app.py:56-98`)——Node 后端当 HTTP sidecar 调用完全可行。
- **对本项目的定位**:产品形态是「先人工演示一次、之后确定性重放」,与即席对话式 CUA 不同轴;但其**效果验证协议与 fail-closed 纪律**是 agent GUI 操作结果上报的蓝本。18 万行工程量不适合引入依赖。

**Anthropic computer-use-demo:API 原生工具循环的最小参考(约 3800 行,MIT)**。

- **循环**:`computer_use_demo/loop.py:88-241` while 无限循环:`client.beta.messages.create`(带 `betas` header)→ `tool_use` 块交 `tool_collection.run` → `tool_result`(output/error/base64 截图)回填 user 消息 → 无 tool_use 即返回。
- **computer 工具是 API 服务端定义的 beta tool**:客户端 `to_params()` 只发 `{"name":"computer","type":"computer_20250124", display_width_px/height_px}`(`tools/computer.py:88-111`);动作集枚举硬编码在客户端执行侧(`Action_20250124` 约 20 个动作,computer.py:34-44);工具按版本组演进(`tools/groups.py:35-66`,最新 `computer_toolset_20260801` 已 GA、把每个 action 当独立 member tool)。
- **执行侧不用 pyautogui——xdotool 注入 + gnome-screenshot/scrot 截屏**;**坐标双向缩放层**(`scale_coordinates`,computer.py:289-311)把模型输出的截图坐标系坐标与物理分辨率解耦——多模型 grounding 能力漂移下保命的小设计。
- **沙箱形态是容器内虚拟桌面**:Dockerfile 装 `xvfb xdotool scrot mutter x11vnc`(Dockerfile:6-13),用户经 noVNC 旁观容器桌面,**不碰宿主**。
- **Provider 耦合结论**:耦合集中在 loop.py(anthropic SDK、beta header、toolset 私有协议、prompt caching/thinking extra_body);执行侧(xdotool/截屏/缩放/镜像)与坐标层完全 provider 无关。换 OpenAI 兼容网关 ≈ 重写 loop.py 全文 + 把动作集展开成普通 function tools。

## 3. 动作集收敛观察(对 BYOK 的启示)

把五家的「模型可见动作面」对齐后,行业事实标准已成形:

| 能力 | Anthropic computer-use(LangChain 封装) | OpenAI Codex `cua` ≙ ZCode CUA | UI-TARS 系列 | Agent-S ACI |
| --- | --- | --- | --- | --- |
| 观察 | screenshot(模型侧出坐标) | `get_app_state`(a11y 树文本 + 可选截图,支持 diffing) | 截图 + VLM grounding | 截图 + grounding 模型 |
| 定位 | 坐标(x,y) | 元素索引(a11y)/ 坐标兜底 | 坐标(grounding) | 自然语言描述→grounding 坐标 |
| 点击/拖拽 | left_mouse_click/drag | left_click/left_click_drag | click/drag | click/drag_and_drop |
| 键盘 | key/type | key/type/paste | type/key | type/hotkey |
| 语义设值 | ——(靠 type) | **set_value/select_text/perform_action** | —— | —— |
| 应用/窗口管理 | —— | **list_apps/list_windows**(getApp 透明拉起) | ——(OS 级 hotkey) | open/switch_applications |
| 权限/会话 | —— | **request_access/stop**(TCC、controller lease、kill switch) | —— | 定义未接线 |
| 模型要求 | Claude 专用 beta 工具 | 任意模型(a11y 文本) | 视觉模型 + grounding | 视觉模型 + grounding |

**结论**:语义层(set_value/select_text/perform_action)与治理层(request_access/stop、actionSent、lease)是 `cua` 形状相对 Anthropic 原生工具的增量,也是「任意模型可用」的来源。本项目若自建工具缝,**形状向 cua 对齐**;anthropic 协议实例可另挂 LangChain 原生 `tools.computer_20251124` 作加速通道(同一原生执行层,两个模型侧入口)。

## 4. KenFutWork 集成面盘点(现状,全部可回源)

### 4.1 工具注册缝

自定义工具经 `createMainAgentTools`(`apps/server/src/agent/tools/index.ts:81`)注册,在 `apps/server/src/agent/deep-agent.ts:426` 接线进 deepagents 运行时;工具工厂模式(`createXxxTool(deps)`)是既定形状。当前工具清一色 Design 轴(brand-kit/image/video/canvas),Code 轴靠 deepagents 内建(ls/read/write/edit/glob/grep/execute/task)+ MCP。**CUA 工具组的落点就是这里**,且命名不得与 deepagents 内建撞名(已有 `task` 撞名全 run 秒失败的事故,《日志》§五十五补记二)。

### 4.2 权限与审批(已就位)

- 四档权限:default(危险操作 ask)/auto-approve 等,`apps/server/src/features/permissions/permission-service.ts:15-19`;**agent 无自我授权路径,approve 只能由外部审批 UI 调用**(`permission-service.ts:19`)。
- 工具门组合器:`composeToolGate`(模式档 × 权限档,`apps/server/src/agent/tool-gate.ts:22-45`),在 `apps/server/src/features/agent-runs/plugin.ts:88-115` 装配,`permissions.evaluate({toolName, threadId, scenario})` 判定;无人值守轮次走 automation 档。
- 拒绝记账:`tool-denial.ts`——被拦调用对客户端可见、同一工具连续被拒 3 次中止 run(`apps/server/src/agent/tool-denial.ts:21`),防「180 秒重调 2971 次」级空转。
- **CUA 是天然的「危险工具」**:每个 mutating 动作默认进 ask 档,auto-approve 由用户显式开;ZCode 的 controller lease(单会话独占)与 kill switch 语义在本层补齐。

### 4.3 观察流(截图回 UI 的通道已就位)

`stream-adapter` 把 LangChain 流事件适配为 WS 事件,工具产物经 `ToolArtifact`(image:url/mimeType/宽高/placement,`packages/shared/src/artifacts.ts:10-19`)回传;`screenshot-canvas.ts` 已有「截图→blob→imageArtifact」先例。CUA 的 `get_app_state(include_screenshot)` 观察可完全复用该通道。

### 4.4 BYOK 供应商现实

chat 三协议:anthropic(`apps/server/src/providers/anthropic/index.ts`,ChatAnthropic)/openai-compatible/gemini;`@langchain/anthropic@1.5.10` **内置 `tools.computer_20250124/20251124`**(execute 回调注入,`dist/tools/computer.d.ts:14-46`)。含义:①a11y 文本树工具面全协议可用;②Anthropic 原生 computer-use 只对 anthropic 协议实例成立(且要求 Claude 4/4.5 档模型),不能当基座。

### 4.5 web 端接收端(P2/P5 照搬已带大半:「UI 全就位、零数据」)

- `lib/cuaPermissionAction.ts`:逐字照搬(含 TCC 授权返回恢复状态机,generation/epoch/claim 防跨 workspace 误清);`isZCodeCuaToolName` 兼容 `mcp__computer-use__*` 与带 plugin namespace 两种形态(`cuaPermissionAction.ts:9-20`)。
- `ToolCallBlocks/renderers/cua.tsx` + cua*.ts 共 12 文件:完整渲染 **25 个动作**(request_access/list_apps/list_windows/get_app_state/screenshot/zoom/open_application/click×3/drag/mouse_move/type/set_value/select_text/key/hold_key/perform_action/wait/read_clipboard/write_clipboard/stop,`cuaSummaryMessages.ts:6-32`);解析 input(`app_ref{pid,bundle_id}`/`target{type:"element",index}|{type:"coordinate",x,y}`/text/key/duration/region)与结果(`state_id/window/focused_element/changes{added_count,removed_count}`)。
- `cua-group.tsx` + `v4/conversationCuaGroups.ts`:连续 `mcp__computer-use__*` 行聚合成贴底滚动实时操作组(`ENABLE_CUA_TOOL_CALL_GROUPING`);`CuaScreenshotSection.tsx` 从输出递归找 `data:image/...;base64,` 或 `{mimeType,data}` 拼截图;i18n 中英文案齐备。
- `zcode-shared/.../toolDisplay.ts:72-82`:`kind:"cua"` display zod(含 permissionStatus/targetApp/media)。
- `workspaceSidePane.ts` 的 `browser-use` tab 属 Browser 轴(另一条链),勿混。
- **服务端点亮所需最小数据形状(反推)**:①工具名 `mcp__computer-use__<action>`(尾部 action 决定渲染分支);②输出为 MCP CallToolResult 形状(`content[{type:"text"}|{type:"image",mimeType,data(base64)}]`、`isError`、`structuredContent{error{code,suggested_action}}`,错误码沿用 element_stale/element_unavailable/foreground_required 有专属文案);③display 投影 `kind:"cua"` + `targetApp/permissionStatus/media`;④request_access 结果内嵌 permissionStatus 即点亮权限行与恢复流程。**diff 观察树缺失 UI 容忍。**

### 4.6 MCP 子系统(可选交付形态)

`features/mcp/`:用户可加 stdio MCP server + 精选目录(`curated-catalog.ts` 现有 filesystem/fetch/git/memory/sequential-thinking/time/sqlite/github/everything,无 CUA 同类)。ZCode 官方即以「插件 MCP server + `mcp__computer-use__*` 工具名」交付 CUA。**若以 MCP 形态交付,审批/截图流/权限面板需另接**,不如原生工具缝直连权限档与 ToolArtifact——MCP 形态留作后续「第三方 CUA server 接入」的通用缝。

### 4.7 运行形态与治理

- 桌面形态(Tauri 内嵌 Node 服务端)是 CUA 唯一有意义的目标:服务端进程就在用户桌面旁,具备控制条件;**自托管/Docker 形态下 CUA 默认不装配**(控制的是服务器侧桌面,无意义且危险)——这符合「能力缝 fail loud」纪律:桌面 profile 才注册 CUA 服务。
- 运行时可调数值(动作超时、观察节流、会话最长时长、最大连续动作数等)唯一属主是 `packages/shared/src/governance.ts`(`AGENT_GOVERNANCE_DEFAULTS/LIMITS`),禁止业务代码字面量(AGENTS.md DEC-18 节)。

## 5. 集成方案(建议,分阶段)

**推荐路线:协议先行点亮 UI,原生层「nut-js 起步 + a11y 自研补强」,安全语义第一天进契约。**理由:ZCode 壳(契约/权限/协议/UI)开源可参照而核闭源;`@computer-use/nut-js` 把截屏+键鼠注入变成纯依赖问题(Apache-2.0 预编译);本项目 web 端已照搬的 CUA 渲染链只等三件数据形状;Agent-S/UI-TARS 的 agent 框架与安全模型不适配,不引入。

- **P0(协议点亮层,纯服务端,无原生代码)**:
  - `features/computer-use/` 能力缝(Service Definition + Provider + Consumer 三元组,遵循插件化纪律):内嵌「虚拟 computer-use MCP server」,工具按 `mcp__computer-use__<action>` 命名注册(对齐已照搬 UI 的解析与分组),输出 MCP CallToolResult 形状,display 投影 `kind:"cua"`(targetApp/permissionStatus/media)。
  - 最小动作集 6 个:`list_apps/list_windows/get_app_state/screenshot/click/type`;原生层未就绪时全部显式报 unavailable(**fail loud,不摆空壳**,对齐「未安装插件不摆空壳入口」的产品不变量)。
  - 权限接线:`mcp__computer-use__*` 前缀入 default 档(逐 mutating 动作 ask);截图经 ToolArtifact 通道回传;超时/上限进 `governance.ts` 治理表。
  - 验证:真机上 CUA 工具行、贴底操作组、权限行全部点亮(数据可为 stub)。
- **P1(原生层,macOS 先行)**:CU-B 二选一——
  - 路线 a(快):`@computer-use/nut-js` 进服务进程(截屏+键鼠+剪贴板+TCC 检查零自研);TCC 授权主体=桌面服务进程本身。缺 a11y 树与窗口枚举——观察层退化为截图+坐标,依赖模型视觉能力。
  - 路线 b(正,推荐目标态):照 ZCode 契约做**独立 helper 进程 + unix socket broker**(换行 JSON RPC + token + 只读分级照契约形状);helper 内做 AX 树读取(koffi FFI 或 Swift 小进程)+ 截屏 + CGEvent 注入 + 窗口枚举。安全边界清晰:授权主体独立可验签、崩溃不连累宿主、升级换身份即失效;但工程量与分发(签名/公证,mac DMG 打包线九条坑另见记忆)重。
  - 两条路线不互斥:a 作为 P1 交付、b 作为 P2 演进;工具面协议不变,换执行端不动模型侧。
- **P2(会话治理与观察增强)**:controller lease 单会话独占、kill switch、`actionSent` 防重放、观察树 diff(state_id/changes,UI 已能消费)、raster 绑定坐标纪律、截图预算(inline/display 上限与 raster 不可见降级文本)、「主 agent only」双层强制(spawn 期配置校验 + 运行期 scope 断言,接现有 subagent 派发缝)。
- **P3(多平台与加速通道)**:Windows(UIA+SendInput;ZCode 的 Windows host 三件套开源可参照)、Linux(AT-SPI+XTest,优先级按用户群);anthropic 协议实例可叠挂 LangChain 原生 `tools.computer_20251124` 复用同一执行层;多端形态补 `deliveryKind: web-remote-replayable`(Web/移动端回放观察,截图序列即回放数据)。
- **明确不做**:裸 eval/exec 执行模型生成代码(Agent-S 模式);把 CUA 交给子代理;自托管/Docker 形态开放 CUA(桌面 profile 才装配,fail loud);为 OmniParser 引入 CC-BY-4.0 权重依赖;引入 OpenAdapt 18 万行依赖(只借验证协议思想)。

**风险与开放问题**:①macOS TCC 引导体验(系统设置跳转 + 拖拽授权 + 返回确认)是易碎环节,ZCode 为此做了指纹 TOCTOU 门与多窗口会话协调,路线 b 需对齐;②nut-js 路线的 TCC 主体是服务进程,签名/公证变化即失效,且无法「拖拽授权」引导(只能弹窗),体验差一档;③a11y 树对 Electron/自绘 UI 盲区,视觉兜底(截图+归一化坐标+双向缩放)必须同版可用——UI-TARS 的 `parseBoxToScreenCoords` 与 Anthropic demo 的 `scale_coordinates` 是两个可直接借的坐标纪律实现;④截屏进上下文的隐私面:默认只截目标窗口、权限档文案明示;⑤归一化坐标协议(模型输出 [0,1000]² 还是像素)必须在 P0 契约里定死,后改等于换协议。

## 6. 待拍板清单(候选,不构成决策)

- CU-A:CUA 交付形态——内嵌能力缝 + 虚拟 MCP server 命名(§5 P0,推荐)vs 真走 `features/mcp` 外挂 stdio server(复用用户自配缝,但审批/截图流要另接)。
- CU-B:macOS 原生层——nut-js 进程内(快、TCC 主体=服务进程)vs 独立 helper + broker(正、工程重)。建议 a 起步 b 演进,但**P0 契约按 b 形状定**(broker RPC 照 ZCode 契约),避免路线切换换协议。
- CU-C:首个观察通路——a11y 树优先(模型无关,随路线 b)vs 截图+坐标 MVP(随路线 a,依赖视觉模型,BYOK 下体验按供应商漂移)。
- CU-D:动作审批粒度——按工具前缀(粗,好做)vs 按 mutating 动作逐次(ZCode 语义)vs 会话级授权 + lease(用户开一次,lease 内免逐次,推荐目标态)。
- CU-E:anthropic 协议实例是否叠挂 LangChain 原生 computer-use 通道(与自建面并存,复用同一执行层)。
- CU-F:`deliveryKind` 双形态(desktop-continuous / web-remote-replayable)何时立项——多端产品两种都要,早定可避免截图/事件协议返工。

## 7. 实测记录(2026-10-01,本机 macOS darwin 27.2.0 arm64)

**A. ZCode CUA 目标体验(全链通过)**:经 node_repl 引导 SDK 实测——①`requestAccess` 返回完整授权链:helper 为独立签名 .app(`dev.zcode.cua-helper` v3.14.4,Developer ID 签名 + TeamIdentifier,安装于 `~/.zcode/computer-use/`),印证 §2.1「路线 b」架构;②`listApps` 返回 9 应用结构化清单(pid/bundle_id/name/active);③绑定 `com.apple.calculator`(未运行自动拉起)→ a11y 树 48 元素全文本化(按钮/显示值/菜单),`has_image:false` 纯文本观察;④按元素索引点「7」→ 显示字段变 7,**a11y 动作不经坐标**;⑤再观察自动 delta 快照(`snapshot_mode:"delta"`,树 48→46);⑥`getScreenshot` 只截目标窗口(230×408 与 bounds 一致,`actionable:true` raster 绑定)。**体验结论:观察文本化、动作语义化、截图窗口化,delta 树真实工作——这就是要复刻的目标形态。**

**B. `@computer-use/nut-js` 原生层候选(装包+截屏通过,两个坑实证)**:npm 安装干净(129 包/36MB,`libnut-darwin` 预编译 .node 就位);`screen.grab()` 82ms 返回 1920×1080 真实像素。**坑①**:`getAuthStatus` 报 `accessibility:denied`、`screen:denied` 但截屏仍拿到真实像素——TCC 查询与实际捕获能力**不一致**(疑似走遗留捕获 API 或 TCC 身份判定口径差异),集成时**不能只信权限查询,必须做黑帧内容检测**(UI-TARS 的像素采样做法是对的);**坑②**:`screen.width()/height()` 走 AX API,无辅助功能权限时刷 stderr 警告(静默降级不抛错)。输入注入未测(accessibility denied 下预期失败,且向用户会话注入输入需明确授权场景)。

**C. 未测项与理由**:Agent-S 需专职 grounding 模型端点+API key,且 §2.3 已判定不可直接采用;Anthropic demo 需 Docker + Claude key 且目标是 Linux 容器虚拟桌面(非 mac 宿主),与桌面形态诉求不符;OpenAdapt 是录制→重放形态,与本产品即席对话轴不同。

---

*调研笔记原文:`/tmp/cu-research/notes/{ui-tars,agent-s,openadapt-anthropic,zcode-cua}.md`(临时目录,会话级);生态层定位与 Blender/CAD MCP 轴见用户前份调研(2026-09-30),本文不重复。*

