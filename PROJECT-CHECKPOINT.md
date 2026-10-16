# PROJECT-CHECKPOINT — KenFutWork 遗留需求收口 + 融合兼容计划验收轮

> 依据 goal-loop 规程维护。本文件是唯一状态真相源；memory/对话不是。
> 启动：2026-10-12（用户会话）。分支 main。最近更新：2026-10-14 晚（**flow-P7 深度收编评估稿退役 + `flow/` 子模块指针复原**；上一轮：遗留台账退役，`docs/未做需求.md` 已删除）。

## PROJECT GOAL

按用户 2026-10-12 指令：
1. 完成 `docs/未做需求.md` 中未完成的功能 → 模拟点击检查（**该台账已于 2026-10-13 全表清空后退役**）；
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
- 文档回写：`docs/日志.md` 同一提交内记账；台账收口项移除（`未做需求.md` 已退役）。

## HARD CONSTRAINTS

- AGENTS.md 全部硬约束（提交纪律、文案门禁、测试纪律、禁提交密钥）；
- vendored 改动最小化 + 登记 `packages/third-party/zcode/来源清单.json`；
- 契约改动走 `packages/shared` 单源 + Apifox 三连（import 为对外动作，无 CLI 登录则 BLOCKED）；
- 不变量：工作台恒 Code 壳、Design 主区恒画布、Flow 入口随插件、Code Run 绑 Task 工作域；
- 测试资源护栏：禁并行多测试实例。

## MASTER GOAL LEDGER

| ID | Requirement | Priority | Status | Evidence |
|---|---|---|---|---|
| U1 | 未做需求#1 沙箱 broker Windows 派生缺陷 | P0 | **CLOSED（环境条件转移）** | 引号 cc0764fe + stop_unconfirmed c5dcc32e + generation 修；**本轮再修两条真实打包缺陷**（`isPackagedRuntime` 改 `isSea()`；发布 helper 依赖打包 + fail-loud 自检；影子仓库短布局三处对齐）；新 Code 壳终端实测可用（`echo KFWT` 回显）；剩余 service.test 8 红全为已登记 PSEC 环境族（本机 26340 insider transitional）→ 验收口径转「换 PSEC 正常机器复跑全绿」 |
| U2 | 未做需求#2 格式基线轮 | P2 | DONE | 历史收口 2026-10-09 |
| U3 | 未做需求#3 WSL2 真机验收 | P1 | **DONE** | `wsl --import kfw-ubuntu`（noble-wsl-amd64.wsl，sha256 与官方 SHA256SUMS 逐字符一致）+ docker.io/compose-v2；8 镜像经宿主 `docker save`→`docker load`；`docker ps` **9/9 Up（api healthy）**；停止并保留数据 → 容器清零、6 卷保留、distro Stopped；见《日志》一百八十一 |
| U4 | 未做需求#4 桌面端 GUI 走查 | P1 | **DONE** | 卸载核验（`/S`：主程序 + 17,959/17,980 项清除、`KENFUTWORK_HOME` 清空、HKLM 卸载项 0 条、应用数据保留；残留 11 个 `app\web\_next` 跨版本文件已手工清）+ 新包重装（19,211 文件、runtime 五项、HKLM `0.1.3`）+ 冒烟（3001 监听、工作台渲染、BYOK 随数据目录存活、无凭据 401）；市场点装内置插件见 2026-10-12 轮 |
| U5 | 未做需求#5 Design 语音点击 | P2 | DONE | 历史收口 2026-10-10 |
| U6 | 未做需求#6 语音离线「想」档真机 | P2 | **DONE** | `llamafile.integration.test.ts` 真机 1/1（3.9s）+ 读数回填《语音助手插件规划》§3.2 |
| U7 | 未做需求#7 Apifox 契约同步 | P1 | **DONE** | AI 分支导入 169 端点 + 幂等验收（§一百七十九）；用户 2026-10-13 确认已合并回 main |
| U8 | 未做需求#8 HA 插件本体 | P1 | 暂缓 | 用户 2026-10-13 口径：不在当前融合范围内 |
| U9 | 未做需求#9 Work/OpenDesign 规划 | P2 | 暂缓 | 用户 2026-10-13 口径：不在当前融合范围内 |
| U10 | 未做需求#10 flow P7 + 上游 MIT LICENSE | P2 | **LICENSE DONE / P7 待上游** | 上游 MIT LICENSE 推送 `future73807/futureFlow@cc10b0b` + 主仓指针跟进（2026-10-14 工作区曾回退到 `cc10b0b8`，已 `git submodule update flow` 复原到记录值 `d6c6af79`）；P7 评估稿已退役（**结论保留**：四条触发条件 3 条不满足，#3 验收后条件②转「部分满足」；评估内容见《日志》一百七十六，退役记账见一百八十九） |
| U11 | 未做需求#11 语言回写竞态 | P1 | DONE | 60c9f06d + 回归测试 |
| U12 | 未做需求#12 随包 Python 缺 pytest + 沙箱未授权随包运行时目录 | P0 | DONE | 《日志》一百七十五/一百七十六；沙箱内 `python --version` → `Python 3.12.15`、`python -m pytest -q` → 17 passed |
| U13 | 未做需求#13 run.failed `unsupported Unicode escape sequence` | P0 | DONE | 《日志》一百七十五；根因=命令输出 NUL → jsonb 拒绝；修复后该报错 0 条 |
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

