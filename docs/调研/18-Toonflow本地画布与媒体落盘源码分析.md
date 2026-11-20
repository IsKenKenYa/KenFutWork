# Toonflow 本地画布与媒体落盘源码分析

调研日期：2026-10-17。对象：[HBAI-Ltd/Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app)，本地浅克隆 `references/toonflow-app`，固定提交 [`d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d`](https://github.com/HBAI-Ltd/Toonflow-app/tree/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d)。本次只读源码，没有安装依赖、运行其脚本、启动应用或验证供应商线上行为。下文源码链接均冻结到该提交。

许可证是 MIT，版权人为 `Copyright (c) 2026 HBAI-Ltd`；许可要求保留版权和许可声明。[S01]

## 结论

**事实：Toonflow 的“本地文件夹 + 画布创作”并不要求取消媒体大小限制。** 它将画布图结构存为 JSON，将图片、视频等真实文件放在工作目录的 `assets/` 中，节点仅持有文件相对路径和 MIME。生成结果按媒体专用链路下载、校验、原子写入，不经过文本编辑补丁通道。生成参考及产物的通用上限是 **每文件 100 MiB（代码文案写 100 MB）**，不是工作目录累计容量。[S02][S03][S04][S05]

**事实：至少有四种不同的预算，不能合并解释。** 媒体文件是 100 MiB；聊天远程图片导入是 20 MiB；发给语言模型的图片发送版另做约 1 MiB 目标的缩放；语言模型请求默认图片内联总预算 20 MiB、整个请求 32 MiB。这些都不是“整个工作目录只能用多少 MB”。[S02][S13][S14][S15]

**推断：本项目可借鉴的核心是按操作语义分流。** 文本补丁预算约束编辑操作；媒体产物预算约束生成、下载和发布。几 MB 的生成图片本应在媒体预算内评估，不应因复用了文本补丁的 1 MiB 门槛而失败。该结论不等于照搬 Toonflow 的上限数值，也不等于放宽 Task 授权、文件 CAS 或执行代际。

**事实与边界：Toonflow 当前链路偏向单进程、已打开画布驱动。** 它有路径约束、进程内锁、原子文件发布、局部失败清理，但画布保存明确不处理多客户端并发；媒体生成任务状态主要在节点内存及请求内轮询中，不提供本链路跨重启恢复的证据。这部分不能替代本项目的持久 Task 和执行作用域。[S04][S06][S07][S08][S10]

## 真实链路

```text
用户打开文件夹
  → 服务端校验并解析真实工作目录
  → 打开/创建画布 JSON（节点、连线、视口）
  → 图片/视频节点从引用节点取得媒体相对路径
  → /api/ai/media/generate 或 Agent 媒体工具
  → 共用 generateMedia(cwd, mediaType, request)
  → 读取参考文件 → 供应商适配器提交/轮询
  → URL / base64 / binary 统一转为字节
  → 类型与每文件 100 MiB 校验
  → 临时文件写完后发布至 assets/<节点 ID>/ 或 assets/generated/
  → 返回相对路径、MIME、媒体类型
  → 节点更新当前输出 → 自动保存画布 JSON
  → 重新打开：恢复节点输出 → 按相对路径读取文件 → Blob URL 预览
```

这是一条“文件内容”和“画布引用”分离的链路，而不是将画布图片嵌入 JSON 后再让 Agent 修改一整份 JSON。[S02][S03][S04][S05][S09][S11]

### 1. 项目与画布如何绑定本地文件夹

前端项目身份包含 `directory`、名称及最近打开时间；`openProject()` 调 `/api/workspaces/check`，以服务端返回的真实目录为准。项目列表通过 Pinia 持久化，项目在这里首先是“一个目录”，并非本项目的持久 Task 模型。[S16]

服务端 `resolveWorkspace()` 要求绝对路径、解析 `realpath` 并确认目录存在。本地运行且满足本机请求条件时允许该目录；移动端请求限定在配置的目录范围，服务器部署限定在自身数据目录下的 `workspaces/`。[S17]

画布是目录中的 JSON 文件：新建默认写入 `{ toonflowCanvas: true, nodes, edges, viewport }`，文件以排他方式创建；打开时读取、校验数据，再恢复节点、连线和视口。`readCanvasFiles()` 扫描画布时跳过名为 `assets` 的目录。[S03][S05]

**推断：** 文件夹可连同 JSON 和 `assets/` 作为一个可理解的项目载体；单独复制 JSON 不一定完整，因为它可能引用节点目录以外的公共媒体。上游复制画布时专门为节点目录复制文件、改写节点 ID 与路径，公共素材仍引用原文件，说明“一个 JSON 就是完整项目”不成立。[S18]

### 2. 节点与 Agent 两条入口，共用媒体服务

图片节点将输出目录设为 `assets/<节点 ID>`，引用图以 `{ path, mimeType }` 传递；视频节点同样设置该目录，并按模型模式组织普通参考、首尾帧、视频与音频参考。节点通过 `ai.generateImage()` / `ai.generateVideo()` 调 `/api/ai/media/generate`。[S09][S11][S19]

服务端路由先校验目录和生成参数，调用 `resolveWorkspace()`，再调用 `generateMedia()`；请求断开时通过 AbortController 取消。为等待较长的生成，它在同一 JSON 响应中每 20 秒写一个换行保活，并非把任务转存到持久队列。[S20]

Agent 的直接媒体工具使用同一个 `generateMedia(cwd, ...)`，缺少工作目录时不提供媒体能力。工具说明要求先查询真实模型，生成完成后返回已保存的文件路径，明确不返回 Base64；图片在消息中呈现为相对路径 Markdown 预览。[S21][S22]

另一条 Agent 路径是调用画布工具。画布插件将操作发给运行中的 `canvas.call()`，说明明确要求通过画布工具操作激活画布，不直接改画布 JSON；图片/视频节点又暴露自己的设置提示词、启动生成、查状态、取消生成等工具。[S07][S09][S11][S23]

**分工事实：** Agent 负责选择模型、提示词、参考和节点动作；运行中的画布/节点负责交互状态、节点输出和画布持久化；媒体服务及供应商适配器负责实际调用和文件保存。直接媒体工具完成落盘也不自动证明“已经把结果加入画布”，因为该工具仅返回路径，画布操作是另一组工具。[S21][S22][S23]

### 3. 供应商结果如何成为真实文件

`generateMedia()` 的默认输出目录为 `assets/generated`，画布节点显式覆盖为自己的目录。它先检查模型存在且类型匹配、所需 API Key 已配置，再顺序读取本地引用；`readReference()` 分别用文件 stat 和读取后实际字节数校验每份参考媒体，将其作为 Base64 输入交给供应商。[S02][S09][S11]

适配器可返回 URL、Base64 或 binary；宿主 `assetBytes()` 统一转成字节，校验返回媒体类型、Base64 结构、非空、大小，以及实际检测出的 MIME 与允许扩展名。URL 下载先检查 `Content-Length`，随后读取流时对本次文件累计计数，超限即停止；最终仍有字节数校验。不能仅伪造小的或缺失的 `Content-Length` 绕过该检查。[S02]

例如 APIMart 图片适配器提交生成任务、取得 task ID、轮询到完成后只返回结果 URL；视频也是先提交、后轮询、最后返回 URL。TF-router 的图片/视频方法同样收敛到 `generateTask()`。供应商返回 URL 并不是流程终点，本地文件写入在宿主统一执行。[S08][S24]

对每个结果，宿主先解析输出目录、加目录锁、创建目录，再生成带 UUID 的文件名。`writeWorkspaceFile(path, bytes, true)` 排他发布，返回值是工作区相对路径、MIME 和媒体类型。该返回值没有内嵌媒体字节，也不含完整的宽高、duration、内容哈希等资产元数据。[S02][S04]

**事实：该实现下载时使用流检查大小，但并未直接流式写磁盘。** `downloadAsset()` 将 chunks 保存在内存后 `Buffer.concat()`，之后才写文件；参考媒体也整文件读取并编码。因此 100 MiB 是接受阈值，不能读作“这条链路只用常数内存”或“100 MiB 已经过本机压力验证”。[S02]

### 4. 落盘后的引用、历史与重新打开

生成完成后，图片/视频节点仅把 `{ url: result.path, mimeType }` 写入当前输出。节点骨架将输出同步给 `node.data.outputs`；画布深度监听节点 data，并在保存时将节点、连线、视口写回 JSON。[S09][S11][S25][S06]

重新打开时，画布读回 JSON；`useNode()` 从 `node.data.outputs` 恢复类型匹配的输出。预览通过工作区文件 API 读取路径并构造 Blob URL。`acquireUrl()` 以目录、路径和 MIME 为键共享一次读取、引用计数；最后一个使用者离开时撤销 Blob URL，写文件后还会使相关 URL 缓存失效。这是浏览器预览缓存，不是磁盘空间配额，也不是把媒体再次写回画布 JSON。[S05][S26][S27]

媒体历史不靠一张数据库表列举每次生成：`mediaHistory.vue` 打开时列出 `assets/<节点 ID>`，以扩展名识别媒体，只读取选中的文件进行预览；每页展示 20 条，目录列表本身仍一次读取。设为当前结果只是发出所选路径和 MIME。历史文件因此可以在当前输出改变后继续保留。[S28]

## 大小、容量与缓存：各自限制什么

为避免混用，下表将源码使用 `1024 * 1024` 的值写为 MiB；上游界面错误文案多写 MB。

| 路径/对象 | 代码中的限制 | 单文件还是累计 | 证据与边界 |
| --- | --- | --- | --- |
| 生成输入的本地参考媒体 | 100 MiB，且必须是非空普通文件 | 每份参考文件 | `readReference()`；没有在该函数汇总全部参考文件的总字节数。[S02] |
| 生成输出（图片/视频/音频） | 100 MiB，且非空、格式匹配 | 每个结果文件 | Content-Length 预检、单次下载流累计、Base64 长度及最终 bytes 检查；不是目录累计。[S02] |
| 工作区文件 HTTP 写入、素材保存 HTTP 写入 | 请求体 `100mb` | 单次 HTTP body | `express.raw`；服务端内部 `generateMedia()` 调文件 API，不经过这个 HTTP 原始体解析器，仍受自己的媒体 100 MiB 检查。[S02][S29] |
| 全局素材库读写/导入 | 100 MiB | 每文件 | 数据目录的全局 `assets` 与项目 `assets/` 是不同位置；导入会复制到项目并返回相对路径。[S30] |
| 聊天远程图片导入 | 20 MiB，30 秒超时 | 每张下载图片 | `assets/chatImages/<URL哈希>.<扩展名>`；同目录同 URL 的 in-flight 请求复用，已存在合格文件可复用。[S13] |
| 语言模型图片附件发送版 | 2048 × 2048 最大边界，约 1 MiB 的缩放目标 | 每张发送版；原图另存 | 缓存文件记录发送版与 sourcePath，后续复用；这不是生成产物存储限额。[S14] |
| 语言模型请求 | 默认图片内联总预算 20 MiB；整个 JSON 请求 32 MiB，可由配置覆盖 | 一次模型请求累计 | 超预算卸载旧图片观察并重建请求；上游 413 也有有限恢复。这不是媒体生成落盘配额。[S15] |
| 预览 Blob URL | 引用计数共享、无人使用时释放 | 缓存生命周期 | 所读文件本体位于磁盘；此缓存没有给项目目录设总容量。[S27] |
| 文本快照读取 | 可选 `maxBytes` 最大 20 MiB | 本次文本读取 | 参数可不传；只在 snapshot 路径显式给出时执行该大小检查。[S31] |

**未发现的能力，严格限定范围：** 在本次追踪的工作区、媒体生成、项目/全局素材读写和预览链路中，没有看到对整个工作目录或整个素材目录递归求和后实施容量配额，也没有看到磁盘剩余空间预检。这里的 `size += value.byteLength` 仅累加当前下载响应，不会把目录已有的几 MB 与新图片相加。[S02][S04][S13][S27][S29][S30]

这不是“源码证明永远没有容量限制”：操作系统可报磁盘满，部署反向代理和具体供应商可能另有限制；本次没有启动应用、验证部署或请求供应商，不能将这些外部限制报为已核验事实。插件/团队 ZIP 的累计大小限制属于另一个业务，不能外推成媒体目录容量限制。

## 失败、重试、幂等与恢复

| 情况 | 已确认行为 | 不应夸大的部分 |
| --- | --- | --- |
| 结果下载 HTTP 失败/超限/格式错误 | `downloadAsset()` / `assetBytes()` 抛错，媒体服务清理本次已写的文件。[S02] | 没有在该下载函数发现重试、断点续传或已完成 URL 的恢复记录。 |
| 一次调用返回多个媒体，后一个失败 | `written[]` 只记录本次创建的文件，catch 时 unlink 这些文件，保留目录中原有资源。[S02] | 是应用级尽力回滚，不是数据库事务；unlink 本身也可能失败。 |
| 同一目标正被应用操作 | 进程内路径/祖先/后代锁返回 409 `EBUSY`。[S04] | 它不是跨进程锁；不能防住外部编辑器或任意进程写同一路径。 |
| 原子发布 | 写同目录 `.write-<UUID>.tmp`，写完并关闭后 link/rename 发布；finally 清理临时文件。非排他 rename 有 5 秒/100ms 的文件系统重试配置。[S10] | 该文件没有 fsync、崩溃时清理残留临时文件或日志重放代码；不能声称具备停电持久化保证。 |
| 重复生成同一请求 | 每次调用生成新 UUID 输出，节点运行中拒绝再次启动。[S02][S07][S09][S11] | 不是请求幂等；请求重放仍可能重新向供应商提交、计费并产生新文件。 |
| 用户停止/删除节点/断开连接 | AbortSignal 贯穿；节点删除先 abort、等待 generation，再处理节点文件。取消工具说明不能保证供应商撤销任务或费用。[S07][S09][S11][S20] | 本地取消不等于供应商退款；最后一次取消检查与完成返回之间也不能被描述为跨系统事务。 |
| 供应商异步生成 | TF-router 与 APIMart 在当前调用内轮询并有超时；轮询未完成就等待，下次查询是状态查询。[S08][S24] | “轮询”不等于“失败请求重试”，也不等于“跨重启恢复”。TF-router 源码明确尚未单独保存任务 ID。[S08] |
| 重新打开节点 | 当前输出从 JSON 恢复；历史目录可重选媒体；状态查询只代表本次打开后的生成状态。[S05][S07][S26][S28] | 不能凭历史输出存在就报告本轮生成成功；内存任务 Promise 和状态不构成持久任务恢复机制。 |
| 画布保存中继续编辑/生成完成 | 防抖后串行写，同页 saveRevision 仅确认相应版本；显式 flush 循环等待新节点输出与保存完成。[S06] | 上游注释明确不处理多客户端并发编辑；画布 writeJson 没有传 expectedRevision，不能当作 CAS。 |
| 文本快照外部修改 | 读取返回 SHA256 revision；携带 expectedRevision 写入时，服务端比较现有内容，失配/已删除返回 409。[S12][S31] | CAS 是该文本快照流程的能力，不自动覆盖画布保存和生成输出流程。 |

**推断的恢复缺口：** 媒体文件发布、返回响应、节点更新、画布 JSON 保存是不同步骤。进程或页面在“文件已经写出，但 JSON 尚未保存”之间退出，可能留下磁盘文件而旧画布仍指向旧结果。节点历史目录有机会找回这些文件，但这不是自动恢复承诺。反过来，请求内已经得到供应商结果却在下载失败时，也未见保留 provider task ID/结果 URL 供下次继续下载的记录。[S02][S06][S08][S28]

还有一个恢复边界：节点文件能力支持为撤销保留素材；`removeNodeFiles()` 在 `retainNodeFiles` 为真时不删除文件。画布文件删除/清理又会检查其他保留节点的引用，避免误删共享目录。因此不能假定“删除节点就释放全部磁盘占用”。[S32][S33]

## 本仓当前故障的对应落点

以下是主任务同期核验的**修复前**证据，与 Toonflow 的源码结论分开记录：

- [`file-controller.ts:285`](https://github.com/IsKenKenYa/KenFutWork/blob/dddd2775c3707748a0d9d12f4741723c56e0b6e1/apps/server/src/features/code-tools/file-controller.ts#L285) 的 `publishBytes()` 将单个 `bytes.byteLength` 与 `codePatchMaxBytes` 比较；[`governance.ts:52`](https://github.com/IsKenKenYa/KenFutWork/blob/dddd2775c3707748a0d9d12f4741723c56e0b6e1/packages/shared/src/governance.ts#L52) 默认值为 `1048576`，现场设置相同。它没有扫描或累计工作目录已有文件。
- Task 媒体的 [`project-files/service.ts:316`](https://github.com/IsKenKenYa/KenFutWork/blob/dddd2775c3707748a0d9d12f4741723c56e0b6e1/apps/server/src/features/project-files/service.ts#L316) 调到了该字节发布入口，所以几 MB 图片会被文本补丁预算挡住；这不需要用“目录已占 9.5/21 MB”来解释。
- 文本发布在 [`file-controller.ts:238`](https://github.com/IsKenKenYa/KenFutWork/blob/dddd2775c3707748a0d9d12f4741723c56e0b6e1/apps/server/src/features/code-tools/file-controller.ts#L238) 已有自己对编码后内容大小的检查；恢复批次在 [`file-restore.ts:84`](https://github.com/IsKenKenYa/KenFutWork/blob/dddd2775c3707748a0d9d12f4741723c56e0b6e1/apps/server/src/features/code-tools/file-restore.ts#L84) 另有批次总量检查。移除通用字节发布对文本预算的误用，并不需要一起取消这些语义明确的检查。

这解释的是一处限额错接，不意味着 Toonflow 的供应商轮询或画布状态模型应该替换本项目的持久任务系统。修复和运行验收由主任务独立交付，本报告不将源码分析标为修复完成。

## 对 KenFutWork 的借鉴边界

以下是设计建议，不是本次已经实现的改动；本报告不复制上游代码、schema、字段名或供应商特定结构。

1. **先把文本编辑与媒体发布的预算拆开。** 文本补丁保留文本语义的大小检查；图片、视频、音频通过媒体产物发布入口，用自身的单文件字节检查、类型校验和下载限制。避免某个通用 `publishBytes` 既承担媒体发布又继承文本补丁门槛。
2. **媒体内容保持为文件，画布与 Agent 传受控引用。** 借鉴“真实字节落盘，返回引用”的思路；本项目已有的 Task 工作域、文件事件、画布引用协议仍为属主，不把上游相对路径字符串直接作为新领域模型。
3. **保持持久 Task 和执行作用域。** 本项目 Code/Design 共用真实 Task，目录授权由服务端持有；不能退化为“前端传目录 + 本机来源头即允许”。本期账户替换也不能削弱 Task、授权代际或 Run 冻结资源目标。该边界来自本仓 `AGENTS.md` 的产品行为与本地实例不变量。
4. **保持 CAS、代际和迟到结果隔离。** 上游单进程锁与页面 AbortController 只适合其当前边界；本项目仍需阻止旧 Run、撤销授权、删除后迟到请求或内容变更后覆盖。修改媒体预算不应绕开这些校验；CAS 约束“能否覆盖这个版本”，单文件预算约束“本次允许处理多少字节”，二者互相独立。
5. **让恢复语义符合现有任务系统。** 可借鉴原子发布、仅清理本次产物、保留既有资源；不要继承上游“请求内一直等待 + 节点内存状态”作为持久生成任务。若已有 job/provider task ID 持久化，应继续用它承接查询、下载重试和恢复，避免重新生成导致重复费用。
6. **错误准确说明触发的限制。** 单文件太大应说当前文件及允许大小；整个请求太大应说请求预算；磁盘不足应说磁盘空间。没有目录累计证据时，不把现有目录占用当作拒绝原因，也不把参数名泄露为用户解释。

本次源码研究足以支持“应拆分文本补丁限制与媒体落盘限制”的方向；不能单凭该研究确定本项目最佳媒体上限、证明多 GB 目录的性能，或宣布现有故障已修复。那仍需要本项目的针对性回归、真实图片/视频发布、重新打开回填，以及已存在权限/CAS/代际边界的验收。

## 固定提交证据索引

- **S01** `LICENSE:1–21`，MIT 与版权。
- **S02** `apps/server/src/utils/media/generation.ts:12–214`，`readReference` / `downloadAsset` / `assetBytes` / `generateMedia`。
- **S03** `canvasFiles.ts:7–43`，画布格式与扫描。
- **S04** `workspace/files.ts:6–8,67–97`，原子写委托、路径解析、进程内锁。
- **S05** `canvasMenu.vue:375–408,488–503`，读取回填与排他创建。
- **S06** `canvas/index.vue:552–735`，自动保存、同页串行、版本确认及 flush。
- **S07** `useNodeGeneration.ts:5–45`，本次打开状态、取消语义与并发拒绝。
- **S08** `tfRouter.ts:73–105`，内存任务 ID、30 分钟请求内轮询。
- **S09** `imageGenerationNode/index.vue:204–216,319–370,472–479`，节点输入、生成、输出、删除与工具。
- **S10** `packages/file/src/index.ts:12–13,147–175`，写临时文件、原子发布、文件系统 rename 重试。
- **S11** `videoGenerationNode/index.vue:217–240,308–353,443–450`，视频节点对应链路。
- **S12** `files/write.ts:11–43`，可选 SHA256 expectedRevision。
- **S13** `workspace/chatImages.ts:10–12,103–169`，20 MiB 图片导入、URL 哈希、in-flight 复用。
- **S14** `agent/runtime/imageAttachments.ts:75–115`，原图与模型发送版分离。
- **S15** `agent/runtime/requests.ts:59–60,215–280`，语言模型请求预算与 413 有限恢复。
- **S16** `stores/workspace.ts:6–51`，目录项目身份与项目列表持久化。
- **S17** `utils/workspace/index.ts:8–42`，工作区入口边界。
- **S18** `canvasFiles.ts:46–141`，复制画布时复制节点媒体并重映射引用。
- **S19** `nodeAi.ts:250–268`，节点 HTTP 媒体生成调用。
- **S20** `routes/ai/media/generate.ts:9–40`，请求校验、断开取消与保活。
- **S21** `agent/tools/index.ts:20–83`，Agent 工作目录与共用媒体服务。
- **S22** `tools/mediaGeneration/index.ts:13–50`，Agent 媒体工具等待完成后返回文件路径。
- **S23** `tools/canvas/index.ts:10–25`，Agent 通过运行中画布工具操作。
- **S24** `apiMart.ts:116–132,224–267,333–351`，供应商提交/轮询/返回 URL。
- **S25** `nodeSkeleton.vue:543–551`，当前输出同步到节点 data。
- **S26** `useNode.ts:20–44`，从已保存节点输出恢复。
- **S27** `lib/workspaceFiles.ts:1–25,27–75,106–123`，共享 Blob URL、失效和文件写入。
- **S28** `components/mediaHistory.vue:47–116`，目录式历史与按选中项预览。
- **S29** `app.ts:80–85`，100mb 请求体解析边界。
- **S30** `utils/assets/index.ts:8–60,102–116`，全局素材库每文件预算及复制到项目。
- **S31** `files/read.ts:12–35`，文本读取预算与 SHA256 快照。
- **S32** `nodeScaffold/src/workspaceFiles.ts:20–58`，节点上传路径和撤销保留。
- **S33** `pages/workspace/canvasFile.ts:6–24`，共享引用保留目录计算。

[S01]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/LICENSE#L1-L21
[S02]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/utils/media/generation.ts#L12-L214
[S03]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/web/src/pages/workspace/panels/canvas/canvasFiles.ts#L7-L43
[S04]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/utils/workspace/files.ts#L6-L97
[S05]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/web/src/pages/workspace/panels/canvas/components/canvasMenu.vue#L375-L503
[S06]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/web/src/pages/workspace/panels/canvas/index.vue#L552-L735
[S07]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/nodeShared/src/useNodeGeneration.ts#L5-L45
[S08]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/providers/src/media/tfRouter.ts#L73-L105
[S09]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/nodes/imageGenerationNode/src/index.vue#L204-L479
[S10]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/file/src/index.ts#L12-L175
[S11]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/nodes/videoGenerationNode/src/index.vue#L217-L450
[S12]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/routes/workspaces/files/write.ts#L11-L43
[S13]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/utils/workspace/chatImages.ts#L10-L169
[S14]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/agent/runtime/imageAttachments.ts#L75-L115
[S15]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/agent/runtime/requests.ts#L59-L280
[S16]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/web/src/stores/workspace.ts#L6-L51
[S17]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/utils/workspace/index.ts#L8-L42
[S18]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/web/src/pages/workspace/panels/canvas/canvasFiles.ts#L46-L141
[S19]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/nodeScaffold/src/nodeAi.ts#L250-L268
[S20]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/routes/ai/media/generate.ts#L9-L40
[S21]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/agent/tools/index.ts#L20-L83
[S22]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/tools/mediaGeneration/src/index.ts#L13-L50
[S23]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/tools/canvas/src/index.ts#L10-L25
[S24]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/providers/src/media/apiMart.ts#L116-L351
[S25]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/nodeScaffold/src/nodeSkeleton.vue#L543-L551
[S26]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/nodeScaffold/src/useNode.ts#L20-L44
[S27]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/web/src/lib/workspaceFiles.ts#L1-L123
[S28]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/nodeShared/src/components/mediaHistory.vue#L47-L116
[S29]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/app.ts#L80-L85
[S30]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/utils/assets/index.ts#L8-L116
[S31]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/server/src/routes/workspaces/files/read.ts#L12-L35
[S32]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/packages/nodeScaffold/src/workspaceFiles.ts#L20-L58
[S33]: https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/apps/web/src/pages/workspace/canvasFile.ts#L6-L24
