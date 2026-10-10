# KenFutWork 隐私政策

版本：2026-10-10 · 适用软件：KenFutWork（桌面端 / 本地免账户 Web / 自托管服务端）· 中文文本为准

本政策描述**软件实际做了什么**，每条都可以在源码中核对（文中给出路径）。它不承诺我们「不会做」的事，只说明当前实现；实现变化时本文件随《日志》同轮刷新。

## 1. 读数一览

| 事项 | 本期实现 |
| --- | --- |
| 向维护者上传数据 | **无**。代码中不存在任何遥测、统计、崩溃上报或激活校验（§3） |
| 账户/注册/登录 | **无**（`DEC-20`）：本机实例免账户，身份由本地 `LocalActor` 承担 |
| 服务监听地址 | 默认仅回环 `127.0.0.1`（`apps/server/src/server.ts`），内嵌 Postgres 同样锁回环 |
| 你的内容存在哪 | 本机数据目录（Postgres + 磁盘文件），见 §4 |
| 谁可能收到你的提示与文件 | **只有你自己配置的供应商**，以及你主动使用的联网功能，见 §5 |
| 屏幕与输入 | Computer Use 启用时会截屏并合成键鼠输入，需系统授权，见 §6 |
| 语音 | 采集麦克风，**录音不留存**（只记时长）；本地识别不出机器，云端识别会把本次录音发给你的音频供应商 |
| 模型 key | 明文保存在本机数据目录，设置页可查看/复制（`DEC-7` 2026-10-05 修订），见 §7 |
| 日志 | 含被截断的提示词片段，**无自动保留上限**，见 §8、§9 |

## 2. 谁是数据处理者

- **桌面形态**：软件运行在你自己的机器上，数据全部留在本机。维护者不是任何数据的处理者，也拿不到你的数据。你同时是处理者与责任人。
- **本机浏览器访问（`/workbench` 回环 Web）**：同上，仅本机可达，会话由一次性入口兑换 `HttpOnly; SameSite=Strict` Cookie（`apps/server/src/features/local-access/service.ts`）。
- **自托管 / 对外提供服务的部署者**：一旦你把服务端暴露到回环之外（局域网、公网、反向代理），**部署者成为个人信息处理者**，需自行完成告知同意、保留期、删除与出境合规（§11）。软件本身不会替部署者做这些。

## 3. 我们不收集什么

`apps/server/src`、`apps/web/src`、`packages/shared/src` 中不存在 Sentry、PostHog、Segment、Mixpanel、Umami、Plausible、Google Analytics、MATOMO 或 OpenTelemetry 导出器的任何调用；没有设备指纹、没有使用统计上报、没有崩溃回传、没有联网激活或许可证校验。

两点如实说明：

1. 移植进来的 ZCode UI 自带一套遥测代码，在本项目中**上报函数被置为空实现**（`apps/web/src/components/workbench/zcode/host/upstream/browserPlatform.ts` 的 `reportTelemetryEvent`、`reportArmsCustomEvent`），不产生任何网络请求。
2. 表 `usage_records` 是**本地计量**（token 与费用统计，展示在「使用统计」页），只在你的数据库里，不外发。

## 4. 本机存了什么

### 4.1 数据库（Postgres）

| 数据 | 表 | 内容 |
| --- | --- | --- |
| 画布 | `canvases.content` | 画布完整 JSON 状态（含你写入的文字、图片引用） |
| 对话 | `chat_messages`（`content`、`content_blocks`） | 你与 agent 的全部消息正文 |
| Agent 运行 | `agent_runs`、`agent_turn_boundaries`、`task_works`、`background_jobs` | 运行记录、任务与工具调用轨迹 |
| Agent 状态 | LangGraph `checkpoints`、`checkpoint_blobs`、`store` | 续跑所需的完整线程状态（含提示词与工具输出） |
| 代码模式 | `code_ui_*`、`code_attachments` | Code 界面事件与附件引用 |
| 设置 | `instance_settings` | 供应商实例、默认模型、治理档位、语音设置等 |
| 扩展 | `skills`、`skill_files`、`mcp_servers`、插件目录 | 你安装的技能文件正文与 MCP 配置 |
| 素材 | `brand_kits`、`brand_kit_assets` | 品牌套件与上传的素材 |
| 计量 | `usage_records` | 用量与费用统计 |

数据库中**不保存**模型 key：`provider_instances` 只存 `api_key_ref` 指向凭据文件。

### 4.2 磁盘（应用数据目录）

默认位置（`apps/server/src/desktop/paths.ts`，可用 `KENFUTWORK_DATA_DIR` 覆盖）：

