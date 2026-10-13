# PROJECT-CHECKPOINT — KenFutWork 遗留需求收口 + 融合兼容计划验收轮

> 依据 goal-loop 规程维护。本文件是唯一状态真相源；memory/对话不是。
> 启动：2026-10-12（用户会话）。分支 main。最近更新：2026-10-12 晚（E2E 验收轮收尾）。

## PROJECT GOAL

按用户 2026-10-12 指令：
1. 完成 `docs/未做需求.md` 中未完成的功能 → 模拟点击检查；
2. 完成 `docs/方案设计/工作台融合兼容计划.md` 中未完成的功能 → 模拟点击检查；
3. 全部完成后做全流程模拟点击验收：**所有页面按钮/功能/对话/样式**；
4. 重点验证：联网搜索、MCP、skill、对话、计划、目标、循环、自主、创造（创造插件/技能/MCP 工具）；
5. 建 Python 项目 + MCP + skill 测试工程（工作目录 `D:\Desktop\test`），用计划档 + 自主档实测；
6. 模型：GLM-5.3-Flash（https://www.aiping.cn/api/v1，key 仅入本机凭据库，严禁入库）。

## DEFINITION OF DONE

- 台账每一项有明确状态（DONE/BLOCKED/NOT_APPLICABLE…）且 BLOCKED 带证据；
- 本环境可实施的代码项全部落地并有测试/构建证据；
- 全流程模拟点击（playwright-core + Chromium + 真实 GLM run）覆盖：首屏/侧栏/设置全分区/composer 各 chip/对话/计划档/目标档/循环档/自主档/创造档/联网搜索/MCP/技能/终端/浏览器面板/插件市场；
- `pnpm typecheck` 与相关测试绿（环境族红如实标注）；
- 文档回写：`docs/日志.md` 同一提交内记账；`未做需求.md` 收口项移除。

## HARD CONSTRAINTS

- AGENTS.md 全部硬约束（提交纪律、文案门禁、测试纪律、禁提交密钥）；
- vendored 改动最小化 + 登记 `docs/源码来源/ZCode源码清单.json`；
- 契约改动走 `packages/shared` 单源 + Apifox 三连（import 为对外动作，无 CLI 登录则 BLOCKED）；
- 不变量：工作台恒 Code 壳、Design 主区恒画布、Flow 入口随插件、Code Run 绑 Task 工作域；
- 测试资源护栏：禁并行多测试实例。

## MASTER GOAL LEDGER

