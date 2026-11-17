# Harness 会话存储与 200 MB 修复计划

角色：调研与待实施方案。日期：2026-11-17。范围：本机数据库、KenFutWork Git 历史，以及仓库固定的 Harness 参考版本。本次没有改动应用代码或原始数据库。

## 本机证据

KenFutWork 的数据目录约 7.96 GiB。`langgraph.checkpoint_blobs` 占 4.30 GiB，`langgraph.checkpoint_writes` 占 2.87 GiB，合计占整个目录约 90%；实例共用的 Postgres WAL 约 688 MiB。Code 界面会话与事件表加起来约 60 MiB。旧 `public.chat_messages` 无记录，只能说明该旧表没有消息；当前界面和 Agent 历史有各自的记录。

两张大表的 4,572 条可见记录全部属于同一条 Agent 线程。相关字段以 `pg_column_size` 计算合计约 6.91 GiB；这是当前数据库可读的字段数据体积，含重复副本，不能当成必须保留的唯一内容。该线程对应仍保留的一个会话，2026-10-27 的 7 次执行留下 865 个恢复点，记录了 32 次截图及 31 次窗口状态读取。两张表的 `messages` 数据合计约 5.59 GiB，子任务和中间状态通道 `__pregel_tasks` 合计约 1.32 GiB。

在上述两张表的 `messages`、`__pregel_tasks` 两个主要通道中，提取 `data` 字段内符合 PNG 签名的 Base64，解码后按 SHA-256 比较，不输出图片、正文或摘要：匹配 22,818 次，只有 18 份不同图片；同一份图片最多出现 5,214 次。按原始 PNG 字节计算，唯一内容 3,080,389 字节（约 2.94 MiB），重复部分 4,122,616,304 字节（约 3.84 GiB）。查询不包含其它字段形状、媒体格式、重复文本与 Postgres 压缩和页费用，重复原始字节不能直接当成可回收的磁盘量。即使这 18 份图片全部去重，也还需要处理重复的消息列表、工具结果及其他状态，才能验证 200 MB 上限。

| 本机对照 | 读数 | 计量范围 |
| --- | ---: | --- |
| ZCode 3.18.2 的 CLI 数据库主文件 | 约 543 MiB | 同时包含 213 条会话记录、44,530 条消息和 136,778 条消息片段；记录数不等同于界面显示的主会话数 |
| ZCode 单会话的最大消息与片段正文 | 45.19 MiB | 对 SQLite `message` 和 `part` 的 `data` 按 `session_id` 汇总；未加索引、文件产物和缓存 |
| ZCode 的 `~/.zcode/cli` | 约 1.55 GiB | 包含数据库、约 392 MiB 独立产物、约 70 MiB 图片缓存，以及插件和日志等；整个 `~/.zcode` 还包含项目快照和原生 Helper，约 2.52 GiB |
| Codex 本机 `sessions` 与 `archived_sessions` | 合计约 785 MiB | 两个会话日志目录；不含共用日志数据库、其它缓存；没有按单会话汇总 |

测量口径：目录使用 `du -x -k`；ZCode 使用 SQLite `-readonly` 聚合行数及每会话 `length(CAST(data AS BLOB))`；Postgres 在正常停机的隔离副本中查询目录映射、表和聚合数据。校验 PNG 的查询只记录匹配数、去重数和字节汇总。读数是本机采样，参考版本和本机安装版本分别记录。

## 参考 Harness 的实现

| 参考版本 | 日常写入与恢复 | 对本项目的启发 |
| --- | --- | --- |
| ZCode `fec97590` | SQLite 按 `message` / `part` 的 ID 独立写入或更新。冷启动从持久正文、时间线、输入状态和会话设置重建界面，进程内事件回放有界。配置了产物仓库时，主轮附件可存为独立产物引用，模型需要时读取 | 持久正文、可重建界面与短期运行状态分开。这个源码路径允许在缺少产物仓库或会话 ID 时内联，独立产物也可能是 Data URL 文件，不能称所有媒体都按原始二进制全局去重 |
| DeepSeek Harness `39163dd3` | 逐会话追加新事件，默认用 Zstandard；图片规范化后按 SHA-256 保存，相同图片复用文件 | 事件增长随新增内容变化，历史里的附件只保留引用 |
| Kimi Code `f082f04a` | Wire 记录写入前把符合阈值的 Data URL 正文取出，解码成二进制、按内容哈希存储，并替换成引用。恢复从 Wire 事件重放上下文和压缩摘要 | 可保留原始图片并在恢复时读取，不必重复存每份消息状态里的图片 |
| Codex `b016cd18` | 每个 rollout item 追加一行，恢复时重放；冷日志有 Zstandard 压缩。分页历史的命令和 MCP 完成事件有 64 KiB 的特定输出限制，原始响应仍可能含内联图片 | 可以借鉴独立记录、过滤与冷日志压缩；64 KiB 不能解释为所有输出限制，也没有证据证明 Codex 对所有媒体做本地去重 |

