# SAG2 本地知识库插件规划

> 角色：**方案规划（已定稿）**（参考级，非权威）。落地回执写《日志》台账，架构级决策登记走《改造计划》§6。
> 状态：**已定稿 + 实施中**（2026-11-08 成稿；同日用户授权本代理拍板，§10 的 `KB-1`…`KB-8` 已全部收敛为单一方案，无待决项；架构级结论已登记 `DEC-26`（拍板晚于法务 `DEC-24`，顺延））。**进度：M0 / M1 / M2 已完成**，事实核验、6 条偏差与 M2 追加结论见 `apps/server/src/features/knowledge/M0-核验记录.md`；M3 起未开工。**KB-3 的自动注册时机已按 M2 核验调整**：服务端没有「不依赖 run 的全局工作区根」服务，故改为首次检索时按 run 的真实工作目录幂等注册（§4.3）。
> 需求来源：2026-11-08 用户口径（§1.1）。
> 证据口径：本稿区分**一手事实**（SAG-Wiki 官方 README／架构设计／CLI 文档／内置 MCP 工具文档，以及本仓源码 `文件:行号`）与**二手材料**（公众号实测与宣传数字）。二手数据只作背景，**不作为验收指标**，见 §1.5。

## 0. 结论速览

| 决策点 | 定稿结论 | 依据 |
| --- | --- | --- |
| 交付形态 | **双层**：宿主内核插件 `features/knowledge/`（真能力）＋ 市场 bundle 插件 `plugins/knowledge/`（安装开关＋侧边栏面板） | §2；市场插件能力面给不了文件系统与子进程 |
| 上游接入面 | **只用 `sag` CLI 的 `--json`**，不连 MCP、不逆向私有 service 协议、**不做 Jev 桥** | §3.1–§3.4；官方 `mcp-tools.md` 明示内置 MCP「不暴露 HTTP 端口、不启动另一个程序」 |
| 是否自研 SAG2 内核 | **不自研**。只接上游 CLI；`KnowledgeService` 接口本身即替换缝，不写占位 Provider 类 | §2.2／KB-6 |
| 「无论什么模式」 | 提示段 `scope: "always"` ＋ 工具 `scope: "shared"` ＋ 面板 `scope: "shared"` ＋ `pre-step` 不按 preset 过滤 | §1.2／§2.4；运行时只有 `design`／`code` 两个 preset |
| 「优先调用」 | **宿主每轮自动检索并注入证据**，不依赖模型主动选工具；置顶提示段＋shared 工具＋相关性门槛作补充 | §1.3／§6 |
| 安装即生效 | 内核插件恒挂载、运行期按安装态**动态门控**；安装时完成凭据注入与 CLI 探测，**首次检索时按 run 的真实工作目录**幂等注册知识库根（无需用户操作）；装／卸下一轮即生效，无需重启 | §2.3／§4.3／KB-3 |
| 侧边栏 | bundle 清单声明 `slot: "sidebar"`，面板数据走宿主 `/api/knowledge/*`（不走 bundle 私有路由） | §5 |
| 凭据 | **宿主 `modelProviders` 为唯一权威源**；SAG 侧未配置时用 `sag config --key-stdin` 注入一次；已配置则复用、绝不覆盖；不做 Jev 协议桥 | §3.4／KB-1；`DEC-7` |
| CLI 分发 | **三级探测**：复用本机已装 `sag` → 按需下载钉版本＋校验和 → 离线安装指引 | §3.3／KB-5 |
| 许可证 | 上游 MIT × 本仓 GPL-3.0 可组合；随包／按需下载二进制须同 PR 登记 `THIRD-PARTY-NOTICES.md` | §9.1 |
| 验收指标 | 只用本仓 §8 自定场景，**不采信公众号的 7000 倍／Recall 数字** | §1.5 |

## 1. 需求与边界

### 1.1 需求（用户口径，按出现顺序）

1. 用 **SAG2** 做一个**本地知识库插件**。
2. 插件入口放在**侧边栏**。
3. **只要插件安装了，无论什么模式，都优先调用**。
4. 计划成果落在 `docs/插件/` 下（本稿）。

> 第 3 条是本次定稿的主导约束：凡是会让「装完还要再配一步才能用」的方案，一律不选。这直接决定了 KB-1（不在终端手输 key）、KB-3（不手动加目录）、KB-5（复用本机已装 CLI）三条。

### 1.2 「无论什么模式」在本仓的准确含义（实测）

| 层 | 事实 | 位置 |
| --- | --- | --- |
| 运行时 preset | 只有 `design`／`code` 两个。`PromptCompositionContext.preset` 与 `PreStepPayload.preset` 都是二元 | `apps/server/src/kernel/types.ts:223,306` |
| Work／Flow | 不是新 preset。`Code → Design → Work → Flow` 是 **Code 壳内的主区视图**，壳恒为 `CodeWorkbenchFrame` | `apps/web/src/components/workbench/workbench.tsx:25-29`；`host/WorkbenchModeNavigation.tsx:18-21`；`AGENTS.md:92` |
| 提示段 | `always` 恒挂；`design`／`code` 按 run preset 过滤，order 升序 | `kernel/types.ts:276-277,339-348`；`kernel/context.ts:721-732` |
| 工具 | `ToolScope = design \| code \| shared`，`shared` 恒可用 | `kernel/types.ts:273-274` |
| 插件面板 | `projectPluginPanels()` 过滤：`!mode \|\| !scope \|\| scope === "shared" \|\| scope === mode` | `packages/shared/src/plugin-contracts.ts:327-351` |
| UI 槽位 | `PLUGIN_UI_SLOTS = sidebar / conversation / canvas / settings`，`sidebar` 注释「Code / Design 共用同一条侧栏」 | `packages/shared/src/plugin-contracts.ts:65-102` |

结论：**不需要为四种模式各写一套实现**。覆盖 `always` + `shared` + 不按 preset 过滤的 `pre-step` 即可全覆盖。

已知小瑕疵（M4 顺手修，不是阻塞）：ZCode 壳读侧栏面板时把 mode 硬编码为 `"code"`（`host/platform.ts:128`、`code-workbench-frame.tsx:59`）。因工作台恒为 Code 壳且 `shared` 不被过滤，本插件仍可见；但语义上应改用真实 surface mode。

