# 扩展形态与 Work 规划复核

> 角色：调研与设计建议；2026-10-23。基于当前工作区及已读取的“参考客户端优化 AI 能力”聊天（`01a13d53-8f57-7940-a4c0-251bc53a673b`）。采样期间 HEAD 从 `3b24d841` 更新到 `37dd79e0`，媒体与界面实现仍在并行推进。本轮不实施皮肤、编辑器或供应商执行功能；以下建议不替代已确认规格。

## 1. 供应商 `.ts` 文件属于什么插件

它属于**媒体供应商驱动插件**：用户提供特定业务接口的实现，宿主负责安装、版本、权限与执行。入口继续是模型设置，执行继续使用现有生成器和共享 Job。

[已确认规格](../方案设计/媒体供应商文件实施规格.md)将职责分为：

| 文件负责 | 宿主负责 |
| --- | --- |
| 声明模型、参数、连接字段、访问地址 | 预览、校验、凭据保存、访问地址授权 |
| 单次素材准备、提交、查询、取消 | 独立受限执行、等待和重试、租约与恢复 |
| 返回产物或可保存的上游句柄 | Job 身份、版本冻结、下载、保存、发布与用量 |

源码已经有[版本化文件接口](../../packages/shared/src/media-driver-contracts.ts)和[服务插件](../../apps/server/src/features/media-drivers/plugin.ts)。引用聊天正在交付安装生命周期；读取时最新进度为范围与完整检查进行中。独立执行、Job 绑定、完整界面和 AI 配置 Task 仍须按该任务的后续提交及回执确认，不能把全部方案写成已交付。

这个形态适合扩展到其它**职责明确的适配器**。它与当前安装式 bundle 的同进程模块加载具有不同执行约束；不能把任意 `.ts` 文件直接作为完整服务插件加载。AI 生成文件与人工编写文件使用同样的校验、预览和授权。

## 2. 皮肤、面板和编辑器应分别定义

