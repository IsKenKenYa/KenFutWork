# Code 宿主 Git 服务接线方案

> 状态：方案稿，2026-11-04。未实施。事实取自当前分支「啃啃在开发」的源码、测试与提交记录，用户确认后再决定实施顺序。

## 1. 现状结论

- 前端实际调用 `gitService` 的 13 个方法，共 21 处调用。
- 服务端 Code 宿主已接通 10 个只读方法，并明确拒绝 8 个写方法。
- 8 个写方法里，7 个在 Task 作用域具备实现条件，项目作用域因只读租约全部不能写；`generateCommitMessage` 当前没有服务端实现。
- 前端另有 5 个接口方法没有真实调用；`useGitActions` 里的暂存、取消暂存、撤销、提交、刷新只是占位提示，不发请求。
- 本方案不修改 `IGitService` 接口。宿主通道按方法名动态转发，新增方法不需要改前端类型；只有返回字段需要增补时才改 `packages/zcode-shared` 的 Git 类型。

## 2. 前端调用清单

调用入口在 `apps/web/src/components/workbench/zcode/host/httpChannelClient.ts` 与 `remoteServiceAccess.ts`，通过 `IGitService.channelName` 取通道。通道层自动把 `viewerScope`（项目或 Task）与 `workspaceIdentity` 注入第一个参数，前端调用点只传业务字段。

| 方法 | 调用位置 | 传入参数 | 期望返回字段 | 当前宿主状态 |
| --- | --- | --- | --- | --- |
| `refresh` | `hooks/useGitRepository.ts:467` | `workspacePath`、`includeIdentity`、`includeBranchComparison` | `summary`、`identity`、`unstagedChanges`、`stagedChanges`、`branchComparison` | 已接通 |
| `refresh` | `GitActionMenu.tsx:930` | `workspacePath`、`includeIdentity` | `summary`、`identity`、`unstagedChanges`、`stagedChanges` | 已接通 |
| `refresh` | `workspace-file-tree/gitStatus.ts:17` | `workspacePath` | `summary`、`unstagedChanges`、`stagedChanges` | 已接通 |
| `getLocalBranches` | `hooks/useGitBranchSwitcher.ts:71` | `workspacePath` | `headRefType`、`currentBranchName`、`branches` | 已接通 |
| `getCommitGraph` | `git-graph/GitGraphDialog.tsx:59`、`:98`、`:128` | `workspacePath`、`maxCount`、`skip` | `commits`、`hasMore` | 已接通 |
| `getChanges` | `git-branch-switcher/switchAssist.ts:55`、`:59` | `workspacePath`、`sourceId`（`unstaged` / `staged`） | `GitFileChange[]` | 已接通 |
| `getIdentity` | `git-branch-switcher/switchAssist.ts:63` | `workspacePath` | `userName`、`userEmail`、`nameSource`、`emailSource`、`scopeLabel` | 已接通 |
| `getDiff` | `GitPane.tsx:213` | `workspacePath`、`path`、`sourceId` | `availability`、`patch`、`beforeContent`、`afterContent`、`summary` | 已接通；`last-turn` 拒绝 |
| `getIgnoredPaths` | `workspace-file-tree/useWorkspaceFileTreeData.ts:238` | `workspacePath`、`paths` | `string[]` | 已接通 |
| `switchBranch` | `hooks/useGitBranchSwitcher.ts:252`、`:352` | `workspacePath`、`targetBranchName` | `ok`、`action`、`branchName`、`didChange`、`created`、`summary`、`issues` | 宿主拒绝 |
| `createBranchAndSwitch` | `hooks/useGitBranchSwitcher.ts:284` | `workspacePath`、`branchName` | 同上 | 宿主拒绝 |
| `stagePaths` | `GitActionMenu.tsx:1173`、`hooks/useGitBranchSwitcher.ts:341` | `workspacePath`、`paths` | 无 | 宿主拒绝 |
| `commit` | `GitActionMenu.tsx:1178`、`hooks/useGitBranchSwitcher.ts:346` | `workspacePath`、`message`、`paths`、`stagedOnly` | `commitHash`、`summary` | 宿主拒绝 |
| `push` | `GitActionMenu.tsx:1081` | `workspacePath` | `branchName`、`trackingBranchName`、`remoteName`、`setUpstream`、`summary` | 宿主拒绝 |
| `generateCommitMessage` | `GitActionMenu.tsx:1002` | `workspacePath`、`workspaceIdentity`、`locale`、`includeUnstaged`、`currentSessionFilePaths`、`conversationContext` | `message`、`providerId`、`model` | 宿主拒绝 |

接口里存在、当前前端没有真实调用的方法：

- `getRepositorySummary`
- `getWorkspaceRepositoryInfo`
- `getBranchComparison`
- `unstagePaths`
- `discardPaths`

`useGitActions.ts` 中的 `stagePaths`、`unstagePaths`、`discardPaths`、`commit`、`refresh` 只记录日志并弹出 `diff.placeholder.toast`，不调用 `gitService`。`WorktreeMenu` 走 `/api/code/git` 的 HTTP 接口，不经过 `gitService`。