### 1.3 「优先调用」的准确含义与实现选择

用户要的是「装了就一定先过知识库」，不是「模型可以选一个知识库工具」。仓库现状决定了后者根本做不到：

- `ToolDefinition` **没有 priority／order 字段**，`ToolRegistryImpl.list()` 按插入序，不存在「让某工具最高优先级」的 API（`kernel/types.ts:455-487`、`kernel/context.ts:333-341`）。
- 第三方 bundle 插件工具被强制 `exposure: "deferred"`（`features/plugins/compat-context.ts:282-295`）。
- 第三方 `promptFragments` 没有 order／scope，只能被拼进 order 300 的 `workspace.rules-and-plugins`（`features/agent-runs/prompt-sections.ts:101-128`）——**置顶不了**。
- 但存在 `pre-step` waterfall 事件缝（`DEC-1`），在 `buildUserMessage(...)` 之后、`userMessage` 构造之前每轮触发三次分支（`agent/runtime.ts:2583,2665,2687`），可改写 `input`；第三方可经 `agent/pre-step` 别名订阅（`features/plugins/capability-binding.ts:140-146`）。

因此采用**宿主级自动 preflight**为主：每轮用户输入送进模型之前，宿主自己先跑一次 SAG2 检索、把证据注入上下文。工具只是给模型「再深挖一层」的补充。这才是字面意义的「优先」。

### 1.4 上游事实（SAG2／SAG Wiki 一手资料）

| 主题 | 事实 | 来源 |
| --- | --- | --- |
| 定位 | 本地文件知识库；原文留在用户目录，不落库副本 | SAG-Wiki README；`docs/en/architecture.md` |
| 索引 | SQLite FTS5 BM25，`content=''` 只存词项与位置；**无 embedding、无 LLM 调用、无 GPU**；chunk ≈512 字符、重叠 ≈80 字符，保留标题路径与行列位置 | 架构设计「Storage」「File ingestion」 |
| 检索 | BM25 召回 → Jev 证据判定 → term expansion 迭代 → 本地多样性排序（`core/src/retrieval.rs`、`sag2_v10.rs`） | 架构设计「SAG2 semantic retrieval」 |
| 增量 | 文件监听合并增量任务；跳过未变文件；读结果时回原文件校验 hash，变了请求重索引；`.gitignore`／`.sagignore`；符号链接不扩权 | 同上 |
| 快速检索 | 纯本地 FTS5 BM25，**不需模型／密钥**；语义检索与 Q&A 才需要模型 | 同上「Quick search」 |
| 模型依赖 | 语义检索需 Jev service（默认 `https://api.302ai.cn/typesafeai/v1`，模型 `jev-latest`）；引用式 Q&A 另需 answer model。原文片段会发往用户配置的服务 | README；`docs/en/cli-and-harness.md` |
| 服务形态 | `sag service serve` 只监听 `127.0.0.1` **随机端口 + token**，元数据在 `sag-service.json`；`protocol/` 是私有 crate；单帧 128 KiB、完整消息 64 MiB；不同 build 不静默混用；20 并发检索 | 架构设计「Processes」「Concurrency」 |
| 内置 MCP | 六个只读工具（`sag2_` 前缀），**同一 Rust 进程内**给自家 answer model 用：「does not expose an HTTP port or start another program」 | `docs/en/mcp-tools.md` |
| Agent 接入 | README 明写 **「Agent access: CLI and a ready-to-install Skill」**，支持 Claude Code／Codex／OpenCode；**未提及对外 MCP server／SDK／公共 HTTP API** | README |
| 稳定性 | `sag ... --json` 有稳定语义：`list`／`check`／`add`／`remove`／搜索；`check --json` 的 `coverage` 为 `included/partial/none/excluded`，退出码 0／1／2 | `docs/en/cli-and-harness.md` |
| 配置复用 | CLI 与桌面**共享**索引、检索实现、用户数据目录、`sag.sqlite`、密钥与忽略规则；「Existing usable API Key or no-authentication settings are reused automatically」 | `docs/en/cli-and-harness.md`「Sharing with desktop」 |
| 文件类型 | Markdown／纯文本／RTF／Office／表格／EPUB／文本型 PDF 默认启用；**M0 已核实 `FileTypes::default()` 为 `code:false, config:false`，代码与配置文件默认不索引**，需 `sag add --types` 显式指定 | `protocol/src/types.rs`；`cli/src/main.rs` |
| CLI 输出字段 | `list` 顶层是数组；`check/add/remove/search/match --json` 的精确 serde 键名与退出码 0/1/2/130 见 `apps/server/src/features/knowledge/M0-核验记录.md` §1。**`sag status` 不输出 JSON**，只列文本 | `protocol/src/cli.rs`；`cli/src/main.rs` |
| 平台／体积 | npm 包 `@zleap-ai/sag` 仅含 macOS Apple Silicon 与 Windows x64 原生二进制；桌面约 14 MB；`SAG_DATA_DIR` 可隔离数据目录；**已钉版本 0.1.8** | README；CLI 文档；npm registry |
| 许可／论文 | MIT；论文 arXiv:2610.22588；复现代码 `Zleap-AI/SAG-Benchmark` | README |

### 1.5 二手材料口径（重要）

用户提供的公众号文章里的 2.36 秒建库／7000 倍、11,656 段、MuSiQue Recall@5 80.68%、EnterpriseRAG-Bench 81.10%、10 万篇维基、144s→95s、以及「DeepSeek V4.1 Flash」等模型名，均为**作者实测或宣传口径，本仓未复现**。本稿只取其中的**问题场景**（多跳线索、代码排错、大部头研报）作为验收用例灵感，**任何数字都不写进验收指标**。验收以 §8 自定场景为准。

### 1.6 三个「不做」

