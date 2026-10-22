# ZCode 3.16.2 多文件夹项目源码分析

> **角色**：调研。范围为本地项目多目录、项目名称、会话目录及工具使用；依据为官方公开源码。核查日期：2026-10-22。未启动新版 ZCode、安装依赖或执行其测试；下文分别说明源码事实和验证边界。

## 版本与来源

- 新增参考目录：`/Users/shigaoyu/Develop/ReferenceRepo/ZCode`。当前 HEAD 为 `3c5b227649371507ddc4eb46ac5133afe6db1cab`，根 `package.json` 的版本为 `3.16.2`。本文所有新版源码链接固定到此 SHA。[版本文件](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/package.json#L1-L5)
- 比较版本为 `aac4755666d09fdcd70272fcf063c077a639015f`（3.15.1）。其本地入口调用单目录选择器，再把一个路径交给 `onSelectProject`。[3.15.1 单目录入口](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/ui/src/root/openWorkspaceFolderEntry.ts#L3-L45)
- 新 HEAD 的 Git 提交时间为 `2026-10-20T14:23:05+08:00`，提交标题为 `chore: sync ZCode source`。该时间证明源码同步日期。官方 [v3.16.2 Release API](https://api.github.com/repos/zai-org/ZCode/releases/tags/v3.16.2) 本次返回 404，官方 [Release 列表 API](https://api.github.com/repos/zai-org/ZCode/releases?per_page=15) 本次仅返回 v3.14.3，因此本轮未独立确认 v3.16.2 的正式发布日期。
- 参考目录的 `LICENSE` 为 Apache-2.0。本轮只分析源码。[LICENSE](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/LICENSE#L1-L16)

## 一个项目包含多个文件夹

新版把项目表示为独立对象：`id`、`hostId`、`name`、`nameOverridden`、`roots`。每个目录只有 `rootPath`、`position`、`isPrimary` 三个字段；可以指定一个主目录。一个保存动作创建或更新一个项目，并把全部目录写进这个项目，项目 ID 使用 `randomUUID()`。[项目类型](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/contract.ts#L25-L47)、[项目保存](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/project-repository.ts#L227-L297)

SQLite 使用 `projects` 保存项目，使用 `project_roots` 保存目录。目录表的主键为 `(project_id, root_path)`；名称唯一索引为同一个 Host 的未删除项目名称。不同项目可以包含同一个目录，源码未给 `root_path` 设置跨项目唯一索引。[数据库定义](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/schema.ts#L3-L20)

### 选择、保存与确认

| 操作 | 源码中的实际行为 |
| --- | --- |
| 点击添加文件夹 | 本地桌面调用 `IPlatformService.selectDirectories()`，经过 renderer、preload IPC 到 Electron main。原生参数包含 `openDirectory`、`createDirectory`、`multiSelections`。取消返回 `[]`。[平台实现](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/desktop/src/renderer/src/desktopPlatform.ts#L7-L19)、[preload](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/desktop/src/preload/index.ts#L328-L333)、[main](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/desktop/src/main/desktopMainIpcPlatform.ts#L117-L132) |
| 选择多个目录 | 合并进 `ProjectEditor` 草稿，按路径字符串去重。原草稿为空时，第一个目录成为主目录；已有主目录时继续保留。[草稿更新](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectEditor.tsx#L208-L260) |
| 调整主目录、移除目录 | 表单可以指定主目录；移除当前主目录后，把剩余第一个目录作为主目录。只修改草稿。[目录表单](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectEditor.tsx#L561-L623) |
| 保存新项目 | 新项目有目录时，显示包含全部路径的信任确认；取消或关闭确认不会调用保存。之后调用一次 `service.saveProject`，包含全部 `roots` 与 `primaryRoot`。[保存入口](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectEditor.tsx#L311-L361) |
| 编辑已有项目 | 复用同一编辑器和 `saveProject`，传原项目 ID。上述信任确认条件为 `!project && roots.length`，因此已有项目增加目录时，本函数直接提交保存；目录合法性仍由 Host 检查。[保存条件](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectEditor.tsx#L311-L352) |

选择目录只修改草稿。只有保存才提交项目；这个选择动作不创建会话、不启动 Agent。原生选择期间通过 `busy` 禁用表单；异步结果必须通过组件存活与请求代次检查才写回草稿。[选择流程](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectEditor.tsx#L173-L260)、[表单禁用](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectEditor.tsx#L399-L409)、[名称禁用](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectEditor.tsx#L460-L475)

远程 Host 和没有原生能力的 Web/手机使用 `projectService.readDirectory(hostId)`。当前远程项目仅允许一个固定目录；限制依据持有数据库的 `ownerHostId` 检查，请求参数不能把远程项目变成本地多目录项目。[入口选择](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectEditor.tsx#L217-L247)、[远程目录限制](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/remote-policy.ts#L3-L29)

### 名称与目录分别保存

项目菜单有带铅笔图标的编辑入口；编辑器提供名称输入框。用户编辑名称后才在保存参数中发送 `name`，保持原项目 ID。保存函数只更新项目记录和目录记录，没有重命名物理文件夹的操作。[编辑菜单](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectNodeContent.tsx#L130-L153)、[名称输入](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectEditor.tsx#L460-L475)、[保存函数](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/project-repository.ts#L252-L295)

未指定名称时，默认使用目录列表第一个目录的文件夹名；这里取的是 `roots[0]`，用户另选主目录后不一定跟随主目录名称。`nameOverridden` 记录是否由用户指定；清空自定义名称后重新采用默认规则。同 Host 已有同名项目时自动生成 `名称 (2)`、`名称 (3)`，名称分配和保存位于同一写事务。[名称规则](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/project-repository.ts#L227-L269)

## 保存项目之后，会话怎样使用目录

### 新会话

`prepareSession(projectId)` 读取项目主目录作为 `workspacePath`，其余目录作为 `additionalDirectories`。空项目允许没有目录，第一次准备会话时在应用管理的 workspace 目录下建立项目专用文件夹。已配置主目录缺失时直接报错，不改选附加目录，也不重新建立同名空目录。[会话准备](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project/index.ts#L201-L267)

在创建 CLI 会话之前，Host 的 `prepareSessionCreation` 调用 `reserveCreatedTask`，登记会话 ID、项目 ID、原始目录与可选固定附加目录。实际装配已把这些接口连接到 `zcodeAgentService`，并非只有类型声明。[装配](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/node.ts#L2173-L2183)、[创建装配](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/node.ts#L2212-L2227)、[先登记再创建](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/zcode-agent/zcodeAgentService.ts#L3758-L3800)、[持久记录](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/project-repository.ts#L372-L418)

### 已有会话与正在运行的会话

- 已有会话的 `workspacePath` 来自 `tasks.root_path`；修改项目主目录不会改写这个字段。打开历史会话调用 `resolveSessionDirectories`，并校验它仍与该会话原目录及身份一致，不会再次调用新会话的 `prepareSession`。[目录读取](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/project-repository.ts#L84-L111)、[历史导航](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-workspace-navigation/index.ts#L49-L79)
- 附加目录分两种：若 `execution_directories` 保存了数组，恢复使用该数组；若为 `NULL`，读取当前项目全部目录并去除会话自己的 `workspacePath`。普通创建没有显式提供附加目录时写入 `NULL`。因此“已有会话永远使用创建时全部目录”不符合此实现。[读取规则](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/project-repository.ts#L84-L111)、[写入规则](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/project-repository.ts#L399-L417)
- Host 在 `runtime-materialization` 请求和恢复会话时重新解析附加目录；CLI 创建会话执行对象时将这些值传给 `createWorkspaceZCodeApp`，随后写进 `runtimeConfig`。本轮没有发现项目保存直接更新正在执行对象的代码；不能据此声称保存目录会立即改变进行中的运行。[Host 请求](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/zcode-agent/zcodeAgentService.ts#L2491-L2512)、[恢复入口](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/zcode-agent/zcodeAgentService.ts#L4064-L4069)、[CLI 创建](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L3362-L3395)、[执行对象](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L3429-L3468)、[配置](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts#L119-L145)

### 文件浏览、搜索与命令

| 使用位置 | 目录选择 |
| --- | --- |
| 项目查看文件 | 每个 root 都有菜单项，显式选择一个 root 打开文件面板。文件目标记录该 root 的路径和项目显示名称。[菜单](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectNodeContent.tsx#L160-L166)、[目标](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/project-file-navigation.ts#L18-L55) |
| 输入框文件搜索 | 使用会话目录解析结果，或草稿所属项目的 roots，再加入当前 `workspacePath`；分别搜索后按文件路径去重。附加目录文件使用绝对路径作为插入内容。[文件搜索](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/mentions/providers/fileMentionProvider.ts#L94-L143) |
| Agent 的 Grep/Glob | 不指定 `path` 时使用会话工作目录；指定 `path` 时按该路径搜索。工具本身没有自动遍历所有 roots 的循环。[Grep](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/tool/handlers/grep.ts#L32-L66)、[Glob](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/tool/handlers/glob.ts#L25-L56) |
| Agent 的 Bash | 默认 cwd 为会话工作目录，命令内容可以自行 `cd`；成功命令配置了 cwd 捕获，因此后续工具工作目录还可能随命令改变。[Bash](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/tool/handlers/bash.ts#L437-L450) |
| Git 服务 | `getChanges`、分支比较、暂存等均使用请求的单个 `workspacePath`；此服务没有把整个项目多个仓库合并为一个 Git 仓库。[Git 服务](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/git/gitService.ts#L214-L251) |
| 能力发现及模型提示 | 附加目录进入环境提示、Skills 和自定义命令发现。额外 Skills/命令按目录名称建立 namespace。[环境提示](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/context/sections/env-info.ts#L71-L87)、[Skills](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/adapters/src/skills/roots.ts#L50-L67)、[命令](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/adapters/src/commands/roots.ts#L50-L67) |

## 多目录列表与实际访问权限

`ProjectRoot` 没有每目录只读、可写或禁止执行字段。这里可确认的是项目目录集合、主目录和显示顺序；不能从选择了多个目录直接推断每个目录获得怎样的 OS 权限。[目录类型](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/contract.ts#L25-L41)

当前 `resolveWorkspacePath` 接受绝对路径，或按工作目录解析相对路径；该函数明确保留访问 `workspaceRoot` 以外路径的行为。它没有用 `additionalDirectories` 作为允许访问目录清单。工具审批由 `PermissionService` 按工具能力、模式和规则处理；Bash 还把独立 sandbox 参数交给执行适配器。[路径检查](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/tool/path-policy.ts#L15-L58)、[审批模式](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/permission/service.ts#L101-L188)、[Bash sandbox 参数](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/tool/handlers/bash.ts#L458-L461)

因此，此处源码能够证明“该路径检查函数允许目录范围以外的路径”和“项目目录记录没有每目录读写设置”。本轮没有审查全部工具、OS 沙箱和安装版运行行为，不将这两个事实扩展为整个产品没有访问限制。

## 目录校验及失效处理

- 保存时在所属 Host 要求绝对路径，调用 `path.normalize` 后去重，并对全部输入目录执行 `stat().isDirectory()`；主目录必须属于 roots。当前这里没有调用 `realpath`，因此本段流程未按符号链接的实际目标合并目录，也没有单独检查操作系统写入权限。[Host 校验](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project/index.ts#L143-L168)、[主目录校验](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/project-repository.ts#L237-L251)
- 读取项目时重新检查主目录，区分 `available`、`missing`、`unavailable`；状态不写入数据库。新会话准备时再次检查主目录。本段读取只检查主目录，附加目录失效不会通过这个状态字段禁用整个项目。[主目录状态](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project/index.ts#L29-L54)、[准备时复检](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project/index.ts#L243-L267)
- 删除项目只设置删除标记，保留目录记录和会话；重新创建时，编辑器会检查同 Host、同目录集合的已删除项目并询问恢复。保存时恢复检查也要求相同目录集合。[删除](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/project-repository.ts#L319-L325)、[恢复提示](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/project-sidebar/ProjectEditor.tsx#L279-L309)、[恢复校验](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/project-storage/project-repository.ts#L239-L245)

## 与 KFW 的比较

KFW 核查基于 `500cbdb46327c471cbb3b2a5ecab038d8c30f6d9` 的当前源码。原 UI 来源清单仍登记 ZCode 3.14.3；新增参考目录不会自动升级正在运行的 KFW。[来源清单](../../packages/third-party/zcode/来源清单.json) 第 1–4 行。

### 已有能力与界面差距

| 项目 | ZCode 3.16.2 | KFW 当前实现 |
| --- | --- | --- |
| 项目身份 | UUID 项目包含多个 roots | UUID 项目包含 `work_dir` 和 `additional_directories`；附加目录还保存 `access`。数据结构已经支持多个目录。[K1][K2] |
| 一次选择多个目录 | 原生多选后，在同一个项目编辑器中确认保存 | 打开文件夹函数、目录浏览器和 `workspace.open` RPC 都只接受一个路径。现有多目录数据能力尚未通过这个入口提供给用户。[K3] |
| 项目名称 | 编辑项目名称并持久保存，保持项目 ID | 项目 PATCH 已支持 `name`，数据库只修改名称；本次检查的项目行菜单没有项目编辑入口。`renameTask` 修改的是会话名称，不能作为项目改名已经完成的证据。[K4] |
| 主目录 | 新会话使用项目当前主目录；旧会话保留原始目录 | 普通项目 PATCH 拒绝变更主目录。目录缺失时通过专门的重新关联流程处理。不能直接连接新版编辑器的任意切换主目录操作。[K5] |
| 附加目录影响旧会话 | 未固定 `execution_directories` 的会话恢复时读取项目当前 roots | 新建 Task 时复制项目目录列表；读取已有 Task 时使用该 Task 保存的目录。修改项目附加目录不会通过这些函数重写已有 Task。[K6] |
| 每目录读写权限 | ProjectRoot 未保存每目录读写设置 | 保存 `read-only`／`read-write`，文件工具解析真实路径后检查 Task 授权。完全访问模式在此检查中允许操作系统账户可访问的路径；仍有角色等其它限制。[K2][K7] |
| 默认命令与搜索位置 | 以会话工作目录为默认位置，部分界面搜索遍历全部 roots | 命令默认使用 Task 主目录，也接受授权目录内的指定 cwd；Grep／Glob 默认使用主目录，指定路径经过权限检查。[K8] |

这些差距主要在项目编辑和目录展示的完整连接。KFW 已有目录数据、Task 身份和权限服务，采用新版交互时可以继续使用这些服务。

### 适合采用的交互及适配要求

1. **复用项目编辑器**：统一提供项目名称、目录列表、添加和移除操作；多个选择结果先进入草稿，确认后保存，取消保持原项目。现有单目录入口需要同时修改平台接口、宿主适配和保存参数，单独复制弹窗不足以完成该功能。[K3]
2. **连接已有项目 API**：名称继续更新原 `projectId`；主目录使用 `work_dir`，附加目录使用 `additional_directories`。附加目录逐项显示只读／可写设置，并由服务端校验真实路径。普通编辑器中的主目录保持固定；目录恢复继续使用已有的专门流程。[K1][K2][K5]
3. **分别处理项目和 Task 授权**：编辑项目目录列表影响之后创建的 Task。已有 Task 需要独立、明确的授权操作；现有 scope API 已支持更新附加目录，更新时提高授权版本并关闭旧执行资源，不能直接修改项目后让旧任务自动获得新权限。[K6][K7]
4. **补充多目录使用入口**：项目文件菜单可以选择具体目录，文件搜索应标明来源目录；同名文件使用可区分的路径。默认命令位置继续明确显示，Git 操作针对选定目录，不把多个仓库当作一个仓库。文件仍通过统一内容标签打开，保持 KFW 已确认的画布行为。[K8][K9]

上面是根据源码提出的适配建议，本轮没有修改 KFW 运行行为，也没有引入 ZCode 的项目数据库或 CLI。

### 实施时需要验证的情况

| 场景 | 预期行为 |
| --- | --- |
| 一次选择前端、后端、素材三个目录 | 创建一个项目；主目录明确，其余目录分别显示读写设置 |
| 选择后取消、关闭弹窗或异步选择迟到 | 保留原项目名称、目录和权限 |
| 修改项目名称后重启、打开历史会话 | 名称保存，项目 ID、物理目录与会话归属保持一致 |
| 项目新增附加目录，同时有历史 Task 和正在运行的 Task | 新 Task 使用新设置；旧 Task 的目录权限保持原值 |
| 显式撤销旧 Task 的目录授权 | 旧执行资源关闭后才完成授权更新；旧请求不能继续使用已撤销目录 |
| 重复目录、符号链接、已关联另一项目的目录 | 服务端按真实路径处理；保留 KFW 的复用或独立创建选择 |
| 主目录缺失、附加目录缺失、只读目录写入 | 返回对应原因；不自动改用其它目录或增加权限 |
| 多目录同名文件、多个 Git 仓库、Design 正在编辑画布 | 文件来源清楚，Git 目标清楚；项目编辑与 Agent 操作不切换当前画布 |

### KFW 源码依据

- **[K1] 项目目录与身份**：[project-service.ts](../../apps/server/src/features/projects/project-service.ts) 第 190–222 行；[repository.ts](../../apps/server/src/features/projects/repository.ts) 第 8–38、238–281 行；[http.ts](../../packages/shared/src/http.ts) 第 41–55、783–792 行。
- **[K2] 目录设置与规范化**：[execution-contracts.ts](../../packages/shared/src/execution-contracts.ts) 第 3–35 行；[work-dir.ts](../../apps/server/src/features/projects/work-dir.ts) 第 45–123 行。附加目录经 `realpathSync` 解析后保存读写设置；这里的映射函数本身没有执行目录去重。
- **[K3] 单目录界面与 RPC**：[openWorkspaceFolderEntry.ts](../../apps/web/src/components/workbench/zcode/root/openWorkspaceFolderEntry.ts) 第 3–35 行；[DirectoryBrowser.tsx](../../apps/web/src/components/workbench/zcode/DirectoryBrowser.tsx) 第 47–65 行；[httpChannelClient.ts](../../apps/web/src/components/workbench/zcode/host/httpChannelClient.ts) 第 304–344 行；[workspace-rpc.ts](../../apps/server/src/features/code-ui/workspace-rpc.ts) 第 441–463 行。
- **[K4] 项目与会话名称**：[project-service.ts](../../apps/server/src/features/projects/project-service.ts) 第 373–375 行；[repository.ts](../../apps/server/src/features/projects/repository.ts) 第 245–248 行；[WorkspaceSidebarItem.tsx](../../apps/web/src/components/workbench/zcode/WorkspaceSidebarItem.tsx) 第 476–496、923–949 行。项目刷新后，标签名称来自项目记录，见 [SharedProjectNavigation.tsx](../../apps/web/src/components/workbench/zcode/host/SharedProjectNavigation.tsx) 第 63–73 行。
- **[K5] 固定主目录与恢复**：[project-service.ts](../../apps/server/src/features/projects/project-service.ts) 第 376–401 行；专门的恢复实现见 [directory-relink.ts](../../apps/server/src/features/projects/directory-relink.ts) 和 [ProjectDirectoryRecovery.tsx](../../apps/web/src/components/workbench/zcode/host/ProjectDirectoryRecovery.tsx)。
- **[K6] Task 目录保存和读取**：[service.ts](../../apps/server/src/features/code-ui/service.ts) 第 5025–5078、5099–5108 行；[repository.ts](../../apps/server/src/features/code-ui/repository.ts) 第 284–299 行。
- **[K7] 真实权限与授权更新**：[scope-service.ts](../../apps/server/src/features/execution/scope-service.ts) 第 85–104、183–217、509–620 行；[execution-scopes.ts](../../apps/server/src/http/execution-scopes.ts) 第 20–75 行。
- **[K8] 命令、文件与搜索**：[policy.ts](../../apps/server/src/features/process-sandbox/policy.ts) 第 18–35 行；[file-search.ts](../../apps/server/src/features/code-tools/file-search.ts) 第 85–96、169–180 行；[prompt.ts](../../apps/server/src/features/execution/prompt.ts) 第 11–34 行。
- **[K9] 项目与 Task 文件访问**：[service.ts](../../apps/server/src/features/code-ui/service.ts) 第 4777–4810 行；画布与统一标签行为见 [Code工作域与工具内核实施规格.md](../方案设计/Code工作域与工具内核实施规格.md) 的「Code/Design 统一实施」。

## 验证边界

本轮只读检查了固定版本的 UI、平台 IPC、项目服务、SQLite 保存、会话准备、Host 到 CLI 的目录传递和部分工具消费代码。版本检查执行 `node scripts/check-workspace-freshness.mjs --no-fetch`，结果为本地 main 与已知 `origin/main` 一致；该命令未联网更新远端引用。未运行新版 GUI、原生目录选择、真实模型、多窗口交互或其测试，源码行为不代替这些运行验证。

KFW 文档检查执行 `pnpm test:docs`，57 个 Markdown 文件通过；`git diff --check` 通过。本轮没有修改运行代码，未运行全包 tests、typecheck 或新版桌面验证。