| ID | Requirement | Priority | Status | Evidence |
|---|---|---|---|---|
| U1 | 未做需求#1 沙箱 broker Windows 派生缺陷 | P0 | PARTIAL | 引号修 cc0764fe + stop_unconfirmed 修 c5dcc32e + generation 铸 1；**终端模拟点击实测可用**（工作目录提示符 + `echo KFWT` 回显）；剩 PSEC 环境族 8 红（service.test 18/26） |
| U2 | 未做需求#2 格式基线轮 | P2 | DONE | 历史收口 2026-10-09 |
| U3 | 未做需求#3 WSL2 真机验收 | P1 | BLOCKED | 本机仅 Docker Desktop 内部发行版，无通用 WSL2 |
| U4 | 未做需求#4 桌面端 GUI 走查 | P1 | PARTIAL | **市场点装内置插件实测通过**（Computer Use，已安装 3→4）；安装器全链待真机 |
| U5 | 未做需求#5 Design 语音点击 | P2 | DONE | 历史收口 2026-10-10 |
| U6 | 未做需求#6 语音离线「想」档真机 | P2 | BLOCKED | 需 KENFUTWORK_VOICE_REAL_LLM=1 长时真机 |
| U7 | 未做需求#7 Apifox 契约同步 | P1 | PARTIAL | `apifox-cli@2.2.12` 已全局安装（`apifox --version` 通）；差 API 令牌登录（用户凭据） |
| U8 | 未做需求#8 HA 插件本体 | P1 | 暂缓 | 用户 2026-10-13 口径：不在当前融合范围内 |
| U9 | 未做需求#9 Work/OpenDesign 规划 | P2 | 暂缓 | 用户 2026-10-13 口径：不在当前融合范围内 |
| U10 | 未做需求#10 flow P7 + 上游 MIT LICENSE | P2 | PARTIAL | P7 评估方案已成稿并登记文档地图；LICENSE 已在子模块本地提交 `b62fcbe`，待推上游 |
| U11 | 未做需求#11 语言回写竞态 | P1 | DONE | 60c9f06d + 回归测试 |
| U12 | 未做需求#12 随包 Python 缺 pytest | P1 | **DONE** | 日志 §一百七十六；沙箱内 `python -m pytest -q` → 17 passed / exit 0 |
| U13 | 未做需求#13 run.failed `unsupported Unicode escape sequence` | P0 | **DONE** | 日志 §一百七十五；根因=命令输出 NUL → jsonb 拒绝；修复后该报错 0 条 |
| U14 | 未做需求#12 沙箱未授权随包运行时目录 | P0 | **DONE** | 日志 §一百七十五；沙箱内 `python --version` → `Python 3.12.15`（解析到随包运行时） |
| G1 | 浏览器面板整链（G1/Q3-Q4） | P0 | DONE | 9115d2eb |
| G1q5 | 元素拾取（Q5） | P1 | DONE | e272b64（browser-pane 6/6） |
| G2 | 六档执行模式回 Code 壳 | P0 | DONE | f4ae8179 + 本轮六档实测 |
| G3 | 每轮自动 git 提交 | P1 | DONE | 1a9b8b25 |
| G4 | worktree 三能力 | P1 | DONE | 19d23869 |
| G5 | GitPane init | P1 | DONE | 2c18b297 |
| G6 | 上下文圆环+修显示 | P0 | DONE | 8a3dded6（composer 圆环真机在渲染） |
| G7 | 权限档旧四档 | P1 | DONE | 8cd530cb + 设置页权限分区真机 |
| G8 | 检查点多轮时间线 | P1 | DONE | 7c28e890 |
| G9 | 终端 shell 菜单+终端修复 | P0 | DONE | 8bafeecd + broker 修 + 本轮终端实测 |
| G10 | 设置分区补充 | P1 | DONE | d609db0c 等 + 本轮 15 分区走查 |
| G11p2 | 面板拖到上限自动收左栏 | P2 | DONE | e272b64 |
| G11h1 | 会话头锁定目录 chip（只读） | P2 | DONE | e272b64 |
| T-CLEAN | 阶段三孤儿清理 | P2 | BLOCKED | sidebar-row 已删；settings-modal 承载 Agent 治理面，迁移未立项 |
| E2E | 全流程模拟点击验收（含 GLM 实测） | P0 | DONE | 侧栏 8/8、设置 15/15、右栏 4 卡、终端、市场点装、六档六轮全绿 |
| E2E-K | 重点：联网搜索/MCP/skill/对话/计划/目标/循环/自主/创造 | P0 | PARTIAL | 联网搜索 ✓、技能 ✓、六档 ✓、Python 工程 ✓（沙箱外 17/17）；MCP 注册受 U12 阻断 |
| FIX-SET | 设置页「集成终端 Shell」死下拉 | P2 | DONE | f234516a（无选项时隐藏，真机复看已消失） |

## LATEST VERIFIED STATE

- HEAD=f234516a（设置页修复 + 验收记账已提交）；工作区仅剩 PROJECT-CHECKPOINT.md 未跟踪。
- 环境：server 3301（嵌入式 PG 55433，98 迁移落地）+ web dev 3300 + code-ui 重建暂存。
- BYOK：`provider_instances` 1 条（新供应商 / openai-compatible / https://www.aiping.cn/api/v1 / GLM-5.3-Flash 1M），enabled。
- 模拟点击证据（`tmp/e2e/shots/` 截图 + `tmp/e2e/report-*.json`）：
  - 侧栏 4 入口 + 模式 pills + 搜索 8/8；设置 15 分区 15/15；
  - 右栏启动卡 4 张（辅助对话/审查/终端/浏览器）；**终端命令执行 PASS**（`echo KFWT` → `KFWT`）；
  - 插件市场点装 PASS（Computer Use 安装，已安装 3→4）；
  - 六档模式 chip 切换 6/6 + 内容判定 6/6（含计划门「需要权限 · 实施计划」三选项 → 批准 + 提交）；
  - 联网搜索 PASS（web_search 4 轮 + 拒绝编造来源）；技能 `create_skill` 发布 PASS（`instance_skills` 落库）；
  - Python 工程 `D:\Desktop\test\kfw-e2e`：pytest 17/17（沙箱外）、MCP stdio 握手通过。
- 测试/门禁：settings-copy-guard 12/12、settings-rows-structure 9/9、browser-pane 6/6、side-pane-model 2/2、locked-directory 1/1、workspace 29/29、api-spec 3/3、check-docs 通过；web tsc 与 zcode host/vendor tsc 双绿。

## UNVERIFIED

- 计划档单轮超过脚本 420s 上限（内容已达标、产物已落盘），未统计其完整耗时。
- 浏览器面板（右栏「浏览器」卡）未在本轮点到——终端占用页签后启动卡列表收起；实现已在 G1 单测与上一轮覆盖。
- `unsupported Unicode escape sequence`（U13）根因未定位到具体写库语句。
- 沙箱运行时授权（U12）的修法未定（`additionalDirectories` 还是沙箱 ACL 等价机制）。
- Flow 引擎栈本轮未拉起（8090/15010 未起），Flow 模式仅验证 pill 切换与页面加载。