1. **不做 MCP 接入**：上游内置 MCP 不对外，外部 agent 连不上；凭空写「接入 SAG MCP server」会做出一个不存在的接口。
2. **不做向量库／GraphRAG 兼容层**：SAG2 的价值恰是不预处理、不 embedding；再叠一层 RAG 是把成本加回来，与需求相反。
3. **不复用 `flow/` 的 Dify 知识库**：`flow/gateway/src/knowledge/*` 是 Dify Console／Service API 的转发与状态呈现，独立引擎、独立数据（`AGENTS.md:11` 标为待合并子系统）。两者并存、不合并，且同一 run 只允许一个自动 preflight 源（KB-8）。

## 2. 总体架构（双层插件）

### 2.1 分层

```text
┌─ 市场 bundle 插件 plugins/knowledge/ ──────────────────┐
│  package.json（ui: slot=sidebar, scope=shared）          │
│  cordis.patch.yml（inject: [ui]）                       │
│  index.js → ctx.ui.register(...)                        │
│  assets/panel.html → iframe 侧边栏面板                   │
│  作用：安装开关 / 设置入口 / 状态与检索 UI                  │
└──────────────────┬─────────────────────────────────────┘
                   │ 面板数据走宿主 HTTP（不走 bundle 私有路由）
┌──────────────────▼─────────────────────────────────────┐
│  宿主内核插件 apps/server/src/features/knowledge/         │
│  apply(): ctx.register("knowledge", service)             │
│           ctx.get("systemPrompt").register(置顶段)        │
│           ctx.get("tools").register(shared 工具)          │
│           ctx.on("pre-step", 每轮 preflight)  ← 优先调用  │
│  mounted(): registerKnowledgeRoutes(...)                 │
│  init(): 自动注册当前工作区根 + 凭据 stdin 注入（KB-1/3） │
│  Provider: SagCliProvider ── spawn `sag ... --json`      │
└──────────────────┬─────────────────────────────────────┘
                   │ 子进程 / 本地 127.0.0.1 service
┌──────────────────▼─────────────────────────────────────┐
│  @zleap-ai/sag CLI（Rust core + SQLite FTS5 索引）        │
│  本地文件（原文不动） + Jev 证据判定（TypeSafe 云侧）       │
└────────────────────────────────────────────────────────┘
```

**为什么必须双层**：市场 bundle 插件受硬边界约束——能力面只有 `tools / systemPrompt / routes / ui / storage`（`features/plugins/capability-binding.ts:12-21`）；门禁禁止 `child_process`、`node:fs` 等字面 import（`features/plugins/module-scan.ts:32-44`）；bundle 不能带 npm 依赖（`features/plugins/bundle-source.ts:49-80`）；安装／卸载／停用都要管理员（`apps/server/src/http/plugins.ts`）。它**起不了 `sag` 子进程、拿不到文件、注册不了 order 可控的提示段**，只能当开关与 UI。真能力必须在宿主内核侧（先例：`docs/插件/语音助手插件规划.md` §1.3 得出同样结论）。

### 2.2 能力缝三元组

按 `AGENTS.md:33`「只写实现不声明接口与消费方的半个缝不允许合入」：

| | 内容 |
| --- | --- |
| **Service Definition** | `features/knowledge/types.ts`：`KnowledgeService`（M1 骨架为 `isActive() / status()`，M2 补 `listRoots / addRoot / removeRoot / check / search / read`）；证据对象按上游 CLI 真实字段归一化为 `path / absolutePath / startLine / endLine / heading? / content? / matchedLines?`——**没有** offset/length/sourceId/fileVersion，那些只存在于 core 内部 `Candidate`，不进 CLI JSON（见 `apps/server/src/features/knowledge/M0-核验记录.md` §1） |
| **Service Provider** | `SagCliProvider`（默认，调 CLI `--json`）；`DisabledProvider`（未安装／不支持平台，返回显式状态而非静默 null）。**只有这两个真实实现，不写 `NativeSag2Provider` 占位类**——接口即替换缝（KB-6） |
| **Consumer** | ① `pre-step` 每轮 preflight ② 置顶提示段 ③ `shared` 工具 ④ `/api/knowledge/*` 路由 ⑤ 侧边栏面板 |

> 新增服务 key `knowledge` **只改《改造计划》§4.2 一处**（`AGENTS.md:34`；`docs/README.md` 单源原则与机械校验规则 6⑤）。本稿不复述 key 清单。

### 2.3 安装态动态门控（「装了就生效」）

内核插件**不写 `enabled` 门**——`plugin.enabled?.(env) ?? true`（`kernel/compose.ts:58`），即恒挂载提供能力缝；真正的开关放在运行期：

| 缝 | 门控方式 | 未安装时行为 |
| --- | --- | --- |
| `pre-step` | 监听器首行查 `ctx.get("plugins")` 的安装且启用态 | 立即 `next(payload)`，零开销 |
| 提示段 | `resolve()` 返回 `null` | 本 run 不出现该段（`kernel/types.ts:337`） |
| 工具 | `registerDynamic` per-run 解析，按安装态返回空／全量 | 工具不可见 |
| HTTP 路由 | 状态接口恒在（供面板显示「未安装」）；其余接口返回显式状态 | 不静默 404 |
| 初始化 | 自动注册工作区根／凭据注入**只在安装态由 true 变为 false→true 时执行一次** | 未安装不碰 SAG 配置、不碰索引 |
| 侧边栏面板 | 由 bundle 自身的安装态决定可见性 | 面板不出现 |

先例：`features/agent-runs/plugin.ts:110-111` 注释「插件段闭包自取——装／卸载下一轮即生效」。因此**装／卸不需要重启服务**。

与「配置 fail loud」硬约束（`AGENTS.md:36`）的边界：**未安装是正常态**，不是 misconfiguration；而 CLI 缺失、JEV 未配置、索引未就绪、平台不支持都属 misconfiguration，必须在状态接口与侧边栏**显式报错**，禁止静默降级成「模型凭记忆作答」。

### 2.4 全模式优先调用的四层保险