## LATEST VERIFIED STATE（2026-10-14 下午）

- HEAD=`f4ebc8ac`（BASH-DIR 记账）；**本轮 G1 修复 + 文档待同一提交**（BrowserPane 信封、CDP 会话静止帧、流单路收口、SessionPane Live 插入 + 三处回归测试）。
- 运行形态：安装版 0.1.3 落 `D:\Program Files\KenFutWork`（19,211 文件，`KENFUTWORK_HOME` 机器级；HKLM 卸载项 `0.1.3`）；`kenfutwork-desktop.exe` → `KenFutWork-server` 监听 `127.0.0.1:3001`（无本机凭据的 `/api/*` 返回 401）。
- BYOK：`credentials/byok.json` 两条（含 `93cfffb2-…` 新供应商 / openai-compatible / https://www.aiping.cn/api/v1 / GLM-5.3-Flash 1M）；工作台底栏显示「新供应商 · GLM-5.3-Flash」。
- 引擎栈（#3）：WSL2 `kfw-ubuntu` 内 `docker ps` 9/9 Up（api healthy）；停止并保留数据后容器清零、6 卷保留、distro Stopped。
- 模拟点击证据（上一轮，`tmp/e2e/shots/` + `report-*.json`）：侧栏/设置 15 分区/右栏 4 卡/终端 `echo KFWT`/市场点装 3→4/六档 6/6/联网搜索/技能发布/Python 工程 pytest 17/17 + MCP stdio。
- 测试与门禁（本轮）：`pnpm typecheck` **25/25 全绿**；`apps/web` 全量 **876 过 / 26 skip / 0 红**；`apps/server` browser 套件 **118 过**（含 3 个 G1 新回归）。

## UNVERIFIED

- 计划档单轮耗时未统计（脚本 420s 上限，内容与产物已达标）。
- 运行时选择页「取消勾选即删目录」路径本轮只走默认（全保留）；页面逻辑由编译产物 + 上一轮 MessageBox 版同构逻辑背书。

## 存量红基线（2026-10-13 全量复跑）

| 范围 | 结果 | 判定 |
|---|---|---|
| 全包 typecheck | 25/25 全绿 | — |
| 根门禁 `workspace` + `api-spec-consistency` | 33/33 | — |
| `apps/web` 全量 | 777 过 / 26 skip / **0 红** | — |
| `packages/shared` | 全绿 | — |
| `apps/server` | 2268 过 / 313 skip / **60 红（17 文件）** | 见下分类 |
| `apps/desktop` | 10 过 / 12 skip / 0 红 | 本轮补 `dmg-aesthetics.test.mjs` 平台守卫（shell 夹具在 Windows 如实跳过） |

60 红的归类（与上一轮 90 红同族；**下降 30 全部来自把 `git` 放回 CLI PATH**，此前 git/检查点族整族因测试环境缺 git 而红）：

