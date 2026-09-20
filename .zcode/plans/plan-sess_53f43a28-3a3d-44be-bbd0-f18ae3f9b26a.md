# Code 模式检查点（Checkpoint）功能实施计划

## 一、已拍板的决策（grilling 两轮收敛）

| 决策点 | 结论 |
|---|---|
| 存储机制 | **影子 git**：裸仓库放服务端数据目录，work-tree 指向沙箱；项目零残留、不碰用户 .git |
| 打点粒度 | **每轮 run 前后各一个**（turn 级），失败/取消也有「前」检查点；表结构预留扩展 |
| 恢复语义 | **整个工作目录回到该时点**：恢复前预览受影响文件清单确认；恢复后自动补 `restore` 检查点（被回滚状态仍在历史可再恢复）；v1 不动对话 |
| 与现有 git 关系 | **独立并存**：检查点绝不写用户仓库；code-git 面板与前端 `autoCommitTurn` 原样保留 |
| UI | **消息卡检查点条**：每轮 run 终态后消息卡底部出现「检查点：N 文件 ±M 行」，带「查看改动」「回滚」；历史轮次天然成时间线 |
| v1 边界 | 不做手动打点、自动清理上限、对话回滚、开关（git 可用即启用，不可用显式降级） |

## 二、机制设计

**存储布局**：新 env `KENFUTWORK_CHECKPOINT_ROOT`（`config/env.ts` 加 `checkpointRoot`），`server.ts` 在 `resolveSandboxRoot` 旁加 `resolveCheckpointRoot`（缺省 `<entryRoot>/data/checkpoints`，与桌面 pg/、supabase/ 同级持久目录对齐）。每个画布一个裸仓库 `<checkpointRoot>/<canvasId 清洗>.git`（`git init --bare`），所有调用带 `GIT_DIR` + `GIT_WORK_TREE=<resolveSandboxDir(...)>`（**必须**经 `apps/server/src/agent/sandbox-dir.ts:33` 同一解析，历史事故防复发）。

**内置忽略**：`core.excludesFile` 指向裸仓库内生成的 `excludes` 文件：`.git`、`.kenfutwork`（索引库落点）、`node_modules`、`dist`、`build`、`.next`、`.venv`、`__pycache__`、`target`、`coverage`、`.DS_Store`、`*.log`。项目自己的 `.gitignore` 照常生效（git 读 worktree 内 ignore 与 GIT_DIR 位置无关）。`.git` 进忽略是关键——work_dir 指向用户真实仓库时防止记录 gitlink。

**采集时机**（`apps/server/src/agent/runtime.ts`）：`createAgentRunService` 加可选依赖 `checkpointHooks?: { beforeTurn(ctx: {canvasId, sandboxDir}): Promise<void>; afterTurn(ctx): Promise<void> }`。`beforeTurn` 在 backendResult 解析后、`agent.streamEvents` 前（约 L1757）；`afterTurn` 在 `finally`（turn-end hooks 后、临时沙箱清理前，约 L2062）。hook 失败只 `console.warn`，绝不影响 run 终态（与 turn-end hooks 同纪律）。

**检查点提交**：`git add -A` → `status --porcelain` 非空或仓库尚无提交才 `commit`（空变化跳过）→ 落库一行。首次为 `baseline`，run 前后为 `turn`，恢复后为 `restore`。

**恢复序列**：`add -A`（index 对齐当前工作区，无破坏性）→ `git diff --numstat <targetSha>` 得受影响清单（预览与恢复共用此前缀）→ `git read-tree --reset -u <targetSha>` 切换 index+工作区（含删除，ignored 目录不动）→ 再打一个 `restore` 检查点。每画布进程内 promise 互斥串行化。

**可用性门**：`gitSource === "unavailable"` 时服务照常装配但操作抛可读错误（路由 503 说明缺 git），fail loud；桌面端 MinGit 已捆绑，**Dockerfile 生产段 apt-get 行加 `git`**。

## 三、改动清单

### 服务端（`apps/server`）
1. **迁移** `supabase/migrations/20260920HHmmss_project_checkpoints.sql`：`project_checkpoints(id uuid 应用层生成、workspace_id → workspaces on delete cascade、canvas_id text、run_id uuid null、kind check(baseline|turn|restore)、label、shadow_commit、files_changed/insertions/deletions int、created_at)` + `(workspace_id, canvas_id, created_at desc)` 索引。跟随 FORM-9：无 RLS，应用层 workspace 谓词强制。
2. **`features/checkpoints/`**（能力缝三元组齐全）：
   - `shadow-git-exec.ts`：Provider，仿 `code-git/git-exec.ts`（execFile 无 shell、超时、maxBuffer），注入 GIT_DIR/GIT_WORK_TREE + `--no-optional-locks`；git 二进制解析复用 code-git 同款（`env.gitBinDir` 优先）。
   - `shadow-git-client.ts`：纯逻辑层（init/ensure、commitIfChanged、numstat、diff、readTree 恢复、 porcelain 解析），接口形状仿 `GitClient`（ExecGit 可注入，测试不 mock git 本体而注入 exec）。
   - `checkpoint-service.ts`：`CheckpointService` 接口 + 实现——canvas→workspace 归属、hooks 实现、列表/单检查点 diff/预览/恢复、每画布互斥、`checkpointRoot` 管理。
   - `repository.ts`：经 `features/persistence` 缝（`forWorkspace` 谓词）读写 `project_checkpoints`。
   - `plugin.ts`：`PluginDefinition`（inject `["auth","persistence","viewer"]`，apply 注册服务、mounted 注册路由）。