| 层 | 机制 | 覆盖 |
| --- | --- | --- |
| 1（主） | `pre-step` waterfall 自动检索＋证据注入，不按 preset 过滤 | 所有 run，包括 Work／Flow 壳内视图 |
| 2 | `PromptSectionDefinition { name: "knowledge.preflight", order: -50, scope: "always" }` | design／code 全 preset；排在 base(-100) 之后、模式段(75/0)、skills(200)、规则与插件(300) 之前 |
| 3 | `knowledge_search` / `knowledge_read` / `knowledge_status`，`scope: "shared"` | 模型主动深挖多跳线索 |
| 4 | `ui: [{ slot: "sidebar", ... }]` + `scope: "shared"` | 侧边栏常驻，人可直接检索 |

## 3. 上游接入契约

### 3.1 唯一稳定契约：`sag` CLI `--json`

`docs/en/cli-and-harness.md` 给出的机器可读面：

| 用途 | 命令 |
| --- | --- |
| 服务与配置状态 | `sag status`、`sag service status`（**不会自动起服务**）、`sag config` |
| 目录清单 | `sag list --json` |
| 覆盖检查 | `sag check /path --json`（`coverage` 四值；退出码 0 正常 / 1 非正常 / 2 参数或执行错误） |
| 增删知识库根 | `sag add /path --json`、`sag remove /path --json` |
| 语义检索 | `sag "<query>" --path /path --json -m 5`（默认 10 chunks，`-m` 1–100） |
| 取正文 | `-c`（**只有 `-c` 才返回 `content`**） |
| 本地降级匹配 | `-E` 正则 / `-F` 固定串（纯本地、不需模型／密钥） |
| 配置 Jev | `sag config --url ... --model ... --auth none`；`--auth bearer --key-stdin` |
| 服务生命周期 | `sag service stop` / `restart` |

注意：搜索**没有 `search` 子命令**，`sag "查询"` 即搜索；`add/remove/list/check/status/config/service/install/uninstall` 是保留词，查这些字面词要用 `--`。query 限 1–2000 字符。JSON 输出含绝对路径、行号、实际范围与截断标记——**具体字段名未在官方文档列全，M0 必须做协议探针锁定并写成 zod schema + fixture，不臆测**。

### 3.2 为什么只走 CLI

- 私有 service 协议：随机端口 + token，`sag-service.json` 发现，`protocol/` 未公开，不同 build 不静默混用。逆向它等于把插件绑死在某个未承诺的内部版本上，上游一升级即碎。
- 内置 MCP 不对外（§1.4）。
- CLI 是 README 明确承诺给 agent 的入口，且 `--json` 有退出码语义，可测试、可回归。
- **同理不做 Jev 桥**：`state` / `questions` / `answers.*.noul` 只有一句约束、无完整公开 spec；为一个未承诺的协议写适配层，等于把上面这条判断自己破一次。见 §3.4。

### 3.3 分发与平台矩阵（KB-5 定稿）

**定稿：三级探测，不二选一。**

1. **复用本机已装 `sag`**：按上游安装记录与 PATH 探测；CLI 与桌面共享 `sag.sqlite`／配置／忽略规则，复用可避免重复索引、重复配置，也尊重已装 SAG Wiki 桌面端的用户。
2. 未安装则**按需下载钉版本 + 校验和**。**M0 已核实：仓库没有统一的运行时下载服务**（`ServiceMap` 无此类 key、无 `*download*.ts`），故按 `features/voice/model-store.ts` 与 `features/work/install.ts` 的范式自建一个轻量下载器（staging + sha256 + rename 原子落位 + `ready|missing|downloading|error` 状态），不进 git、不进仓库产物。
3. 两者都失败（如离线首启）→ 状态接口标记 `cli_unavailable`，面板给出一键复制的离线安装命令，**不静默关闭功能**。

| 平台 | 上游二进制 | 策略 |
| --- | --- | --- |
| Windows x64 | 有（npm 包自带） | 一等支持，本仓主形态 |
| macOS Apple Silicon | 有 | 一等支持 |
| macOS Intel / Linux 自托管 | **无** | fail loud：状态接口标记 `unsupported_platform`，面板给出明确原因 |

测试用 `SAG_DATA_DIR` 指向隔离目录，避免碰用户真实知识库。

### 3.4 凭据边界（KB-1 定稿，`DEC-7`）

本仓 BYOK 的唯一规范是《改造计划》§4.8（`DEC-7`）：凭据经 `modelProviders` 私有凭据接口解析，明文存数据根目录凭据文件，不进日志／普通事件／运行快照。SAG CLI 自己也有一份私有 key 文件（Unix 0600，由 `sag config` 管理）——不能假装这个差异不存在。

**定稿：宿主凭据 stdin 注入 + 尊重既有配置，不做 Jev 桥。**

| 规则 | 内容 |
| --- | --- |
| 唯一权威源 | 宿主 `modelProviders` 中的 TypeSafe 凭据条目。**M0 实测偏差**：`features/mcp/curated-catalog.ts:171-188` 的 `jev` 条目走用户填的 `env`（`TYPESAFE_API_KEY`），当前**并未**从 `modelProviders` 取；M2 以 `modelProviders` 为唯一源，若该实例不存在则不擅自创建、不覆盖 SAG 已有配置，改由侧栏引导。jeve MCP 条目的凭据统一另记遗留项（见 `M0-核验记录.md` §2） |
| 已配置则复用 | 先读 `sag config` 的脱敏输出；若已有可用 key 或 `--auth none` 的本地服务，**不覆盖、不改写**（上游亦明确「Existing usable ... settings are reused automatically」） |
| 未配置则注入 | 宿主在初始化时把凭据经 **stdin** 交给 `sag config --auth bearer --key-stdin`；**不进命令行参数、不进日志、不进事件、不进快照**（同时符合 `DEC-7` 与上游「Do not paste keys into chat or place them in command arguments」） |
| SAG 侧副本定位 | 0600 私有文件是**派生缓存**，不是第二个权威源；宿主凭据轮换时幂等重放一次注入 |
| 卸载时 | **不改 SAG 配置、不删知识库根**，避免破坏用户自己的桌面端；只停止本插件的注入行为 |
| 不做 | 本地 Jev 反代／协议桥移出本期路线。仅当未来需要统一审计或彻底消除本地派生副本时再评估 |
| 隐私 | 语义检索会把问题与候选段落发往 Jev 服务（上游 README 明示，`plugins/jev/README.md:18` 同样警告不要发密钥或私有源码）；面板常驻提示与关闭开关 |