一手源码定位：

- ZCode：`references/zcode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts:45`、`:118` 按 ID 写入；`references/zcode/docs/v4-refactor/07-persistence.md:92` 说明恢复；`references/zcode/apps/zcode-cli/packages/core/src/runtime/helpers/attachment-artifacts.ts:35` 及 `references/zcode/apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:520` 说明附件引用和独立目录。
- DeepSeek Harness：`references/deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts:70`、`:1447`、`:1469`，及 `references/deepseek-harness/packages/attachment/attachment-local/src/store.ts:98`、`:190`。
- Kimi Code：`references/kimi-code/packages/agent-core-v2/src/wire/wireService.ts:123`、`:686`；`references/kimi-code/packages/agent-core-v2/src/agent/blob/agentBlobServiceImpl.ts:91`、`:113`、`:126`；`references/kimi-code/packages/agent-core-v2/src/agent/contextMemory/contextTranscript.ts:31`、`:102`。
- Codex：`references/codex/codex-rs/rollout/src/recorder.rs:2109`；`references/codex/codex-rs/rollout/src/policy.rs:253`；`references/codex/codex-rs/rollout/src/compression.rs:894`；`references/codex/codex-rs/core/src/session/rollout_reconstruction.rs:212`；`references/codex/codex-rs/protocol/src/models.rs:997`。

这些参考实现可以解释怎样避免当前写入方式；没有证据显示它们承诺统一的单会话 200 MB 上限，也没有证据支持 KenFutWork 当前单会话的占用属于合理范围。

LangGraph 本身也有增量存储方向：`references/langgraph` 的 Python 版本 `08a2016` 在 `libs/langgraph/langgraph/channels/delta.py:25` 实现按祖先写入重建状态，并按间隔保存基线。当前安装的 LangGraph JS 1.4.16 导出 `MessagesDeltaValue`，但 Deep Agents 调用的 LangChain 默认消息状态仍是 `MessagesValue`（安装包 `langchain/dist/agents/annotation.js:77`）。JS 的共享保存器默认通过逐个 `getTuple` 查询祖先还原增量（`@langchain/langgraph-checkpoint` 1.1.5 的 `dist/base.js:64`），因此启用前需要在现用 Postgres 接口上实测恢复性能与分支正确性。也不能直接使用「只留最后一个恢复点」：现有[分支实现](../../apps/server/src/agent/native-context-branch.ts)第 79 行会读取祖先链，Python 参考版本自己的 `keep_latest` 也明确拒绝 DeltaChannel 线程（`libs/checkpoint-postgres/langgraph/checkpoint/postgres/base.py:302`）。

## Git 责任链