## 3. 服务端现状

### 3.1 已接通的只读方法

`apps/server/src/features/code-ui/host-git-rpc.ts` 的只读集合包含：

`getRepositorySummary`、`getWorkspaceRepositoryInfo`、`getLocalBranches`、`getCommitGraph`、`getChanges`、`getIgnoredPaths`、`getDiff`、`getBranchComparison`、`getIdentity`、`refresh`。

实现要点：

- `refresh` 一次返回 `summary`、可选的 `identity`、`unstagedChanges`、`stagedChanges`、可选的 `branchComparison`，与前端三处调用一致。
- `getDiff` 支持 `staged`、`unstaged`、`branch`；`last-turn` 直接拒绝，提示「上一轮差异必须经真实会话文件变更入口读取」。
- 所有方法先校验连接身份与目标实例一致，再校验目标目录与可信来源一致。
- 项目作用域走 `project-git-session.ts`：读取项目行时要求 `archived_at is null`、`archive_state = 'open'`、已启用 `code` 或 `design`，缺失返回 404「项目读取来源已失效，请重新打开文件面板」。
- Task 作用域走 `executionScopes.openTask(...).derive("review", ...)`：Task 删除或不属于当前实例返回 404；执行授权处于撤销中或撤销失败返回 409。
- 项目会话只打开只读租约 `openProjectReadLease`，`resolvePath` 收到写操作时直接返回 403「项目文件面板仅支持读取，请在任务中修改文件」。
- 路径先经 `session.resolvePath` 解析真实路径，再经 `host-git-repository.ts` 的 `paths()` 校验是否位于仓库根内；NUL 路径拒绝；路径数量超过 `codeSearchMaxResults` 拒绝。
- 附加授权目录按只读处理，并且不套用主仓库的忽略规则。
- Git 命令由 `git-client.js` 执行，参数以数组传递，不经 shell。

### 3.2 明确拒绝的写方法

`host-git-rpc.ts` 的不可用集合：

`switchBranch`、`createBranchAndSwitch`、`stagePaths`、`unstagePaths`、`discardPaths`、`generateCommitMessage`、`commit`、`push`。

调用任一方法返回错误「当前Git宿主尚不支持 <method>，该能力仍未接通」。

### 3.3 Task 级 HTTP Git 能力

`apps/server/src/features/code-git/code-git-service.ts` 已有 Task 作用域能力，入口在 `/api/code/git`：

- 只读：`status`、`diffStat`、`graph`、`changes`、`fileDiff`、`readFile`、`listFiles`、`listWorktrees`
- 写：`checkout`、`setFileStaged`（暂存 / 取消暂存单个文件）、`applyFileHunk`、`discardFile`、`discardAllChanges`、`init`、`commit`、`push`、`createBranch`、`createWorktree`、`deleteWorktree`
- 终端：`runTerminal`

这些能力全部要求真实 `taskId`，并由执行作用域校验归属。它们与 `gitService` 的请求形状、返回字段和路径口径不同，不能直接按方法名转发。

## 4. 能力分类

### 4.1 能接（已完成）

10 个只读方法已经接通，不需要再改。现有测试覆盖：

- `host-git-rpc.test.ts` 使用真实临时仓库验证 staged / unstaged 内容、未跟踪文件行数、rename 路径、graph 引用、ignore 与分支、越界路径、连接身份、写操作拒绝。
- `project-git.integration.test.ts` 验证没有 Task 的项目读取、非仓库空忽略列表、目录外请求拒绝、附加目录撤销后拒绝。
- `task-git-isolation.integration.test.ts` 验证 Task 提交只进入自己的临时仓库，主仓 HEAD 不变。

边界：

- 只读，不写数据库，不写 Git 索引和引用。
- 项目读取在数据库只读事务内完成，只打开只读租约。
- 路径限制在仓库根内；附加授权目录只读，不继承主仓库忽略规则。
- 项目归档、项目删除、Task 删除、执行授权撤销、连接身份不匹配都会拒绝，并给出可读原因。

### 4.2 只能部分接

这一类的共同边界：只在 Task 作用域可行，路径必须同时通过 `scope.resolvePath(path, "write")` 与仓库根校验；只读 Task、已删除 Task、撤销中的 Task、项目作用域都拒绝；不写数据库，只改 Git 索引、工作区或引用；全部属于不安全操作，禁止自动重试。