**为什么这比「做桥」更优**：只用官方承诺的 CLI 契约 → 零协议风险、零额外维护面；同时拿到「安装即生效、零终端操作、单源凭据」三个结果。做桥的唯一增量收益是「SAG 侧连派生副本都没有」，代价是要长期维护一份没有公开 spec 的协议实现，不划算。

## 4. 宿主内核插件

### 4.1 文件清单

```text
apps/server/src/features/knowledge/
  plugin.ts             # PluginDefinition：apply 只注册自己的服务；mounted 注册路由
  types.ts              # KnowledgeService Definition + 证据对象类型
  service.ts            # 安装态门控、目录/索引/检索编排、缓存
  init.ts               # 凭据 stdin 注入 + ensureRoot 幂等编排（KB-1 / KB-3）
  preflight.ts          # pre-step waterfall 监听器（§6）
  prompt.ts             # 置顶提示段（order -50 / scope always）
  tools.ts              # shared 工具工厂
  cli-probe.ts          # JSON 输出探针 + fixture（M0）
  providers/sag-cli.ts  # SagCliProvider
  providers/disabled.ts # DisabledProvider
  *.test.ts
apps/server/src/http/knowledge.ts                 # 路由
packages/shared/src/knowledge-contracts.ts        # zod 契约（请求/响应/证据/错误码）
plugins/knowledge/                               # bundle 插件（§5）
```

`apply()` 只注册自己的服务，`mounted()` 做跨服务接线（路由），形状照 `features/voice/plugin.ts:11-59`；**不改 `app.ts` / `worker.ts`**（`AGENTS.md:19`）。

### 4.2 HTTP 路由（定稿）

| 路由 | 用途 | 阶段 |
| --- | --- | --- |
| `GET /api/knowledge/status` | 安装态／CLI／平台／钉死版本／未就绪原因总状态（面板心跳） | M2 已落地 |
| `GET /api/knowledge/roots` | 知识库根列表、索引状态与文件数 | M2 已落地 |
| `POST /api/knowledge/roots` | 注册知识库根（新根显式 `--types` 开启代码扩展名） | M2 已落地 |
| `POST /api/knowledge/roots/remove` | 移除根登记，保留原始文件 | M2 已落地 |
| `POST /api/knowledge/search` | SAG2 语义检索（供面板与 `knowledge_search` 工具复用同一编排） | M2 已落地 |
| `GET /api/knowledge/read` | 按证据位置取原文片段 | **顺延 M4** |
| `POST /api/knowledge/settings` | 自动注入开关、预算、结果条数、本地匹配档 | **顺延 M4** |

M2 实际落地 5 条，已在 `apps/server/src/openapi/registry.ts` 登记中文注释并生成 spec（tag `knowledge` 同时加入 `tests/api-spec-consistency.test.mjs` 的封闭清单与 `generate.ts` 的 `TAG_META`）。`read` 需要跨文件位置校验、`settings` 需要面板开关，随 M4 同一提交补齐，不做空壳路由。

**单源链三连（`AGENTS.md:68-71`）**：改 `apps/server/src/openapi/registry.ts`（中文 summary／description，禁留空）→ `pnpm api:spec` → `apifox import --project 8892388 --format openapi --file docs/api/openapi.json --overwrite-mode overwrite`。契约唯一属主是 `packages/shared` 的 zod schema；错误码复用既有封闭枚举，不新增未登记的码（历史事故见 `docs/插件/语音助手插件规划.md` §2.4）。

### 4.3 初始化与自动注册（KB-3，**M2 核验后修订**）

**M2 核验结论**：服务端**没有**「不依赖 run / Task / actor 的全局当前工作区根」服务——`ServiceMap` 无此 key，`ServerEnv` 无相应环境变量，`resolveSandboxDir(canvasId)` 与 `ProjectService.listProjects(actor)` 都需要额外上下文且无「当前打开」语义。因此把 KB-3 的自动注册**时机**从「安装时」改为「首次检索时按 run 的真实工作目录」，结论不变（用户零操作），但路径来源不再靠猜。

**安装时（`initialize()`，M2 已落地）**：只做 CLI 探测与凭据注入，**不注册任何根、不改用户桌面端设置**。

```text
安装态 false→true / 首次需要语义检索时（懒执行、失败不缓存）
  → 平台矩阵判定：无原生二进制 → unsupported_platform，fail loud
  → sag config（无参数，非交互输出脱敏 JSON）
      · has_key + auth_mode 已配置 → 复用，绝不读取/覆盖宿主凭据
      · 未配置 → modelProviders.resolveCredentialsById("typesafe-jev")
                 → sag config --auth bearer --key-stdin（key 只走 stdin）
  → 状态接口就绪
```

**首次检索时（`ensureRoot(rootDirectory)`，M2 提供能力、M3 接线）**：

```text
M3 pre-step 从 run 上下文解析出真实工作目录 → ensureRoot(root)
  · 相对路径 / Home、Desktop、Downloads、磁盘根、系统目录 → rejected，不碰 CLI
  · sag check <root> --json：coverage=included → already-indexed，且**不改 --types**
                           coverage=none → sag add <root> --types <文档+代码扩展名> --json
                           coverage=partial/excluded → deferred，不自动改写
  · check 参数/执行错误（exit 2）→ deferred + 明确原因
```

护栏：只注册调用方给出的这一个明确路径，不扫磁盘、不递归父目录；尊重 `.gitignore`／`.sagignore`／文件类型过滤；符号链接不扩权；初始化与注册全程幂等（上游 `sag add` 复用已有 root，重复调用不产生重复根）。已存在的根若缺代码扩展名，只在侧栏提供「启用代码索引」显式动作——`--types` 是「只索引这些」，自动改会覆盖用户桌面端设置。

## 5. 侧边栏 bundle 插件

### 5.1 清单形状（照 `plugins/demo-panel/`）