| 族 | 例数 | 代表文件 | 性质 |
|---|---|---|---|
| 沙箱授权「目录未授权」 | 24 | `execution/scoped-filesystem.test.ts`(21)、`code-tools/tool-definitions.test.ts`(3) | 测试夹具自身按 `${rootDirectory}/` 前缀比对，Windows 反斜杠 ⇒ 判「目录未授权」 |
| process-sandbox PSEC 环境族 | 8 | `process-sandbox/service.test.ts` | 《日志》§一百三十七/七十三/一百六十二/一百七十二 已登记 |
| git/检查点残余 | 8 | `code-ui/file-rewind.test.ts`(6：POSIX 权限位断言 + broker 身份失效) | Windows 不保留 POSIX 模式（438/384/448 期望值） |
| 平台语义错配 | 3 | `desktop/runtimes.test.ts`(2)、`local-instance/service.test.ts`(3) | macOS/POSIX 用例跑在 Windows（`/tmp/…` vs `D:\tmp\…`） |
| 单点杂项 | 17 | `local-credential-store`、`blob/providers`、`completed-turn-config`、`host-git-rpc`、`root-binding`（平台路径语义）、`files.test.ts`（TAB 临时名 EPERM）等 | 逐个定性为环境/平台假设 |

## IMPORTANT FILES

- 台账：**已退役**（`docs/未做需求.md` 2026-10-13 全表清空后删除）；规划侧 `docs/方案设计/工作台融合兼容计划.md`
- 日志：`docs/日志.md`（§一百八十 上半场、**§一百八十一 终章**）
- E2E 脚手架：`tmp/e2e/`（lib.mjs / walk-*.mjs / feature-*.mjs / probe-*.mjs；tmp/ 不入库）
- 交付工程：`D:\Desktop\test\kfw-e2e`（wordstats 包 + pytest + FastMCP MCP 服务器 + SKILL.md）

## DECISIONS

- E2E 用 playwright-core + 本机缓存 Chromium（agent-browser 未安装）；模拟点击为主、DB/API 取证为辅。
- 每档模式先暖场一轮建会话（六档 chip 需 sessionId 才渲染），再点 chip 切档，再发真实任务。
- 计划门/权限门由脚本自动点「批准」+「提交」/「本次允许」+「确认」（等价真实用户点击）。
- 设置页「集成终端 Shell」按「无选项即隐藏」处置（不新造与 G9 并行的第二套 shell 偏好）。

## RISKS

- 本机 Win11 26340 insider 为 PSEC transitional：沙箱族命令收尾报 `stop_unconfirmed`（环境族，非代码可修）。
- 测试侧存量红全为平台/环境假设（见基线表），换 Linux/macOS 或修夹具即清。
- `D:\wsl` 下测试产物占用 ~21GB（`images/dify-stack.tar` 5.6GB + `kfw-ubuntu` 15.7GB），清理前需确认不再复跑 #3。
- 仓库内 `error-sanitizer.test.ts` 夹具用了真实 key 前缀（44/74 字符，不可鉴权）并登记进 `.gitleaks.toml`——建议换合成串。

## 2026-10-13 晚（第二轮：外部并发 merge 收口 + 模拟点击复验）