| 提交 | 改变了什么 |
| --- | --- |
| [`b2023304`](https://github.com/IsKenKenYa/KenFutWork/commit/b2023304)，3 月 24 日，Xinmin Zeng，继承自 Loomic 的 PR #2 | 最早引入 Deep Agents 会话的 PostgresSaver 和三张恢复表。数据库保存 Agent 状态的机制早于 ZCode 界面移植，也早于截图接入 |
| [`8641d4a9`](https://github.com/IsKenKenYa/KenFutWork/commit/8641d4a9)，10 月 4 日，KenKenUseMac | Code/Design 持久轮次接线，固定每个执行步骤同步确认恢复记录。同步确认提供崩溃恢复保证，不要求把同一字节保存多次 |
| [`9b91227d`](https://github.com/IsKenKenYa/KenFutWork/commit/9b91227d)，10 月 5 日，KenKenUseMac | `git blame` 确认由此把截图 Base64 放进 `modelContent`，让大数据进入上述保存链 |
| [`83f725a0`](https://github.com/IsKenKenYa/KenFutWork/commit/83f725a0)，10 月 6 日，KenKenUseMac | 接通 Task 删除，并以集成测试明确保护原生恢复点；这是会话删除后仍可占用空间的行为来源 |
| [`6dc77232`](https://github.com/IsKenKenYa/KenFutWork/commit/6dc77232)，10 月 8 日，KenKenUseMac | 增加截图归档，但现有归档仅替换符合条件的界面媒体和对应 `canonicalOutput`，没有替换模型消息的内联图片。现用归档键由运行、工具调用和媒体位置产生，也不等于对图片内容去重 |
| [`6de0cb02`](https://github.com/IsKenKenYa/KenFutWork/commit/6de0cb02) 与 [`cb4dc447`](https://github.com/IsKenKenYa/KenFutWork/commit/cb4dc447)，10 月 27 日，啃啃MacMini | 接入 macOS Helper、修正截图参数；与本机异常日期一致，但没有证据证明本机这些运行使用哪一次构建，不能据日期认定是这两次提交首次引入放大机制 |

证据入口：[初始表定义](../../supabase/migrations/20260324000007_agent_thread_persistence.sql)第 42 行、[当前 PostgresSaver](../../apps/server/src/agent/persistence/supabase-checkpointer.ts)第 34 行、[同步保存](../../apps/server/src/agent/native-checkpoint-durability.ts)第 4 行、[图片进入模型消息](../../apps/server/src/features/computer-use/tools.ts)第 113 行、[截图归档](../../apps/server/src/features/computer-use/snapshot-archive.ts)第 65 行、[删除后仍保留恢复点的测试](../../apps/server/src/features/code-ui/task-delete.integration.test.ts)第 245 行。安装的 `@langchain/langgraph-checkpoint-postgres` 1.0.5 的 `dist/index.js:137`、`:160`、`:319`、`:358` 显示新版本通道和中间写入分别序列化。通道版本变化时会保存该版本的完整值，例如消息列表；未变化的通道并非每一步都重新序列化。

Git 能证明作者字段、提交内容、分支归属和合并入口。其中数个 10 月提交现已包含在 `origin/codex/完善Harness与会话稳定性`；这几条提交没有 GPT 模型标识或可证明代写者的记录。能够确认的是旧持久化与后续截图、删除规则叠加形成了故障，不能把人类账号名或当前分支名当作某个 GPT 模型实际编写的证据。

## 修复计划与验收

**上限为每个根会话 200,000,000 字节，含图片，也含子代理。** 计入会话持有的消息、恢复记录、中间结果、界面历史、附件和任务专属归档；同一内容在会话内多次引用只计一次，不允许通过搬到文件目录后漏算。用户项目自己的文件和实例共用的数据库目录、WAL、迁移账本按实例另计；Postgres 页与索引有共享开销，不能用 `du` 把它们精确归给某个会话。验收同时报告逐会话预算和真实数据库、附件目录与 WAL 的增长量，防止把占用藏到计量外。用户可按现有治理方式调低额度，最大值为 200 MB。

1. **保持同步恢复，改变保存内容。** 在 Agent 持久化接口下统一处理 `put` 和 `putWrites`。图片、大文本和大工具结果用版本化、带类型的引用表示，二进制或无损压缩正文按摘要保存，同一内容只写一份；发送模型请求时才按模型要求恢复内联图片。消息历史持久化新增或变更的消息及其有序引用，恢复点保留可重建当前状态、pending writes、上下文压缩、回退和分支所需的锚点。对引用、分支和读取历史逐项验证；完整的文件还原资料也进入同一额度，不能用截断预览冒充原内容。复用现有 Blob 能力和 Task 授权；来源、大小和摘要校验通过后再发布引用，写入失败不提交不可恢复的成功状态。
2. **在写入前执行容量上限。** 额度账本按实例与根会话关联，所有子任务、历史分支准备、消息、快照、归档及大结果通过同一事务写入边界计算新增字节。对重复请求和同一摘要只记一次；并发预留、提交、失败释放和中断清理由明确状态控制。先回收可重建缓存和不可达正文；仍不足时，在承诺接收新内容或开始不可逆工具操作前提示明确原因。生成大小无法预知时预留该工具可持久化结果的配置上限，无法预留就等待用户处理；保留终态和必要控制记录的空间也计入 200 MB。到达上限后给用户导出历史或明确删除的入口，不默默删消息，也不绕过额度或重放已完成的工具操作。
3. **无损转换旧存档，再回收空间。** 用前向迁移增加新存储结构，改动不触碰历史迁移文件。对当前数据先做停机备份并在副本上逐线程分批转换；核对消息顺序、字节摘要、待执行状态、运行边界、回退与分支锚点，并实际恢复读取。转换按稳定键重放，校验失败保留旧读源且终止切换。删除 Task 时先撤销执行权和读取权，再根据仍在使用的分支、归档与用户导出引用清理恢复数据；最小墓碑阻止迟到写入复活。如果无损去重后某条旧会话仍超过 200 MB，报告独有数据量，暂停该会话切换，等用户选定导出或删除的内容；保留停机备份供恢复。切换后，只对已核验并已移除旧数据的巨大关系执行计划内的磁盘回收；普通 `VACUUM` 主要让空间可供库内复用，实际归还磁盘需要重写或重建，须预留空间和停机时间。不能通过手动删除 `pg_wal` 或表文件释放空间。

真实 Postgres 验收包含：至少数千次纯文本执行步骤、按本机样本重放的 865 个恢复点和重复截图、持续新增不同大图片与大文本逼近上限。逐项量出达到 200 MB 后拒绝新增的行为、同一会话并发额度竞争、相同操作重放、崩溃后继续、跨 Task 权限、分支保留、删除后迟到请求、图片加载与文件回退，并在副本上对比迁移前后的目录字节。实现分批提交前运行 `pnpm --filter @kenfutwork/server test`、`pnpm test`、`pnpm typecheck`；需要真实数据库的用例单独执行和登记。当前没有声称这些验收已通过。