```json
{
  "name": "kenfutwork-knowledge",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml", "README.md", "assets/icon.svg", "assets/panel.html"],
  "license": "GPL-3.0",
  "kenfutwork": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "assets": true,
    "scope": "shared",
    "title": "知识库",
    "icon": "assets/icon.svg",
    "ui": [{ "id": "knowledge-sidebar", "title": "知识库", "slot": "sidebar", "url": "assets/panel.html" }]
  }
}
```

`cordis.patch.yml`：`insert: [{ id: kenfutwork-knowledge, name: kenfutwork-knowledge, inject: [ui] }]`。`index.js` 形状照 `plugins/demo-panel/index.js:13-17`，只调 `ctx.ui.register(...)`。

> 契约 `scope` 支持 `design | code | shared | null`（`packages/shared/src/plugin-contracts.ts:126`）；现有 10 个插件均未声明（null = 不过滤）。本插件显式写 `"shared"`，语义最清楚。UI 槽位经 `usePluginPanels`／`projectPluginPanels` 消费（`apps/web/src/lib/plugin-panels.tsx`）。

### 5.2 面板内容

知识库根目录增删（带索引状态与错误）、快速检索框、证据列表（路径＋行号＋片段＋点击跳原文）、CLI／JEV／平台／自动注册根状态条、**每轮自动注入开关**（关闭时常驻「知识库未自动接入」提示）、上下文预算与结果条数、本地匹配档开关、隐私提示（哪些内容会发往 Jev 服务）。

### 5.3 数据来源

面板 iframe **请求宿主 `/api/knowledge/*`**，不要用 `ctx.routes` 的 bundle 私有路由：bundle 沙箱没有子进程／文件能力，也拿不到宿主 `KnowledgeService`。M0 需核实 `usePluginPanels` 现有面板的鉴权 token 传递方式，沿用它，不另造通道。

## 6. 「优先调用」详细设计

### 6.1 每轮 preflight 时序

```text
用户输入 → runtime buildUserMessage(...) → emitWaterfall("pre-step")
  → knowledge 监听器：
    ① 查安装且启用态；未装 → next() 直接放行
    ② 意图门（纯规则、不调模型）：寒暄/纯计算/时间/纯工具确认 → next() 放行
    ③ ready()：CLI 可连 / service 可连 / root 已注册且 index ready / JEV 可用
       任一不满足 → 写显式状态（面板红条 + input 状态块），next() 放行，不阻断对话
    ④ 从 input 抽问题文本（限 1–2000 字符；附件与代码全文不进 query）
    ⑤ 查缓存（归一化 query + index version + root 集合）；命中跳过检索
    ⑥ spawn `sag "<query>" --path <root> --json -m <N>`（-c 按需取正文）
       绑定 run signal / 超时 / 并发上限；退出码 0|1|2 分路
    ⑦ zod 解析 → 按 (path, offset, length, fileVersion) 去重
       → 相关性门槛：命中数/证据分低于阈值则不注入，提示段写明「本轮未找到相关证据」
       → token 预算裁剪
    ⑧ 生成结构化证据块，追加进 payload.input
    ⑨ 必须调用 next(payload)  ← waterfall 不调 next 会拦截后续监听器
  → 其余监听器 → userMessage → 模型
```

系统提示在 run 起始期 `compose()` 一次（`agent/runtime.ts:2340-2346`），`pre-step` 只改 `input`（`agent/runtime.ts:703-722`）——所以「置顶提示段」和「证据注入」是两件事，必须分别做，不能指望一个缝解决。

### 6.2 预算、缓存与豁免（KB-2 / KB-7 定稿）

- **默认开启**自动注入（用户口径）；提供开关，但关闭时侧栏常驻提示，避免用户误以为仍在检索。
- 预算、`-m` 默认值、超时、并发上限全部走 `packages/shared/src/governance.ts` tunables（`DEC-18`），**不硬编码**；默认 `-m 5`。
- **每 run 每轮最多 1 次自动检索**；证据块占总上下文预算有可配硬上限。
- 缓存键 = 归一化 query + 知识库 index version + root 集合；同轮／相邻轮重复提问不重复检索。
- **相关性门槛**（本次新增的质量约束）：低分或零命中时不往上下文塞噪音，改由提示段声明「本轮未找到相关证据」，模型可自行决定是否用 `knowledge_search` 深挖。
- 意图门是**纯规则判断，不额外调模型**，不增加成本。
- 不进 query：附件全文、代码输入、密钥样式的字符串。
- 超长输入、并发同键、删除后迟到请求、幂等重放全部要有单测（§8.1）。

### 6.3 失败与降级（KB-4 定稿，fail loud 且不阻断）

| 上游状态 | 行为 |
| --- | --- |
| `check` coverage `none` / `excluded` / `partial` | 明确状态，提示用户在侧栏添加或等待索引；不假装检索过 |
| 退出码 1 / 2 | 分路：1 = 状态类、2 = 参数或执行错误；后者记宿主日志（不含 key） |
| `JEV missing or request failed` | 显式状态；**默认不自动切算法**，且**不阻断用户正常对话** |
| `Core busy` / `Index not ready` | 有限重试 + 提示，不无限等待 |
| 文件已变更 | 交由上游 watcher 重索引，不拿旧位置套新正文 |
| 可选降级 | `-F` 纯本地匹配只在用户**显式开关**打开时启用，并在提示段标明「当前为本地匹配，非 SAG2 语义检索」 |

定稿要点：知识库挂了，产品仍要能聊天；但不能假装检索过、更不能静默把「没查」写成「查了没有」。

## 7. 分阶段路线（定稿）