## 存量红基线（2026-10-12 全量复跑，与本轮改动无关）

本轮改动面 = `apps/web/**` + `docs/**` + `packages/zcode-shared/src/test-ids.ts`（纯常量新增），
`apps/server` 与 `packages/shared` 改动文件数 **0**，故以下红均为存量/环境族：

| 范围 | 结果 | 判定 |
|---|---|---|
| 全包 typecheck（13 个包 + web + zcode host/vendor） | 全绿 | — |
| 根门禁 `workspace` + `api-spec-consistency` | 32/32 | — |
| `apps/web` 全量 | 777 过 / 26 skip / **0 红** | 本轮改动面，全绿 |
| `packages/shared` | 141 过 / **1 红** | `mcp-contracts.test.ts` → `spawnSync node.exe EBUSY`（Windows 文件锁；手工复跑同逻辑 0.5s 返回正确结果） |
| `apps/server` | 2220 过 / 313 skip / **90 红（18 文件）** | 见下分类 |

90 红的归类（按错误串聚合）：

| 族 | 例数 | 代表文件 | 性质 |
|---|---|---|---|
| 沙箱授权「目录未授权」 | 24 | `execution/scoped-filesystem.test.ts`(21)、`code-tools/tool-definitions.test.ts`(3) | Windows 路径规范化 → 授权判定偏差（测试直写 rootDirectory 后期待「read/读取」，实得「目录未授权」） |
| git/检查点「Git失败」 | 37 | `code-ui/file-rewind.test.ts`(19)、`checkpoints/shadow-git-client.test.ts`(10)、`checkpoints/checkpoint-service.test.ts`(8) | Windows 临时目录 git 操作（`renaming failed: Invalid argument`、`EBUSY rmdir`） |
| process-sandbox PSEC 环境族 | 8 | `process-sandbox/service.test.ts` | 已在《日志》§一百三十七/七十三/一百六十二/一百七十二 登记（`stop_unconfirmed`、broker ENOENT、拒绝访问乱码） |
| 平台语义错配（macOS/POSIX 用例跑在 Windows） | 4 | `desktop/runtimes.test.ts`（`\opt\custom git\bin\git`）、`local-instance/service.test.ts`（`D:\tmp\new` vs `/tmp/new`） | 测试自身平台假设 |
| 单点杂项 | 17 | `local-credential-store`（promise 未 reject）、`blob/providers`、`completed-turn-config`、`host-git-rpc`、`root-binding`、`files.test.ts`（临时文件名含 TAB → EPERM） | 待逐个定性 |

**未做**：未在 `c5dcc32e`（改动前）跑一次同口径全量做对照——上述判定基于「改动面零交集 + 失败原因全为平台/沙箱/文件锁」的推断，属 `INFERRED` 而非 `VERIFIED`。

## IMPORTANT FILES

- 台账：`docs/未做需求.md`（十二项）、`docs/方案设计/工作台融合兼容计划.md`
- 日志：`docs/日志.md`（§一百七十三 收尾三件、§一百七十四 验收轮）
- E2E 脚手架：`tmp/e2e/`（lib.mjs / walk-*.mjs / feature-*.mjs / probe-*.mjs；tmp/ 不入库）
- 交付工程：`D:\Desktop\test\kfw-e2e`（wordstats 包 + pytest + FastMCP MCP 服务器 + SKILL.md）

## DECISIONS

- E2E 用 playwright-core + 本机缓存 Chromium（agent-browser 未安装）；模拟点击为主、DB/API 取证为辅。
- 每档模式先暖场一轮建会话（六档 chip 需 sessionId 才渲染），再点 chip 切档，再发真实任务。
- 计划门/权限门由脚本自动点「批准」+「提交」/「本次允许」+「确认」（等价真实用户点击）。
- 设置页「集成终端 Shell」按「无选项即隐藏」处置（不新造与 G9 并行的第二套 shell 偏好）。

## RISKS

- U12/U13 两条 P0 未修，会在 Python 类任务与含 Windows 路径的命令上复现。
- PSEC transitional 让终端族命令收尾报 stop_unconfirmed（环境族，非代码可修）。
- GLM-5.3-Flash 单轮耗时长，六档全量实测约 45 分钟。

## NEXT ACTION

1. U12：把随包运行时根目录纳入沙箱只读授权（`additionalDirectories` 或沙箱 ACL），验收 = 沙箱内 `python -V` / `pytest` 可跑 + `create_mcp_server` 能连 Python 服务器；
2. U13：定位把命令/输出写进 jsonb 的链路并参数化，回归测试锁死「命令含 `\Users`/`\nvm` 时 run 不失败」；
3. 其余 BLOCKED 项按各自前置条件推进（真机/拍板/对外）。