| 方法 | 可接部分 | 缺口 | 工作量 |
| --- | --- | --- | --- |
| `getDiff` 的 `last-turn` | `staged`、`unstaged`、`branch` 已接通 | `last-turn` 必须读真实会话的文件变更记录，不能由 `git diff` 伪造 | 小到中；复用 `file-changes.ts` / `owned-history.ts` 的既有入口 |
| `switchBranch` | Task 作用域可执行 `git switch`，返回新的 `summary` | `GitBranchMutationResult.issues` 需要把 Git 错误映射为分支问题码，否则前端“提交后切换”辅助流程不出现 | 中；错误映射是主要工作 |
| `createBranchAndSwitch` | Task 作用域可执行 `git switch -c` | 同上，另需保留 `created` 与 `didChange` 语义 | 中 |
| `stagePaths` | Task 作用域可逐路径 `git add` 或 `git restore --staged` | 需要批量路径授权、数量上限与部分失败时的可读结果 | 小 |
| `unstagePaths` | 与 `stagePaths` 同一实现路径 | 前端当前没有真实调用，只有占位按钮 | 小；补消费方后才能验收 |
| `commit` | Task 作用域可执行提交 | 现有 `CodeGitService.commit` 是 `add -A` 后提交全部改动，不遵守前端的 `paths` 与 `stagedOnly`；`CodeGitStatus` 不含 `commitHash` | 中；需要按选中路径提交并回读 HEAD |
| `discardPaths` | Task 作用域可撤销已跟踪文件改动，未跟踪文件需要删除 | 前端当前没有真实调用；删除未跟踪文件不可恢复，需要明确确认语义 | 中 |
| `push` | Task 作用域可执行 `git push` | 需要解析 `branchName`、`trackingBranchName`、`remoteName`、`setUpstream`；无上游分支要返回可读原因 | 中 |

补充说明：

- 前端在提交前检查 `GitIdentity`。宿主侧也必须在提交入口检查 `user.name` 与 `user.email`，缺失时返回可读原因，不能等 Git 报英文错误。
- `GitActionMenu` 的提交流程会先 `stagePaths` 再 `commit`。两步失败可能留下已暂存但未提交的状态，返回值必须如实说明“已提交 / 未提交”，不能把部分成功报成整体失败或整体成功。
- 同一 Task 的写操作没有宿主级互斥。Git 自身的 `index.lock` 会在并发写时失败，宿主需要把该错误转成可读原因；不新增数据库锁。
- `push` 有网络外部副作用，属于不安全操作，不能自动重试；`commit`、`discard` 同样不能重试。

### 4.3 当前无法接

| 能力 | 原因 | 需要的前置条件 | 工作量 |
| --- | --- | --- | --- |
| `generateCommitMessage` | 服务端没有提交消息生成服务；模型选择、Provider 调用、会话上下文裁剪都不存在 | 新建模型调用能力，复用实例模型设置与 BYOK 边界；只使用前端传入的 `conversationContext`，不额外读取会话内容 | 大 |
| 项目作用域的 7 个写方法 | 项目会话只打开只读租约，`resolvePath` 对写操作固定返回 403，项目文件面板按产品规则只读 | 需要产品确认项目面板是否允许写；确认后要新增写租约、写权限代际与并发保护 | 大；涉及产品行为不变量 |
| `getRepositorySummary`、`getWorkspaceRepositoryInfo`、`getBranchComparison` | 宿主已经接通，但前端当前没有调用点 | 需要真实消费方；只补方法没有验收对象 | 小；当前无消费方，暂不接 |
| `unstagePaths`、`discardPaths` | 宿主未接通，前端也只有占位按钮 | 需要把占位按钮改为真实调用，并补确认与错误展示 | 小到中；当前无消费方，暂不接 |
| 工作树创建与删除 | 不在 `IGitService` 接口内，属于 `/api/code/git` 的独立 HTTP 能力 | 若要迁入宿主通道，需要扩充接口与前端调用 | 中；不属于本方案范围 |

## 5. 实施顺序建议

用户确认后按以下顺序，每一步可独立提交并带测试：

1. `stagePaths`、`unstagePaths`、`commit`：先补 Task 作用域写路径与选中路径提交语义，覆盖真实临时仓库、部分失败、只读 Task、已删除 Task、路径越界、并发 `index.lock`。
2. `switchBranch`、`createBranchAndSwitch`：补错误码映射，覆盖分支已存在、目标不存在、覆盖风险、冲突、进行中操作、其他工作树占用。
3. `push`：补结果字段解析与无上游分支错误，覆盖成功、无上游、远端拒绝、网络失败。
4. `discardPaths`：补撤销与未跟踪删除，覆盖确认语义与不可恢复提示。
5. `getDiff` 的 `last-turn`：接真实会话文件变更记录，覆盖没有上一轮、上一轮跨会话、记录缺失。
6. `generateCommitMessage`：单独设计模型调用与上下文边界，最后实施。
7. 项目作用域写能力：等待产品确认，不进入前六步。

## 6. 测试要求

所有实施必须使用真实临时仓库与真实文件系统，禁止 mock Git 行为。每个写方法至少覆盖：

- 正常路径与返回字段完整。
- 路径逃逸、符号链接、NUL、数量超限。
- 只读 Task、已删除 Task、撤销中 Task、项目归档。
- 连接身份或实例不匹配。
- 删除后的迟到请求。
- 同一 Task 并发写与 `index.lock`。
- 部分失败后的真实状态与可读错误。
- 不安全操作不自动重试。