| ID | 内容 | 状态 | 证据 |
|---|---|---|---|
| M1 | 外部并发 `git merge origin/main`（协作者 `1eccca61`，478 文件）4 冲突解法定型 | **DONE** | `44231e76` 合并提交 + `e5e7c627` 补 `hash` 助手；`pnpm typecheck` 25/25 |
| M2 | 合并带来的 13 条迁移前向应用 | **DONE** | `migrate apply` 13 条；服务端由 `42P01` fail-loud 恢复 |
| M3 | flow 子模块指针（`cc10b0b8`→`d6c6af79`，属前进） | **DONE** | `git submodule update flow`；LICENSE 在 |
| E2E-2 | 模拟点击复验：侧栏 4 入口 / 设置 15 分区 / pills（Code+Design，Flow 已正确隐藏）/ Design 主区=画布 / shells 三档 / MCP 9 工具 / 技能在库 | **DONE** | `tmp/e2e/shots/`、`tmp/e2e/report.jsonl` |
| RUN-1 | 对话档真实 run | **DONE（被服务重启打断一次）** | 改用无 watch 直启 server 后复验 |
| RUN-2 | 自主档真实 run：写 `D:\Desktop\test\kfw-probe.txt` + 读回 | **DONE** | 落盘内容 `hello-kfw`，`type` 退出码 0 |
| RUN-3 | 计划档：只读调查 → 实施计划 → 计划门批准 | **DONE（门链路）** | 「计划已批准，开始实施」 |
| **P0-RECEIPT** | 回执门误杀目录层 SDK 工具（`ToolSearch` / `write_todos`）：provider 侧 `tool.completed` 先于中间件自铸回执到达 → `verify` 抛错中断 run | **FIXED** | 插桩取证（`started` 有键 / `completed` 空）；修 `tool-execution-receipts.ts`（`sdkBundledTools` 豁免，未观察工具仍严校）；新增 4 例回归测试全绿；修后 `缺少真实执行结果` 计数 0 |
| **P0-GITPATH** | 随包 `git` 未进沙箱 PATH/readRoots（宿主无 git 时检查点/提交整族不可用） | **FIXED** | `runtime-paths.ts` 的 `BUNDLED_RUNTIME_NAMES` 加 `git`；`runtime-paths.test.ts` 加断言（6/6 绿）；实测 `error launching git` 消失 |
| PYPROJ | `D:\Desktop\test` Python+MCP+skill 工程 | **DONE** | `kfw-e2e2`：wordstats 包 + CLI + 3 个测试文件 + 纯标准库 MCP stdio 服务器 + SKILL.md；**独立复跑 pytest 32 passed**；MCP 握手 `MCP stdio handshake: OK` |
| SKILLPUB | 技能发布（创造路径） | **DONE** | `/api/skills` 落库 `kfw-wordstats` |
| SEARCH | 联网搜索 | **DONE（工具可用）** | 多轮真实 `web_search` 返回真实来源；模型如实报出代理的上游退化与 5002 |
| RUN-AUTO | 自主档真实 run | **DONE** | `kfw-probe.txt` 落盘 + `type` 读回退出码 0 |
| MODE6 | 六档执行模式端到端 | **DONE（五档实测 + 循环设计退役）** | 方法：暖场建会话→点 `[data-testid="execution-mode-chip"]`→取证 `chat_sessions.execution_mode`。结果：`对话=solo`（答 1024）、`计划=plan`（计划门；Bash 已改真执行——只读兜底从 OS 级移到内核层 + 逐次审批，见《日志》§一百八十六）、`目标=goal`（标准+差距）、`自主=agent`（落盘并读回）、`创造=creative`（技能 `mode-creative-demo` 落库）；`循环` 不在 `/api/execution-modes`（`RetiredExecutionModeError`，设计退役） |
| MCPREG | MCP 注册/发现（`install_mcp_server` → ToolSearch → 调用） | **DONE** | Task 绑到脚本所在目录后三步一次跑通：install（connected、PYTHONPATH 生效）→ `list_mcp_servers`（列出 kfwstats + 两工具）→ ToolSearch 发现 → 真实调用 `word_stats`（total_tokens=3 / unique_words=2 / isError:false）。此前「不可用」的根因是回执门第二处误判（宿主 `outputText` 空 vs provider 有内容 → 判成「替换了真实执行结果」），已修 + 回归测试 |
| ENV-GIT2 | 沙箱 git 报 `fatal: this operation must be run in a work tree` | **DONE（两个根因都已修，端到端复跑通过）** | 根因一：检查点 Git 之前跑在 `derive("review")` 只读作用域，Windows PSEC 只读授权不含目录 traverse ⇒ `chdir` 报 Permission denied；`git add`/`commit` 的 `setup_work_tree()` 必须 chdir（git 源码：`if (!work_tree \|\| chdir_notify(work_tree)) die("this operation must be run in a work tree")`）⇒ 整族失效。已改 `derive("review")` → `derive("worker")`（固定 argv 的系统 consumer，模型输入到不了）。根因二：沙箱捕获层 `stripNulCharacters` 把 `-z` 清单的 NUL 剥掉，路径被粘成一条（`pathspec ... did not match any files`）；已加显式 `preserveNul` 开口，只在影子 Git 读取时开启。**验证**：影子仓库出现 `轮次开始快照`/`轮次结束快照` 两个真实提交、日志不再有 `[turn-boundary] 文件边界捕获失败`；三个定向套件 29/29 绿 |
| BASH-DIR | cmd `dir` 在沙箱内恒报 `Access is denied.` | **DONE** | 根因：沙箱只读根缺**系统盘根**（cmd 的 `dir` 先取卷信息）。非 cmd 枚举器（bundled node `readdirSync`）在同一作用域**列出 26 项**⇒沙箱枚举权本就正常。修法 1 行：runtime 只读根加 `SystemDrive\`（只读，不扩写域）。验证：沙箱级 `dir` 0 + 真实卷信息；**计划档模拟点击**：`dir` 0（26 文件/4 目录）、`cd sub` 0、`dir /b` 0（`inner.txt`）、`type sub\inner.txt` ✓（《日志》§一百八十七） |
| G1BROWSER | 浏览器面板点击验收 | **DONE** | 模拟点击 **16/16**：入口→挂载→导航 2s 出画面→流解出真实帧 1280×720→服务端 connected 同 URL→视口换真视口→拾取叠框→引用进 composer→调试口注入→历史栈前后退且保持画面态→收起隐藏→关闭移除（`tmp/e2e/report.jsonl` + `shots/browser-*.png`；《日志》§一百八十八）。**验收修出 4 个真实缺陷**：①面板读错 `{cdp:…}` 信封恒报「浏览器启动失败」（改读信封+夹具对齐真契约）；②静态页单帧永不渲染（开流立即补一张 JPEG 静止帧；Chromium 只在下一分界结束 part）；③旧流占满连接池致面板卡「正在打开…」（新流开起时收掉上一路流）；④Q5 引用被上游草稿门挡掉+toast 虚报（放开到 Live 会话） |

## NEXT ACTION

1. **融合计划功能项已全部点完**（G1–G11 + G1BROWSER 均有真机证据）。
2. **已查清、不作为本计划修复项：Windows 只读档缺目录 traverse。** 机制（一手证据）：Windows 分两条执行层 —— T3 宿主路径 DACL 的只读掩码 `RO_MASK = FILE_GENERIC_READ \| FILE_GENERIC_EXECUTE` 含 traverse；而**本机（Win11 26340 insider）走的是 T1 原生 PSEC**，其 `fs_read_only` 只给「读 + 列目录」，**不含目录 traverse**。实测：只读作用域下 `git -C <workTree> …` 报 `Permission denied`（chdir 被拒），而 `rev-parse --show-toplevel` / `--is-inside-work-tree` / `ls-files --others` 全部 exit 0 —— 即「读得到、进不去」，`git add`/`commit` 的 `setup_work_tree()` 恰好死在 chdir 那一步。
   **已实测过 T3 路线（结论：可恢复 traverse，但不作为本轮改动）**：把只读档临时指到 DACL 层（`AppContainerScriptRunner::with_filesystem_mode(Dacl)` + 自己打 RW/RO ACE）后，沙箱内实测 `cd sub` ✓、`type sub\inner.txt` 读到 `ok-inner` ✓、`echo > evil2.txt` 被拒（`Access is denied`，只读保持）✓、私有影子仓库目录可写 ✓；失败的是 `mkdir` 既有目录正常而 **`move`（rename）被拒** —— rename 需要源文件 `DELETE`，只读掩码本就不含它（对只读档是正确行为）。代价面：① T3 要临时改写**宿主路径安全描述符**（与 `FallbackPolicy { allow_dacl_mutation: false }` 的取向冲突，MXC 定义该开关为「operator consent for host-impacting containment fallbacks」）；② MXC 的 `build_t3_dacl`/`derive_sid_string` 等 glue 部分私有，要在 adapter 里复刻；③ 每 spawn 会现建 AppContainer profile，需接 `sandbox_tracking` 的清理/身份生命周期。**故本轮只把检查点 Git 放行到可写档（已修）；只读档未改**——若后续确有「计划档 Bash 需要 `cd`/读子目录」的真实诉求，再单独立项落 T3 DACL，并按上面三条代价评估。（取证：`tmp/e2e-server29/30/31.log` 的 `[probe-ro]` 行）
3. 提示：六档端到端驱动方式已定型（暖场建会话 → 点 `[data-testid="execution-mode-chip"]`），复跑直接复用 `tmp/e2e/run-mode.mjs`；MCP 端到端复用 `tmp/e2e/run-mcp-e2e.mjs`（需 Task 绑到脚本所在目录）；检查点/落盘复跑复用 `tmp/e2e/run-task.mjs`（复用绑定 `test` 项目的会话）。