- macOS `~/Library/Application Support/com.kenfutwork.desktop/data`
- Windows `%APPDATA%\com.kenfutwork.desktop\data`
- Linux `$XDG_DATA_HOME`（默认 `~/.local/share/…`）

目录内容：`postgres/`（整个数据库）、`blobs/`（上传与生成的二进制，含 Computer Use 截图存档）、`sandbox/` 与 `sandbox/agent-files/`（agent 在工作域内生成的文件正文）、`checkpoints/`、`index/`（项目索引数据）、`browser/`（软件自带的 Chromium 配置：你让它打开的外部站点的历史与 Cookie）、`plugins/`、`credentials/`、`logs/`。

**含义**：你的项目名、文件路径、提示词、模型回答、工具输出与截图都在这台机器上的一份明文副本。机器共用、被备份到云盘或丢失时，这些内容一并暴露。

## 5. 数据离开你机器的时刻

除你配置的模型供应商外，本软件**不会**向维护者或任何固定后端发送数据。以下联网全部指向第三方，且除 Google Fonts 一条外均需你的动作触发：

| 触发 | 目标 | 传出去的东西 |
| --- | --- | --- |
| 发消息 / agent 运行 | **你的供应商**（默认 base URL 为 `api.openai.com`、`api.anthropic.com`、`generativelanguage.googleapis.com` 等，你未自定义时生效） | **完整会话历史 + 全部工具输出 + 附件的 base64 数据**（逐轮重发，agent 循环所需）。你的供应商据此按自身政策处理与留存 |
| 浏览/安装技能市场 | `skills.sh`、`registry.npmjs.org` | 检索词与包名 |
| 从仓库安装扩展 | `api.github.com`、`codeload.github.com` | 你要安装的仓库地址 |
| 浏览 MCP 目录 | `registry.modelcontextprotocol.io` | 查询词 |
| 联网搜索工具 | `metaso.cn`，兜底 `bing.com`、`baidu.com` | **搜索词原文** |
| 打开浏览器调试面板 | `cdn.jsdelivr.net`（eruda 脚本，服务端缓存） | 无用户数据 |
| 下载语音模型 | `huggingface.co` | 无用户数据 |
| 语音识别选云端通路 | **你的音频供应商**（`features/voice/providers/openai-audio.ts`，默认 `api.openai.com`） | **本次录音的 WAV 音频**（本地 sherpa-onnx 通路不出机器，见 §6） |
| 渲染含 Google 字体的品牌套件 | `fonts.googleapis.com` | **字体名 + 你的 IP/UA**，且在保存过该字体后的每次渲染自动发生（唯一非交互触发的外链） |

模型能力目录（models.dev）**不在运行时联网**：仓库内是签入的快照，刷新靠手动脚本（`apps/server/scripts/刷新模型能力快照.ts`）。

## 6. 系统权限与屏幕、输入、麦克风

Computer Use（本机 GUI 操控）是**已实现**功能，不是计划项：

- **屏幕读取**：macOS 经 `/usr/sbin/screencapture` 截屏，Windows/Linux/Wayland 有各自执行器；截图按治理档位限制尺寸并**存档在 `blobs/`**，同时作为图像输入给模型。
- **输入合成**：CGEvent 键鼠事件（macOS）、JXA 脚本桥、AT-SPI（Linux）、macOS 剪贴板读写。
- **授权**：需要系统的辅助功能、输入监听与屏幕录制权限（TCC），设置页会如实显示这三项的授权状态。未授权时相关工具不可用。
- **沙箱与审批**：命令与文件操作受执行作用域与审批档位约束，但请注意——被授予权限后，agent 可以操作本机任何可见界面，包括你的邮箱与银行页面。这是使用本功能的主要风险，由你自行承担决定何时开启。
- **语音**：按住说话经 `getUserMedia` + `MediaRecorder` 采集（`packages/voice-ui/src/voice-audio.ts`）。识别有两条通路：本地 sherpa-onnx（`features/voice/providers/sherpa.ts`，音频不出机器）与云端音频供应商（`openai-audio.ts`，**本次录音的 WAV 会发给你配置的供应商**）。两条通路都**不留存音频**——转写与改写不落库、不写对象存储，只有模型权重下载落盘；识别链路只记时长（`apps/server/src/features/voice/timing-log.ts`）。

## 7. 凭据与密钥