[Codex 桌面设置](https://learn.chatgpt.com/docs/app/settings)公开颜色、UI／代码字体及主题分享；本地参考的 [theme_picker.rs](../../references/codex/codex-rs/tui/src/theme_picker.rs)提供 CLI `/theme` 和 `.tmTheme` 预览。二者证明主题可定制；没有据此确认桌面主题能替换工作台组件。[Codex 插件文档](https://developers.openai.com/plugins/build/plugins)的 Skills／MCP／资源是另一类扩展。

建议按能力定义形态，文件后缀不决定权限：

| 用户想定制什么 | 推荐形态 | 当前基础与剩余连接 |
| --- | --- | --- |
| 颜色、字体、字号、圆角与间距 | 有版本的主题数据；预览、取消恢复、导入／导出 | [useTheme](../../apps/web/src/components/workbench/zcode/useTheme.ts)已有固定主题与本地保存；用户主题导入和字段校验仍需连接 |
| Agent 的工作方法、模板与参考材料 | `SKILL.md` 与资源目录 | 技能发现和读取已存在；仍需遵守模式与来源检查 |
| 新图片／视频供应商 | 自包含 `.ts` 驱动 | 按媒体规格接现有 Job；生命周期与执行分批交付 |
| 查询、外部系统操作与设置面板 | MCP 或安装式功能包 | 工具、提示、路由、UI、存储已有支持；停用和在途资源管理见[插件检查](插件架构检查.md) |
| 工具结果中的交互页面 | 受控工具页面与宿主消息接口 | 与正在推进的 Plugin UI／Gen UI 共用页面管理，结果身份与授权由宿主持有 |
| Word／表格／演示／图像／视频编辑 | 文档类型贡献、编辑引擎与文档控制适配 | [DocumentPane](../../apps/web/src/components/workbench/zcode/host/DocumentPane.tsx)已有 renderer 接口；[资源类型](../../apps/web/src/components/workbench/zcode/lib/workspaceSidePane.ts)当前仅 canvas，尚未形成通用安装式文档协议 |

主题数据只改变外观。布局和内容组件属于独立贡献接口；审批、停止、错误状态及焦点行为由宿主保持。Work 的编辑器应进入现有内容标签，继续共用 SessionPane、Task 与权限。

现有[工具 renderer](../../apps/web/src/components/workbench/zcode/ToolCallBlocks/contributedRenderers.tsx)可显示修改摘要和导出结果；[host/main.tsx](../../apps/web/src/components/workbench/zcode/host/main.tsx)当前静态装配 Canvas 与媒体 renderer。安装式包如何贡献文档 renderer 和工具展示，仍需要实际注册、停用及卸载消费者。插件 iframe 面板本身不能代替这条连接。

## 3. 自己写插件的产品形态

建议让一个包声明它贡献的能力，保持各能力的独立执行规则；共用身份、版本、来源、更新和停用事实，不强行共用一个执行入口。

作者流程建议为：选择能力模板 → 编写／由现有 Agent 生成 → 使用真实加载器校验 → 预览变化与权限 → 在测试任务中验证 → 安装或更新。媒体驱动继续走已确认的模型设置；其它形态使用相应管理入口。

需要补齐的开发者支持：

- 与真实接口同源的类型定义、最小可运行例子和校验命令，错误定位到字段或源文件位置。
- 支持范围报告：哪些声明可用、哪些未实现、哪些需要授权；格式校验、成功加载与业务验证分别显示。
- 开发记录能追到插件版本、Task、Run、工具及实际结果；隐藏凭据值。
- 在途工作固定原版本，更新只影响新工作；停用阻止新调用，卸载按资源类型等待结束或明确处理草稿。
- 常用能力由宿主提供稳定接口，作者不重复编写队列、凭据保存、权限判断与恢复流程。

这些是作者体验建议，当前没有确认“一键制作任意插件”的完整产品能力。

## 4. Work 规划需要补齐的核心行为

[现有 Work 规划](../插件/work模式集成规划.md)提出 Office 三类文档及图片／视频编辑目标，并讨论按需安装引擎。共用 SessionPane、Task 与 Harness 已是确认边界，WD 各项选择仍待确认。主要不足是文档操作和验收的完整连接。

| 要解决的问题 | 推荐行为 | 必须验证的场景 |
| --- | --- | --- |
| 文档会话与保存 | 固定文档身份、授权目标、引擎版本、基准版本、当前草稿版本、未保存状态及最后保存回执；宿主确认持久保存后才显示已保存 | 保存失败／回包丢失、磁盘满、原文件移动或删除、关闭和重启 |
| 人与 Agent 同时编辑 | 活动文档通过同一编辑器会话执行带预期修订的操作；磁盘操作须协调当前写入者，没有安全接口时生成明确副本 | 同一段／单元格／幻灯片并发修改、两标签、外部应用写入、迟到保存 |
| 选区与目标 | 发起时固定文档及选区版本；界面后来切换不改变工具目标，执行前核对目标仍可用 | 用户切换文件、删除选区、关闭标签、撤销权限 |
| Undo 与历史恢复 | 编辑器 Undo、Agent 操作事务、持久版本恢复分别定义；保留后续用户编辑，不能安全逆向时提供恢复副本 | Agent 修改后用户继续编辑、保存后撤销、重启后恢复、重复撤销 |
| 格式保真 | 每种格式明确查看、可编辑保留、需转换、不支持的范围；导入损失和导出损失可见 | DOCX 样式／批注修订；XLSX 公式／命名范围／重算；PPTX 母版／图表／动画；图层和时间线 |
| Work 入口 | 首次至少一个编辑器可用才开放；已打开文档遭遇引擎故障时保留文档和恢复入口 | 未安装、安装失败、运行失联、卸载最后一个引擎、历史深链 |
| Web 与原生承载 | 分别声明浏览器内嵌、外部原生窗口和真正原生嵌入；每种形态连接文档身份、输入、关闭和保存 | 后台快捷键、窗口关闭、旧页面消息、宿主断开、跨平台行为 |
| 安装与更新 | 校验后原子启用；新会话用新版，活动文档固定旧版；卸载包不删除用户文件和恢复草稿 | 取消、损坏包、并发更新、旧版仍被使用、卸载期间迟到保存 |
| 资源管理 | 区分前台、后台保持、已保存可挂起和存在恢复草稿；挂起前取得保存或草稿回执 | 多文档、大表格、视频素材缺失、渲染进程异常及恢复时源文件变化 |

可以复用的基础包括：[Canvas 保存回执](../../apps/web/src/components/workbench/zcode/host/canvasDocumentBridge.ts)、[文件版本检查](../../apps/server/src/features/code-tools/file-controller.ts)、[恢复时保护新变化](../../apps/server/src/features/code-ui/file-rewind.ts)。这些机制可提供设计依据，不能直接证明外部编辑器的内存草稿已经受到保护。

特别需要调整“Skill 生成文件与编辑器 MCP 互为兜底”的说法：它们只有在文档版本与保存所有权明确时才可替换。编辑器有未保存草稿时，CLI 读取磁盘旧版再覆盖文件会产生冲突。具体保护必须由真实编辑接口实现，提示词提醒不够。

## 5. 编辑引擎的当前证据

2026-10-23 重新读取以下官方发布、源码和接口说明。所列版本发表于 2026-10-21 至 22（北京时间），均有 Web ZIP 与 SHA256SUMS；本轮没有下载或运行发行包。版本和 Web 包存在不证明格式保真或宿主接入已经通过。

| 候选与发布 | 当前 Web 接口 | 需要解决的适配问题 |
| --- | --- | --- |
| [WordCraft 0.9.0](https://github.com/storytold/wordcraft/releases/tag/v0.9.0) | [源码](https://github.com/storytold/wordcraft/blob/00bc6a4b028013b2dfb0e85e8b326aeed3ecff6d/apps/wordcraft-web/src/main.rs)使用文件选择与下载，无 TCP 控制通道 | [MCP](https://github.com/storytold/wordcraft/blob/00bc6a4b028013b2dfb0e85e8b326aeed3ecff6d/docs/mcp.md)的 headless 与连接原生应用不同；目录限制只适用于 headless，Web 当前草稿控制需单独证明 |
| [DeckCraft 0.9.0](https://github.com/storytold/deckcraft/releases/tag/v0.9.0) | [源码](https://github.com/storytold/deckcraft/blob/a2435383b156b02278a63d09b0ffaa6bd7af3d4d/apps/deckcraft-web/src/main.rs)同样使用选择与下载 | [MCP](https://github.com/storytold/deckcraft/blob/a2435383b156b02278a63d09b0ffaa6bd7af3d4d/docs/mcp.md)不能将连接回包丢失解释为操作未执行；原生连接和 Web 文档分别适配 |
| [GridCraft 0.10.0](https://github.com/storytold/gridcraft/releases/tag/v0.10.0) | [发布 tag 中的 host.rs](https://github.com/storytold/gridcraft/blob/v0.10.0/apps/gridcraft-web/src/host.rs)已有同源 `?host=parent` 的 ready/open/save/dirty/failed 消息 | 发出 save 即更新已保存状态，缺宿主持久化 ACK、版本和冲突处理；当前草稿的 Agent 操作能力仍需验证 |
| [PhotoCraft 0.12.0](https://github.com/storytold/photocraft/releases/tag/v0.12.0) | [源码](https://github.com/storytold/photocraft/blob/8f09d122d3741503accc11172bef882e5a284d12/apps/photocraft-web/src/main.rs)使用选择与下载，无 TCP 控制服务器 | [CLI](https://github.com/storytold/photocraft/blob/8f09d122d3741503accc11172bef882e5a284d12/apps/photocraft-cli/src/lib.rs)的 bridge/token/目录限制与 Office 产品不同，不能共用未经验证的启动参数 |
| [FilmCraft 0.10.0](https://github.com/storytold/filmcraft/releases/tag/v0.10.0) | [Web 文档](https://github.com/storytold/filmcraft/blob/dd525c93d43b96843aedc50d7fa94a052474f476/docs/web.md)有 `window.filmcraft` 控制当前引擎；Web 单线程且部分命令不可用 | [原生控制协议](https://github.com/storytold/filmcraft/blob/dd525c93d43b96843aedc50d7fa94a052474f476/docs/control-protocol.md)没有认证；回环绑定不替代 Task 授权，虚拟文件与最终持久保存也须连接 |

GridCraft 的桥接确认到发布 tag 源码，尚未确认发行包的运行行为。其他源码链接固定到本轮读取的提交，不等同于发布二进制验证。建议优先把 GridCraft 作为表格技术验证候选，重点检验保存确认和同一草稿控制；这不是正式选型，也不代表其他 Office 格式可直接复用。

五仓主体代码有 MIT／Apache-2.0 许可文件，素材和品牌另有范围；例如 [WordCraft 品牌许可](https://github.com/storytold/wordcraft/blob/00bc6a4b028013b2dfb0e85e8b326aeed3ecff6d/docs/brand/LICENSE-brand.txt)。采用时按固定版本核对代码、依赖、素材和品牌；clean-room 仅作为上游声明，本轮未作独立核验。

[ONLYOFFICE 保存回调](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler)可作为成熟保存接口的比较来源；其 [Automation API](https://api.onlyoffice.com/docs/docs-api/usage-api/automation-api)有 Docs Developer 与额外收费条件。是否采用需与本地部署、文档操作接口和授权一起评估，本轮不更换现有候选。

## 6. 生成能力怎样服务 Work

媒体驱动产出图片／视频 → 共享 Job 完成保存与发布 → 现有 [ProjectFile](../../apps/server/src/features/project-files/types.ts) 提供身份、摘要和路径 → 编辑器按授权读取素材 → 工程文件与导出结果分别保存。

建议保留“生成原片、可编辑工程、导出文件”的来源关系。重新生成得到新素材，不自动替换用户已经编辑的图层或时间线片段。Work 继续使用现有 Job 的查询、取消和恢复。

同一思路可用于办公任务：研究结果进入文档，数据进入表格，图表进入演示稿；每次转换明确输入版本、执行工具、输出文件及可编辑程度。项目、Task 与成果仍使用现有身份。

## 7. 建议调整的验证顺序

现规划 W2 主要验证下载和 iframe，W3 扩大编辑器，W4 才验证 Agent。建议把 Agent 与保存验证前移到每一种编辑器的接入过程：

1. 对固定版本候选验证真实格式、当前草稿读取、保存确认、Agent 控制和承载方式。
2. 用同一文档验证“打开 → 人编辑 → Agent 修改 → 保存 → 关闭重开 → 撤销／恢复”，并覆盖版本冲突和权限变化。
3. 将这个流程接入实际安装、更新、卸载与发行产物，再开放满足条件的 Work 入口。
4. 按相同标准完成其余 Office 格式及图片／视频编辑器；各自记录格式保真和性能，不以安装包小或仓库有 MCP 目录判断成熟度。

这保持原规划的完整能力范围，只调整依赖和证明顺序；WD 选择及原阶段定义尚未因此变更。

## 8. 其他值得考虑的能力

- **项目模板**：把已有 Skills、文档模板、成果检查项和所需插件版本组合成研究报告、数据分析、演示等工作起点；模板不自行授予权限。
- **成果检查**：在完成前检查真实文件能否重开、公式与引用是否有效、素材是否齐全，并使用现有 Goal 证据机制。检查过程本身也要有实际结果。
- **扩展兼容矩阵**：记录每个引擎／插件支持的文件格式、操作、平台与宿主版本；不支持的操作在工具发现和界面共同表达。
- **分离应用主题与文档样式**：主题控制工作台外观，模板／Brand Kit 控制输出文件；切换深色主题不改变文档配色和导出结果。

优先建议是先证明“同一当前文档可由人和 Agent 安全共同编辑”。这会决定编辑器选择、MCP／CLI 连接、保存、Undo 和恢复的具体设计。