| 阶段 | 目标 | 交付物 | 验证 |
| --- | --- | --- | --- |
| **M0 事实核验**（**已完成 2026-11-08**） | 四项前置已全部落文字记录：① 钉 `@zleap-ai/sag@0.1.8` + 锁定 `--json` 真实字段 ② `modelProviders` 凭据入口与 stdin 注入路径 ③ **确认 `code:false/config:false` 默认不索引，解法是 `--types`** ④ 确认无统一下载服务、面板走 `credentials:"include"` | `sag-cli-contract.ts` + fixture + `sag-cli-contract.test.ts` + `probe/collect.mjs` + `apps/server/src/features/knowledge/M0-核验记录.md`（含 6 条偏差汇总） | 契约单测；`pnpm test:docs`。**本机未装 sag，fixture 为 serde 推导值，实采待有 CLI 的机器执行探针** |
| **M1 能力缝骨架** | `features/knowledge` + §4.2 登记 key + 安装态动态门控 + `DisabledProvider`；**不改产品行为** | 插件定义、门控单测 | `pnpm --filter @kenfutwork/server test`；`pnpm typecheck` |
| **M2 CLI Provider + 初始化 + 路由**（**已完成 2026-11-08**） | `SagCliProvider` + `sag-cli-runner` + `init.ts` 凭据 stdin 注入 + `ensureRoot` 幂等编排 + `packages/shared` 契约 + 5 条 HTTP 路由 + OpenAPI 三连；**KB-3 时机修订**（见 §4.3） | `providers/sag-cli.ts`、`sag-cli-runner.ts`、`init.ts`、`http/knowledge.ts`、`knowledge-contracts.ts`、`registry.ts`、4 个测试文件 + 1 个默认跳过的集成用例 | `pnpm --filter @kenfutwork/server typecheck`；shared 单测 176/176；knowledge 单测 53/53（1 skipped）；`pnpm api:spec`（247 端点）；`test:docs`；`test:workspace` 41/41；Biome 全绿 |
| **M3 全模式优先调用** | pre-step preflight + 意图门 + 相关性门槛 + 置顶提示段 + shared 工具；双 preset 与 Work/Flow 壳内回归 | `preflight.ts`、`prompt.ts`、`tools.ts` | 单测 + 双模式手工验收 |
| **M4 侧边栏 bundle** | 清单／面板／安装态联动；顺手修 ZCode 壳硬编码 mode；文档地图与许可证登记 | `plugins/knowledge/`、`docs/README.md` 一行、`THIRD-PARTY-NOTICES.md` | `pnpm test:docs`；装／卸走查 |
| **M5 平台覆盖与调优** | 平台矩阵收口、按需下载兜底、预算／缓存／延迟调优、§8 全量验收 | 平台状态、验收回执 | §8 全量验收；`pnpm test` + `pnpm typecheck` |

每阶段遵守 `AGENTS.md` 提交纪律：一步一提交、一步一测试、显式 `git add <path>`（禁 `-A`）、共享文件逐 hunk 复核、`packages/shared` 改动跑全量门禁、`docs/日志.md` **同一提交**记账（问题／方案／验证命令／遗留项）。测试资源护栏：需要串行时用 `pnpm exec turbo run test --concurrency=1`。

## 8. 测试与验收

### 8.1 单测必须覆盖（按仓库「测试哲学」主动越界）

- 安装／卸载／停用切换：装了生效、卸了消失、**下一轮即生效**、并发切换。
- 初始化幂等：重复安装、已注册 root 不重复 `add`、已配 JEV 不覆盖、凭据轮换重放、用户移除根后不自动重加、个人目录候选被拒。
- design／code 双 preset 的提示段与工具可见性；`always`／`shared` 不被模式过滤。
- **waterfall 监听器必须调 `next()`**（不调会拦截其他监听器）——回归测试锁死。
- 检索失败**不阻断对话**；意图门命中不检索；相关性门槛低于阈值不注入。
- 空输入、超长输入（>2000 字符）、并发同键 query、删除 root 后迟到的检索请求、幂等重放、缓存命中与失效。
- 退出码 0／1／2、JSON 解析失败、上游输出缺字段、超时、取消信号、CLI 缺失、平台不支持、JEV 未配置。
- 证据去重、预算裁剪上限、每轮最多一次检索、附件不进 query、密钥样式字符串不进 query。
- 错误路径不得把凭据写进日志／事件／快照（`DEC-7`）；key 不出现在 spawn 参数里。

### 8.2 集成测试

真实 `sag` CLI 的用例命名 `*.integration.test.ts`，默认 skipped，CI 不强制（`AGENTS.md:59-63`）；用 `SAG_DATA_DIR` 指向临时隔离目录，禁止触碰用户真实知识库。

### 8.3 验收场景

| 场景 | 期望 |
| --- | --- |
| **安装后零配置首问** | 无需打开终端、无需手加目录，第一轮提问即有证据注入 |
| 多跳线索（跨 3 份文档，收购 → CTO → 项目） | 注入证据含三个来源，路径与行号可回溯原文 |
| 代码排错（查重试逻辑） | 命中文件＋行号＋关键代码（依赖 M0 第 3 项文件类型核验） |
| Design 模式提问 / Work、Flow 壳内提问 | 与 Code 模式一样自动注入，无差别 |
| 侧边栏增删目录、索引状态、点击跳原文 | 状态与上游 `sag list/check` 一致 |
| 已装 SAG Wiki 桌面端的用户 | 复用既有索引与配置，不重复建库、不覆盖既有 key |
| 卸载插件后立即提问 | 证据注入消失，提示段不再出现，无需重启；SAG 侧配置与知识库保持原样 |
| 拔掉 CLI / 断掉 JEV | 面板红条 + 明确原因，对话仍可用，**不静默**用模型记忆作答 |

## 9. 合规与治理

1. **许可证**：SAG-Wiki 为 MIT，本仓 GPL-3.0 系；MIT 与 GPL-3.0 可组合，但须保留 MIT 版权与许可声明。若随包或按需下载 `@zleap-ai/sag` 二进制，**同一 PR** 在根 `THIRD-PARTY-NOTICES.md` 登记来源、许可、版权人与义务履行位置，并核对上游 `src-tauri/licenses/` 的依赖许可（`AGENTS.md` 提交纪律 8）。只调用 CLI，**不复制上游代码／schema／字段名**（`AGENTS.md:11` references 纪律）。
2. **文档登记**：本稿已按 `docs/README.md` 规则 5／6 登记进文档地图并在文头声明角色；否则 `pnpm test:docs`／`tests/workspace.test.mjs` 会红。
3. **决策 ID**：本稿 `KB-*` 是**方案级定稿结论的编号，不是架构决策 ID**。架构级结论（新增 ctx key、凭据口径、全模式优先级机制）在 **M1 落地 PR** 按流程写进《改造计划》§6 并取正式 `DEC-*` 编号，同时登记 `docs/README.md` 决策表；本稿只引用已登记的 `DEC-1`／`DEC-7`／`DEC-18`，不自造编号。
4. **隐私**：语义检索会把问题与候选段落发往 Jev 服务（上游 README 明示）。**只自动注册当前工作区根，绝不扫描 Home／Desktop／Downloads 或磁盘根**；面板常驻隐私提示与关闭开关；卸载不删用户 SAG 配置与知识库。
5. **不入库**：CLI 二进制、模型／凭据、`sag.sqlite`、`SAG_DATA_DIR` 内容、日志、截图（`docs/README.md` 规则 7）。