- BYOK 供应商 key 以**明文 JSON** 保存在 `<数据目录>/credentials/byok.json`（目录 `0700`、文件 `0600`），这是 `DEC-7` 2026-10-05 修订后的产品决策：本地形态下凭据归你所有，不设「只写不读」限制。
- 设置页可**查看与复制**自己的 key（`apps/server/src/features/model-providers/provider-settings-rpc.ts`），自定义 header 的值不回显。
- 列表类接口只返回 `hasCredential` 布尔值，不透出 key。
- 错误脱敏器会遮蔽 `Bearer`、`api_key`、`token`、`sk-` 等模式（`apps/server/src/utils/error-sanitizer.ts`）。
- **风险**：明文意味着任何能读取该目录的进程/用户/备份都能拿到你的 key；机器失窃、云盘同步、误提交到仓库都会直接泄露额度。请勿把数据目录纳入版本库或共享备份。

## 8. 日志

- 流水线日志为 JSON Lines，写至 `<数据目录>/logs/pipeline-YYYY-MM-DD.log` 并同时输出到 stdout（`apps/server/src/ws/logger.ts`），按日期分文件。
- 日志内容包含事件名、运行/实例/画布 ID、错误文本，以及**你提示词的前 80 个字符**（`apps/server/src/ws/handler.ts`）。
- 只有日期分片，**没有保留期、大小上限或自动清理**。长期使用的机器上，日志会累积大量提示词片段。
- 桌面端另有服务端/前端 dev 日志与 Postgres 日志（开发形态）。

## 9. 已知缺口（如实披露）

以下是本轮代码核查发现、尚未修掉的事实，写在这里而不是藏起来：

1. **错误日志未完全脱敏**：`sanitizeErrorForClient` 给客户端的描述已脱敏，但同一函数把**未脱敏**的原始 message、cause、响应体（截断 2 KB）、details 与堆栈写入 stderr。供应商响应体可能包含回显的请求内容或凭据片段。
2. **日志无保留上限**（§8）。
3. **Google Fonts 自动外链**（§5）：存了品牌字体后，渲染会向 Google 发起请求，对方能看到你的 IP 与字体名。不想这样请把字体改为本地托管。
4. **Next.js 构建遥测未显式关闭**：`apps/web/next.config.ts` 未设 `telemetry.enabled=false`。它只发生在**构建时**（版本、构建耗时等匿名信息），不影响运行中的软件，但严格说不是零外发。
5. **Computer Use 截图留存于 blobs**：无自动清理，属敏感内容。

这些缺口的整改登记在 `docs/未做需求.md` 与《日志》对应条目；修复前，请按上文评估自己的暴露面。

## 10. 你能做的控制

| 目的 | 做法 |
| --- | --- |
| 清空全部应用数据 | 退出应用后删除数据目录（§4.2 路径）。项目对话、画布、上传物、凭据、日志一并消失 |
| 只清日志 | 删除 `<数据目录>/logs/` |
| 只清凭据 | 删除 `<数据目录>/credentials/byok.json`，或在设置页移除供应商实例 |
| 清 Computer Use 截图 | 删除 `<数据目录>/blobs/` 内相关对象 |
| 停止任何外发 | 不发消息即可；联网功能全部是可选项。彻底断网也能用本地模型 |
| 收回系统权限 | 在操作系统隐私设置中关闭屏幕录制/辅助功能/输入监听 |
| 最小化采集 | 用本地模型（供应商指向 `127.0.0.1`），数据永不出机器 |

本期没有「账户删除请求」通道：我们从来没拿到过你的数据，也就无从删除。

## 11. 你把服务提供给别人时的义务

作为部署者，你决定了数据流向与保留策略。至少：向你的用户告知本政策对应的行为（内容会存进你持有的数据库、会发往你配置的供应商）；提供删除与导出途径；把服务限制在你有权处理的网络范围内（默认回环，别在不了解风险时改成 `0.0.0.0`）；遵守你所在辖区的个人信息保护法律。软件不会替你完成任何一项。

## 12. 儿童

本软件面向成年开发者与专业场景，本期不收集儿童数据，也没有任何面向儿童的运营承诺。供应商服务通常有自己的年龄限制，请由成年人决定使用与授权。

## 13. 变更与联系

- 本文件自 2026-10-10 起生效；实质性变更在提交与《日志》中同步记录，并在本文件顶部更新版本日期。
- 许可与授权边界见 [`EULA.md`](EULA.md)，第三方组件与素材归属见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
- 隐私相关的疑问、缺陷报告与素材权利主张：`https://github.com/IsKenKenYa/KenFutWork/issues`。这是本期唯一的正式联系渠道。
- 适用法律：中华人民共和国法律，中文文本为准。

> 本文件按当前代码实现撰写，用于如实披露软件行为，不构成法律意见。若你要在受监管环境或面向公众提供服务前使用，请自行寻求法律与合规审查。