3. **`http/checkpoints.ts`**：`registerCheckpointsRoutes(app, deps)`，鉴权与归属校验对齐 `http/code-git.ts`（auth → viewer→canvas）：
   - `GET /api/code/checkpoints?canvasId=` 列表
   - `GET /api/code/checkpoints/:id/diff?path=` 相对上一检查点的统一 diff
   - `POST /api/code/checkpoints/:id/preview` 受影响文件清单
   - `POST /api/code/checkpoints/:id/restore` 恢复（同 canvas 有 running run 时 409）
4. **`kernel/types.ts`**：`ServiceMap` 加 `checkpoints: CheckpointService`（§4.2 契约，只改这一处 + 文档表）。
5. **`agent/runtime.ts`**：加 `checkpointHooks` 可选依赖与两个挂点；加 `hasActiveRunForCanvas(canvasId)` 供恢复守卫。
6. **`features/agent-runs/plugin.ts`**：apply 里 `ctx.tryGet("checkpoints")` 传入 hooks（对齐 modelCatalog 可选依赖模式）。
7. **`profiles/server.ts`**：`createCheckpointsPlugin()` 排在 code-git 后、agent-runs 前；`PLUGIN_CATALOG` 加「检查点」条目（Agent 能力类）。
8. **`config/env.ts` + `server.ts`**：`checkpointRoot` 解析。
9. **Dockerfile**：生产段 apt-get 加 `git`。

### 契约（`packages/shared`）
新文件 `src/checkpoints.ts`（+ `index.ts` 导出）：`checkpointSummarySchema`、list/diff/preview/restore 的请求响应 schema。前端不依赖 diff 解析契约细节（统一 diff 文本直传，渲染复用 `git-hunks.ts`）。

### 前端（`apps/web`）
1. `src/lib/code-checkpoints-api.ts`：四个端点封装（仿 `code-git-api.ts`）。
2. `workbench.tsx`：`run.completed`（L1325）与 `run.failed` 分支后拉取该 run 检查点写入 task（`WorkbenchTask` 加 `checkpoint?` 字段）；Code 模式限定。
3. 新组件 `checkpoint-chip.tsx`（消息卡底部条：统计 + 查看改动 + 回滚，运行中禁用）与 `checkpoint-restore-dialog.tsx`（预览清单 + 确认；成功后刷新 git changes 面板）。
4. diff 渲染复用 `git-hunks.ts`（`toDiffLines`/`markHunkStarts`）+ `code-highlight.ts`；chip 状态归约抽纯函数进 `src/lib/`，配 `test/` 单测。

### 文档（同提交，防 workspace 门禁失败）
`docs/tech/改造计划.md` §4.2 表加 `checkpoints` 行、§4.13 台账记本次（问题/方案/验证命令/遗留项）。

## 四、TDD 实施顺序（垂直切片，一步一测试一提交）

1. **影子 git 核心**：`shadow-git-client.test.ts`（真实 git + `mkdtempSync` 临时目录，仿 `sandbox-file.test.ts`）先行——覆盖：init+baseline、增量 commit 只含变化、numstat 统计、恢复三态（修改/新建/删除均精确还原）、忽略目录与嵌套 `.git` 不受影响、空目录跳过、恢复后用户未提交新改动被正确覆盖、中文/空格文件名。→ 实现 exec+client。
2. **服务层**：temp dir + 真实 git + 内存 repository fake——hooks 语义（before/after、失败也打、异常不外泄）、列表、diff、预览、恢复+补打点。
3. **runtime 钩子**：仿 `runtime-cancel-persistence.test.ts`（fake agentFactory）——beforeTurn 时机、finally 里 afterTurn（含 failed/canceled）、hook 抛错不影响终态事件；`hasActiveRunForCanvas`。
4. **契约+路由+仓储**：shared schema、路由归属校验与 unavailable 503、repository 内存 fake 常规测 + PG 真库 `*.integration.test.ts` 默认 skip。
5. **前端**：api 封装、task.checkpoint 归约纯函数测试、chip 与弹窗 UI。
6. **收尾**：Dockerfile、`.env.example`（共享文件，逐 hunk 复核——当前工作区有并行未提交改动，**显式路径 git add，禁 `-A`**）、文档两处、PLUGIN_CATALOG。

每步提交前跑该包测试 + `pnpm typecheck`；最终门禁：`pnpm test`、`pnpm typecheck`、`pnpm lint`。

## 五、实施编排与验证

批准后按你的 `/workflow` 要求用 CreateWorkflow 编排上述 6 个切片（阶段：影子 git 核心 → 服务与路由 → runtime 钩子 → 前端 → 文档与门禁），门禁失败回修循环。

验证命令：
- `pnpm --filter @kenfutwork/shared build && pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- 手工冒烟：`pnpm dev` 后 Code 模式跑两轮，确认消息卡检查点条、diff、回滚、恢复后再回滚全链路。

## 六、风险与边界

- **用户真实仓库**（`projects.work_dir` 指向本机目录）：影子 git excludes `.git` 只读不写；恢复靠预览清单兜底。
- **git 不可用**（自托管未重建镜像）：503 + 可读原因，UI 不出死按钮。
- **首次 baseline 成本**：目录大时一次全量 add；忽略清单挡住 node_modules 后可控。
- **崩溃一致性**：git commit 原子；行插入失败仅缺一行（链条按行驱动，跳过并 warn），不损工作区。
- **遗留项**（记 §4.13）：工具级粒度（deepagents middleware 挂 ToolGateHooks）、保留上限/GC、手动打点、对话回滚联动、侧面板时间线 tab。