## 10. 决策结论（已拍板，无待决项）

> 主导约束：§1.1 第 3 条「装了就优先调用」。凡引入「装完还要再配一步」的方案一律不选。以下三条（KB-1／KB-3／KB-5）据此**推翻了初稿的保守推荐**。

| 编号 | 定稿结论 | 为什么这样最优 | 落点 |
| --- | --- | --- | --- |
| **KB-1** | **宿主 `modelProviders` 单源 + `sag config --key-stdin` 注入；已配置则复用；不做 Jev 桥** | 只用官方承诺的 CLI 契约，零协议风险、零额外维护面，却同时拿到「零终端操作 + 单源凭据」。做桥的唯一增量收益是消除 SAG 侧 0600 派生副本，代价是长期维护一份无公开 spec 的 `state`／`questions`／`answers.*.noul` 实现，不划算 | §3.4、M2 |
| **KB-2** | **默认开启**自动注入；关闭时侧栏常驻提示；加**相关性门槛** | 用户明确「优先调用」，默认关等于没做；门槛防止每轮往上下文塞噪音，是「优先」不变成「打扰」的关键 | §6.1–§6.2 |
| **KB-3** | **是：自动且仅注册 run 的真实工作目录**（M2 修订时机）；个人目录／磁盘根／系统目录拒绝，幂等可重放 | 装了却要手加目录，前 N 次对话插件等于没装，违背主导约束。M2 核验发现服务端无「全局当前工作区根」服务，故把注册时机从安装时后移到首次检索时，路径由 run 上下文给出而非猜测——仍然零用户操作，且更准、更安全 | §4.3、§9.4、M2 提供能力／M3 接线 |
| **KB-4** | **默认不自动降级**；显式开关才启用 `-F`；**检索失败不阻断对话** | 静默切算法会让用户以为在用 SAG2；但知识库挂了就把整个产品卡死更糟。两者分开：如实报错 + 不阻断 | §6.3 |
| **KB-5** | **三级探测**：复用本机已装 `sag` → 按需下载钉版本＋校验和 → 离线安装指引 | 上游 CLI 与桌面共享索引和配置，复用能避免重复建库、重复配置；纯按需下载会让已装桌面端的用户白下载一次，离线首启也会静默失败 | §3.3、M2 |
| **KB-6** | **不自研 SAG2 内核，也不写占位 Provider 类** | `KnowledgeService` 接口本身就是替换缝，两个真实 Provider 已满足三元组；空壳类只增加维护面。上游契约破裂时再评估 | §2.2 |
| **KB-7** | 默认 `-m 5`；预算／超时／并发全走 tunables（`DEC-18`）；**每 run 每轮最多 1 次检索**；证据块有可配硬上限；缓存键含 index version | 把「每轮自动」的成本钉死在可配置、可预测的上限内，不靠运行时临场判断 | §6.2 |
| **KB-8** | **并存、不合并**；同一 run 只允许本插件一个自动 preflight 源；UI 分栏标注 | 两套知识库同时自动注入会污染上下文且无法归因；flow 知识库继续走其既有显式调用路径 | §1.6、§6.1 |

### 剩余风险（已定缓解动作，不需再拍板）

| 风险 | 缓解 |
| --- | --- |
| CLI `--json` 字段名未在官方文档列全 | M0 协议探针 + zod schema + fixture 回归锁死；版本钉死 |
| **代码／配置文件可能默认不索引**（架构文档「follow their type settings」） | **M0 第 3 项硬核验 + 安装初始化显式启用**；否则「代码排错」验收场景不成立 |
| Jev 协议无公开 spec（若未来想做桥） | 本期不做；仅列为远期评估项 |
| 平台仅 macOS ARM / Windows x64 | Linux 与 macOS Intel fail loud，M5 收口 |
| 每轮检索带来延迟与云侧费用 | 意图门 + 缓存 + 相关性门槛 + 每轮一次 + 预算上限 + 可关 |
| waterfall 忘调 `next()` 会拦截其他监听器 | 单测锁死 |
| 第三方提示段无 order／scope、工具无 priority | 双层形态不可省（§2.1） |
| 上游私有 service／CLI 契约随版本变化 | 只依赖 `--json` 与退出码；版本钉死 + 集成测试 |

## 附：一手资料来源

| 来源 | 用途 |
| --- | --- |
| `https://github.com/Zleap-AI/SAG-Wiki` README | 定位、能力、Agent 接入面、许可、论文与 benchmark 链接 |
| `docs/en/architecture.md`（上游） | FTS5 索引、SAG2 检索链、service 端口/token/协议、存储与增量、文件类型、并发 |
| `docs/en/cli-and-harness.md`（上游） | CLI 全命令、`--json` 语义、退出码、Jev 配置与 stdin 安全建议、共享数据目录、配置复用、错误分类 |
| `docs/en/mcp-tools.md`（上游） | 内置 MCP 仅进程内、不对外；六个 `sag2_` 工具的检索语义与「Combining tools」豁免规则 |
| 本仓 `apps/server/src/kernel/`、`features/plugins/`、`features/agent-runs/`、`apps/web/src/lib/plugin-panels.tsx`、`packages/shared/src/plugin-contracts.ts` | 扩展点、事件缝、提示段 order、UI 槽位与模式过滤（正文已带行号） |
| `docs/插件/语音助手插件规划.md` §1.2／§1.3 | 「默认开启」机制与市场插件硬边界的既有实测结论 |
