# KenFutWork 第三方声明与素材归属

版本：2026-10-23 · 本文件是**仓库层**第三方归属的唯一索引（属主登记见 `docs/README.md` 治理规则 1）

本文件回答三个问题：哪些东西不是我们写的、它按什么许可进来、我们在分发时必须替下游做什么。许可义务**履行位置**逐条标注；上游移植目录内那份 `THIRD-PARTY-NOTICES.md` 是 ZCode 的上游产物（与上游逐字节一致），本文件不复制它的正文，只索引它。

## A. 随上游移植进仓库的代码与素材

### A1. ZCode（Apache-2.0）

| 项 | 内容 |
| --- | --- |
| 上游 | [zai-org/ZCode](https://github.com/zai-org/ZCode) 3.14.3，固定提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e` |
| 版权人 | Z.AI Co., Ltd（待核；上游 LICENSE/NOTICE 无 Copyright 行） |
| 许可 | Apache License 2.0 |
| 落点 | `apps/web/src/components/workbench/zcode/`（仓库内别名 `@zui/*`）、`packages/zcode-*`（由 `scripts/vendor-zcode.mjs` 装配，`package.json` 声明 `license: "Apache-2.0"`） |
| 义务履行 | 移植目录内保留上游 `LICENSE`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`（逐字节一致）；根 [`NOTICE.md`](NOTICE.md) 声明移植范围；逐文件来源、校验和与宿主适配偏差登记在 `packages/third-party/zcode/来源清单.json`（3029 条记录），`scripts/vendor-zcode.mjs` 在清单建立后只核对漂移、不再复制 |
| 商标 | Apache-2.0 第 3 条不授予商标权；ZCode、Z.ai、GLM 归各自权利人，见 [`EULA.md`](EULA.md) §6 |

### A2. ai-elements（Apache-2.0，Vercel）与 ZCode 第一方包装

落点 `apps/web/src/components/workbench/zcode/components/ai-elements/`，共 46 个文件，分两类，**不要混为一谈**：

- **35 个源自 [vercel/ai-elements](https://github.com/vercel/ai-elements)**（`packages/elements/src/*`）：文件头带 `Derived from vercel/ai-elements … Copyright 2023 Vercel, Inc. Licensed under Apache-2.0. Modified by ZCode` 声明。头注释里「See THIRD-PARTY-NOTICES.md in the repository root」指的是 **ZCode 上游仓库的根**，即移植目录内那份；本文件的 A1 行是仓库层索引。
- **11 个是 ZCode 第一方代码**（`canvas.tsx`、`chat-loading.tsx`、`diagram-preview-dialog.tsx`、`image-preview-dialog.tsx`、`image-thumbnail-gallery.tsx`、`markdown-blockquote.tsx`、`markdown-image.tsx`、`markdown-list.tsx`、`markdown-table.tsx`、`mermaid-block.tsx`、`streamdown-controls.ts`）：上游无 Vercel 声明，故无文件头。**它们的许可与版权按 A1 的 ZCode Apache-2.0 处理**，通过上游 `LICENSE`/`NOTICE.md` 目录级文本履行义务。
- **为什么不给这 11 个补文件头**：移植文件与上游逐字节一致是可核对的溯源机制（清单里的 `copiedSha256`），改一个字节就报漂移。Apache-2.0 第 4 条要求保留的是上游版权声明与许可/NOTICE 文本，上游这些文件本就没有头注释，目录级文本已满足义务，不值得为形式破坏溯源。

### A3. Material Icon Theme 文件类型图标集（MIT）

| 项 | 内容 |
| --- | --- |
| 上游 | [material-extensions/vscode-material-icon-theme](https://github.com/material-extensions/vscode-material-icon-theme)，固定提交 `cb1dfb6` |
| 版权人 | Material Extensions |
| 许可 | MIT |
| 落点 | `apps/web/src/components/workbench/zcode/public/material-icons/`（**1146 个 SVG**，签入版本控制的唯一真值；`apps/web/public/code-ui/material-icons` 等三处是构建期副本，由 `scripts/stage-code-ui.mjs` 生成且不入库） |
| 义务履行 | 上游移植目录的 `THIRD-PARTY-NOTICES.md` 含完整 MIT 文本；本轮另在图标目录就近放置 `LICENSE`（MIT 原文），使副本与被分发产物带得上声明。注意：目录里的 `license.svg`、`unlicense.svg` 是**文件类型图标**，不是许可文本 |

### A4. shadcn 组件模板（MIT）

| 项 | 内容 |
| --- | --- |
| 上游 | [shadcn/ui](https://ui.shadcn.com) 注册表模板，风格 `base-nova`（配置见 `apps/web/components.json`） |
| 许可 | MIT |
| 落点 | `apps/web/src/components/ui/`（9 个文件：`avatar`/`button`/`dialog`/`dropdown-menu`/`input`/`label`/`select`/`separator`/`skeleton`），以及 ZCode 移植树内的 `components/ui/`（45 个文件，归属随 A1） |
| 义务履行 | 这 9 个文件是我们自己按注册表约定编写的封装（**不在** `ZCode源码清单.json` 的 3029 条记录内），本轮为每个文件补一行来源注释头；运行时依赖的许可由 B 段 Base UI 条目承接 |
| 说明 | shadcn 模板本身是可直接复制的 MIT 代码片段，改写与封装不改变其 attribution 要求 |

### A5. 图标库 lucide-react（ISC）

npm 依赖，**未把 SVG 签入仓库**：`lucide-react@1.47.0`（`apps/web/package.json`、`apps/landing/package.json`）。上游 [lucide-icons/lucide](https://github.com/lucide-icons/lucide)，许可 ISC。义务按 B 段随依赖清单一并履行。

### A6. Loomic（MIT，项目前身）

| 项 | 内容 |
| --- | --- |
| 上游 | 项目前身 Loomic（品牌改名前的项目），MIT，Copyright (c) 2026 Xinmin Zeng |
| 许可 | MIT；全文见 [`licenses/loomic-MIT.txt`](licenses/loomic-MIT.txt) |
| 落点 | 本仓库早期代码与基础能力；`references/loomic/` 为上游参考副本 |
| 义务履行 | 社区版与商业版均保留 Copyright 与 MIT 全文；[`COPYRIGHT.md`](COPYRIGHT.md) 与安装包 `release/legal/loomic-MIT.txt` 承担随包声明；商业版使用前取得 Xinmin Zeng 的书面来源确认（见 `DEC-24`） |

## B. 运行时与构建期开源依赖

以下按 `package.json` 与 `pnpm-lock.yaml` 的真实依赖核对，未凭记忆填写。完整传递依赖清单以 lockfile 为准（数百个包，逐包许可文本见「分发义务」§G2 的待办）。

| 项目 | 许可 | 用在哪 |
| --- | --- | --- |
| [DeepAgents](https://github.com/langchain-ai/deepagents) | MIT | agent 运行时（规划/子代理/文件系统工具） |
| [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime) `0.0.78` | Apache-2.0 | Task OS 沙箱；本仓 `patches/@anthropic-ai__sandbox-runtime@0.0.78.patch` 仅补 macOS ARM 的 `hw.optional.neon` 读取，修改者为 KenFutWork 贡献者。上游作者 Anthropic PBC；完整许可保留于 `patches/LICENSE-sandbox-runtime.txt`，桌面分发复制到 `legal/sandbox-runtime-LICENSE.txt` |
| [LangChain](https://github.com/langchain-ai/langchainjs) / [LangGraph](https://github.com/langchain-ai/langgraph) | MIT | 模型接入、agent 编排与 checkpoint 持久化 |
| [Next.js](https://github.com/vercel/next.js) / [React](https://github.com/facebook/react) | MIT | 前端框架（App Router + React 19） |
| [Base UI](https://github.com/mui/base-ui)（`@base-ui/react`） | MIT | 无头组件原语（A4 的运行时底座） |
| [lucide-react](https://github.com/lucide-icons/lucide) | ISC | 图标（A5） |
| class-variance-authority | MIT | 组件变体样式 |
| [Fastify](https://github.com/fastify/fastify) | MIT | 后端 HTTP 框架 |
| [Excalidraw](https://github.com/excalidraw/excalidraw) | MIT | Design 模式无限画布 |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | MIT | 样式系统 |
| [zod](https://github.com/colinhacks/zod) | MIT | 跨端契约（`packages/shared`） |
| [xyflow/react](https://github.com/xyflow/xyflow) | MIT | 流程图/画布节点渲染；由移植包自己声明依赖（`apps/web/src/components/workbench/zcode/package.json` 的 `@xyflow/react ^12.10.1`，lock 解析 12.12.0） |
| [embedded-postgres](https://github.com/leinelissen/aeonik-embedded-postgres) | MIT | 桌面形态内嵌 Postgres |
| PostgreSQL 服务端 | PostgreSQL License | 数据库与内嵌实例 |
| [Tauri 官方目录组件](https://github.com/tauri-apps/plugins-workspace/tree/6aa2854f314481a459be1189b02c65a2450789ab/plugins/dialog)：tauri-plugin-dialog 2.7.3、tauri-plugin-fs 2.5.2、tauri-plugin 2.6.3 | Apache-2.0 OR MIT，本次选择 MIT | 原生目录选择及其运行、构建依赖。版权为 2017–Present Tauri Apps Contributors、2019–2022 The Tauri Programme 及 2019–2024 Tauri Programme；许可原文保存于 `licenses/tauri-dialog-MIT.txt`，随包进入 `legal/upstream/tauri-dialog-MIT.txt`。MIT 允许商业使用，分发保留版权和许可全文。 |
| [rfd](https://github.com/PolyMeilex/rfd/tree/a7116955d61dad7e7ebd7a2e870ab38c2abe5223) 0.16.1 | MIT | 原生文件对话框。Copyright (c) 2022 Bartłomiej Maryńczak；许可原文保存于 `licenses/rfd-MIT.txt`，随包进入 `legal/upstream/rfd-MIT.txt`。MIT 允许商业使用，分发保留版权和许可全文。 |
| [sharp](https://github.com/lovell/sharp) / libvips | Apache-2.0 / LGPL-3.0-or-later | 服务端图片处理；商业版需履行 LGPL 或替换（见 §H） |
| PGMQ（Postgres 扩展） | 见上游仓库（待核） | 队列；商业版默认排除，法务复核后使用（见 §H） |
| Node.js 运行时与工具链（pnpm/Turborepo/Biome/Vitest） | MIT / Apache-2.0 等 | 构建与测试；打包进产物的部分见 G2 |
| Temurin JDK 21（`runtime/jdk`） | GPLv2+CE | 桌面内置 Java 运行时；保留 NOTICE 与源码获取方式（见 §H） |
| eruda | MIT | 浏览器调试面板，**运行时从 CDN 拉取**（`PRIVACY.md` §5），不签入仓库 |
| sherpa-onnx / Silero VAD / Kokoro 多语版 / SenseVoiceSmall / espeak-ng 数据 | Apache-2.0 / MIT / Apache-2.0 / FunASR 许可 / GPL-3.0 | 语音链路（权重按需下载）。设置→关于页已列署名，其中 SenseVoiceSmall 的 FunASR 条款**须逐条核对是否允许你的用途** |

## C. 补丁与被修改的发行物

| 项 | 许可 | 说明 |
| --- | --- | --- |
| LangChain 1.5.11 发行入口补丁 | MIT（原代码） | 修复 afterModel 显式模型续跑路由。原许可全文保存在 `patches/LICENSE-langchain.txt`；来源哈希、改动与验证见 `patches/LangChain路由修复说明.md` |
| `packages/third-party/codex-patch/` | 见目录内 `LICENSE`、`NOTICE` | 对 OpenAI Codex 发行物的补丁，保留上游版权与许可声明 |
| `packages/third-party/kimi-edit/` | 见目录内 `LICENSE` | 同上，Kimi 相关 |
| `apps/server/src/features/process-sandbox/native/licenses/` | Apache-2.0（Codex）、Microsoft 开源许可（MXC） | `LICENSE-Codex.txt`、`LICENSE-Microsoft-MXC.txt`、`NOTICE-Codex.txt`，进程沙箱原生组件的来源声明 |
| `patches/` 其余 | 各包原生许可 | 每个补丁目录须自带来源与许可说明，缺失即为缺陷 |

## D. 第三方品牌标识与商标

`apps/web/src/components/workbench/zcode/assets/` 下的品牌图标**没有开源许可**，版权归各品牌权利人：

| 目录 | 数量 | 涉及品牌 |
| --- | --- | --- |
| `provider-icons/` | 17 个文件（10 png / 6 svg / 1 json） | OpenAI、Anthropic、DeepSeek、MiniMax、Moonshot Kimi、xAI、Xiaomi MiMo、Z.AI / BigModel、Alibaba Cloud、Start Plan、OpenRouter、OpenCode；`model-provider-logo-sources.json` 记录部分图标的来源 |
| `channel-icons/` | 6 个图标 + `index.ts` | Discord、钉钉、飞书、Telegram、企业微信、微信 |
| `cli-icons/`、`payment-icons/` | 已被移除 | 见下 |

- **使用方式**：仅作指示性使用——logo 紧邻其对应的供应商/渠道名称，用于标识功能入口，不暗示任何隶属、赞助或背书关系。
- **已清理**：未被代码引用的品牌图标共 28 个文件在提交 `93b7d1ca` 中从仓库删除，含 `payment-icons/` 全部 9 个支付类 logo（Visa、Mastercard、American Express、JCB、UnionPay、PayPal×2 及文本标），以及 `logo-anthropic.svg`、`logo-moonshoot.svg`、`logo-openrouter.svg`、`logo-zai-square.svg`、`model-provider-zai.png`、`cli-icons/icon-glm.png` 等；同轮删除的还有旧的 `favicon.ico` 与 11 个 `public/logo/icons/*` 尺寸（那些是我们自己的旧品牌资产，不属第三方）。随支付功能退役，`apps/server/src/features/payments/` 与 `apps/web/src/lib/payments-api.ts` 已一并移除。
- **再分发提示**：这些图标**不在 GPL-3.0 授权范围内**（`EULA.md` §5）。你再分发时应替换为自己绘制的文字标签或取得权利人许可。
- **权利主张**：品牌方如需我们调整或移除某个标识，请提 `https://github.com/IsKenKenYa/KenFutWork/issues`，我们会核实后处理。

## E. 字体与视觉素材

### E1. 第三方字体与素材

| 素材 | 许可 | 状态 |
| --- | --- | --- |
| Momo Trust Display（字标在用） | SIL Open Font License 1.1 | 合规：随产物分发于 `apps/web/public/fonts/` 与 `apps/landing/public/fonts/`，同目录带 `LICENSE.txt`（OFL 全文）；无保留字体名（Reserved Font Name） |
| CaveatBrush、ChakraPetch、GochiHand、K2D、Pacifico、PermanentMarker | SIL OFL 1.1 | 仅作为 `docs/视觉设计/logo/字体/` 的候选样张存在，未打进产物 |
| ArtierEN-2、No.019-Sounso-Quality-2、YEFONTPaws-Bold-2 | **需商业授权**（分别来自天津卓漫、上首品牌策划、深圳仪品） | 样张留在仓库**不构成授权**；未在产物中使用。逐字段落原文见 `docs/视觉设计/logo/字体/字体说明.md` |
| `skills/canvas-design/canvas-fonts/` | **54 个字体文件，仓库内无任何许可文本** | **待核**：分发前必须逐支确认来源与许可，不能默认沿用 GPL 或 OFL |

字体样张与图片素材不属于本项目代码，**不在 GPL-3.0 的授权范围内**，版权归各自权利人所有；我们不代为授权、不担保其授权状态与可用性。

### E2. 本项目自有的名称、标识与图标

这些是我们自己的资产，列在这里是为了把「代码按 GPL 走、标识不走」这条线画清（使用规则属主见 `EULA.md` §6.2–§6.4）。

| 资产 | 落点 | 来源与生成方式 |
| --- | --- | --- |
| 现行 KF 标识（2026-09-15 换版） | `apps/web/src/components/icons/kenfutwork-logo.tsx`、`docs/视觉设计/logo/新版.png`（源图）、`docs/视觉设计/logo/应用图标-白底圆角.png` | 组件注释记载为 **GPT 生成图定稿**，源图即上表 PNG |
| Web 静态标识 | `apps/web/public/` 的 `logo.png`、`logo-mark.png`、`app-icon.png`、`apple-touch-icon.png`、`favicon.png`、`og-image.png` | 由现行源图派生 |
| 落地页标识与点阵 | `apps/landing/public/assets/logo-mark.png`、`apps/landing/public/favicon.png` | 复用正式 Web 品牌；浏览器通过格点遮罩呈现点阵，不重画 Logo。装饰使用上列 Lucide 图标；动效视觉参考与独立实现说明见 `apps/landing/素材生成说明.md` |
| 桌面/移动应用图标 | `apps/desktop/src-tauri/icons/`（含 android `mipmap-*`、Windows `SquareNxNLogo.png`、StoreLogo） | 由 `apps/desktop/scripts/icons.mjs` 从**同一份墨迹**批量生成（2026-09-26 口径：墨迹占画布 80%） |
| 旧版字标 KF-2 骨架版 C（留档） | `docs/视觉设计/旧版/品牌Logo说明.md`（权威说明与几何/色值）、`docs/视觉设计/旧版/字体风格对比.html` | 纯手写 SVG；白字形是 **Chakra Petch Italic**（SIL OFL-1.1）字形的 K 轮廓 + 裁短 F 顶横的布尔并集，样张 `docs/视觉设计/logo/字体/ChakraPetch.woff2` |

- **归属**：名称、标识与图标的著作权及商标性权益归本项目维护者／该标识的创作者；**不随 GPL-3.0 分发**，不因代码贡献而共有，后续加入的协作者亦不因此取得标识权利。
- **OFL 一侧**：SIL OFL 不限制字形轮廓在标识中的使用，其「保留字体名」条款约束的是字体文件本身的命名与再分发，与旧版字标的设计无冲突。
- **如实登记不确定性（推测，非事实结论）**：现行标识出自生成式模型，纯 AI 生成内容的可版权性在各法域存在分歧——美国版权局现行立场是不保护缺乏足够人类作者性的 AI 生成输出；中国 2023 年北京互联网法院有承认「含人类智力投入与审美选择的 AI 生成图片可构成美术作品」的个案。我们以创作者与项目主体身份主张权利，但不保证在每个法域都能取得排他性保护；这不影响代码侧 GPL 授予的确定性。若要注册商标或对外授权，建议先做近似检索并保存创作过程证据（提示词、迭代与筛选记录）。
- **待核**：`og-image.png` 等派生图是否混入模型输出携带的其他第三方视觉元素，无法完全验证。

## F. 待合并子系统与外部引擎

| 项 | 许可 | 状态 |
| --- | --- | --- |
| 根 `flow/`（[futureFlow](https://github.com/future73807/futureFlow) 子模块，@ `d6c6af7`） | MIT | 上游 `cc10b0b` 已补标准许可文本，现有宿主能力分支合并保留在 `flow/LICENSE`；版权人为 `Copyright (c) 2026 future73807`。随产物分发时保留该许可与版权行；本地合并提交的远端可获取性仍须在父仓发布前核对 |
| `flow/` 内 vendored Python wheels（pg8000、asn1crypto、six、python-dateutil、scramp） | 各自原生许可 | **待核**：随 flow 分发前逐 wheel 抄录许可与版权行 |
| Dify（flow 的执行引擎方向，`DEC-11`） | Apache-2.0 + 附加条款（source-available） | 以**独立容器 + API 通信**接入，属聚合而非衍生作品；**禁止把 Dify 的 Python 代码复制进本 monorepo**，保持容器边界，分发时附其 `LICENSE`/`NOTICE` |
| OpenDesign（伴随容器，规划 §9-3 于 2026-10-15 拍板） | Apache-2.0（上游 [nexu-io/open-design](https://github.com/nexu-io/open-design)） | 以**独立伴随容器 + API 通信**接入，属聚合而非衍生作品。本仓仅收录伴随 compose `open-design/docker-compose.open-design.yml`（派生自上游 release `open-design-v0.24.1` 的 `deploy/docker-compose.yml`，改动：端口写死伴随 origin、restart 改 `unless-stopped`、去掉自托管透传项）；镜像按 digest 钉死 `ghcr.io/nexu-io/od@sha256:587a992857d0f8b71011e4bc55c5851e33ef9fc4c169fc17e6447700ac428f22`（2026-10-15 观测的 `latest`，registry 无版本形态 tag）；**不把上游源码克隆进 monorepo**，Apache-2.0 义务在镜像层内履行 |
| `references/` 全部子模块（Codex、Cherry Studio、Jaaz、kimi-code、langgraph、MCP SDK、Octop、nomifun-tauri、Loomic 等） | 各自许可（Apache-2.0/MIT 等） | **只作方向参考，未复制代码、schema、字段名与素材**（`flow/` 与 Code 模式的 ZCode 全量移植是明确例外，见 `AGENTS.md`）。子模块内容不随本仓库产物分发 |
| [Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app)，`references/toonflow-app`，固定 `d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d` | MIT；Copyright (c) 2026 HBAI-Ltd，见[上游许可](https://github.com/HBAI-Ltd/Toonflow-app/blob/d2e94aca7b59659ff6b4ca15f03cf134ec7f0e1d/LICENSE) | depth 1 只读参考；用于核验本地画布、媒体文件保存与任务恢复，不安装或执行上游，不复制实现，内容不随本仓库产物分发 |
| 技能市场与 MCP 目录下载的第三方技能/server | 各自许可 | 由你在市场/注册表安装，安装时应核对；本仓库不为其许可背书 |

## G. 分发义务

### G1. 随产物分发的声明文件

安装包与应用数据产物须带上：`LICENSE`（GPL-3.0 全文）、`NOTICE.md`、`EULA.md`、`PRIVACY.md`、本文件、`COPYRIGHT.md`、`licenses/loomic-MIT.txt`（产物内为 `loomic-MIT.txt`）、`licenses/tauri-dialog-MIT.txt`（产物内为 `legal/upstream/tauri-dialog-MIT.txt`）、`licenses/rfd-MIT.txt`（产物内为 `legal/upstream/rfd-MIT.txt`），以及 A3 图标目录的 `LICENSE`、A1 上游三份文本。装配点：`apps/desktop`（Tauri bundle resources）与 `scripts/package-mac.mjs` / `scripts/package-win.mjs`。

### G2. 待办（本轮如实登记，不假装已完成）

1. **npm 依赖的许可文本随包分发**：产物内嵌了数百个 MIT/BSD/ISC 依赖，它们的版权与许可声明需要以 `LICENSES/<包名>.txt` 之类的形式随包提供。上游 ZCode 有可借鉴的生成器（`references/zcode/scripts/generate-third-party-notices.mjs` + `licenses.mjs` + `license-texts/`），我们需要自己的等价脚本，从 `pnpm-lock.yaml` 生成。
2. **GPL-3.0 第 6 条对应源码的传送机制**：桌面产物是「用户产品」，须在产物内或书面要约中明确告知完整对应源码的获取地址与可复现构建指令。当前 `EULA.md` §13 已写明机制，产物内的落地待 G1 的装配点一并完成。
3. `skills/canvas-design/canvas-fonts/` 54 支字体的许可核实（E 段）。
4. PGMQ 与各 Python wheel 的许可文本抄录（B、F 段）。
5. 本文件应随每次引入新依赖/新素材的 PR 更新；新增 vendored 文件却未在此登记，视为分发缺陷。

## H. 商业版资产合规

> 本节是商业版构建的许可白名单/排除清单。社区版继续按 GPL-3.0 分发，不受本节影响；商业版发布前必须逐项核对：红项清零，黄项义务落地，灰项法务放行。第三方许可事实的唯一属主仍是本文件；[`COMMERCIAL-LICENSING.md`](COMMERCIAL-LICENSING.md) 只引用本节。

### H1. 分级

- **绿**：可直接进入商业版；保留版权、许可与 NOTICE，标注修改。
- **黄**：履行特定义务后可用（LGPL 重链接/源码、GPL+CE 声明、Dify 边界）。
- **红**：不得进入商业版，除非替换或取得权利人书面授权。
- **灰**：默认排除；法务复核后再决定。

### H2. 矩阵

| 资产 | 许可 | 商业版 | 义务/动作 |
| --- | --- | --- | --- |
| ZCode（含移植 UI） | Apache-2.0 | 绿 | 保留 `LICENSE`/`NOTICE.md`，标注修改，不用商标；确认版权人（现写 Z.AI Co., Ltd，上游无 Copyright 行）；补齐 `packages/zcode-*` 缺失的 LICENSE 文本 |
| futureFlow（`flow/`） | MIT | 绿 | 保留 `Copyright (c) 2026 future73807` 与 MIT 全文；发布前核对固定提交远端可获取性 |
| Loomic（项目前身） | MIT | 绿 | 保留 `licenses/loomic-MIT.txt` 与 `COPYRIGHT.md`；取得 Xinmin Zeng 书面来源确认 |
| ai-elements | Apache-2.0 | 绿 | 保留 Vercel 版权与 Apache-2.0 NOTICE |
| Material Icon Theme | MIT | 绿 | 保留 MIT 全文 |
| shadcn/ui | MIT | 绿 | 保留来源注释与 MIT |
| lucide-react | ISC | 绿 | 保留 ISC |
| Excalidraw / Next.js / React / Tailwind / Base UI / embedded-postgres / PostgreSQL | MIT / PostgreSQL License | 绿 | 随包保留各自许可与版权 |
| Momo Trust Display | OFL-1.1 | 绿 | 保留 OFL；确认无保留字体名冲突 |
| sharp / libvips | Apache-2.0 / LGPL-3.0-or-later | 黄 | 确认 libvips 链接方式；提供 LGPL 声明、对应源码/修改与重链接方式，或替换为宽松许可库 |
| Temurin JDK 21 | GPLv2+CE | 黄 | 独立 runtime；保留 NOTICE，提供源码获取方式；CE 允许闭源分发 |
| Dify | Apache-2.0 + 附加条款 | 黄 | 保持用户自行拉取容器，商业版不捆绑镜像/代码；多租户 SaaS 需书面商业授权 |
| espeak-ng data | GPL-3.0 | 红 | 商业版排除或替换；社区版按 GPL 履行 |
| `skills/canvas-design/canvas-fonts/` | 无许可文本 | 红 | 商业版排除；逐支核实前不得分发 |
| 三支商业字体 | 需商业授权 | 红 | 商业版排除，除非取得字体权利人授权 |
| provider/channel 品牌图标、ZCode 品牌图标 / 供应商 logo | 无开源许可 | 红 | 商业版替换为文字标签或取得品牌方许可；仅指示性使用不等于授权 |
| SenseVoiceSmall | FunASR Model License | 灰 | 法务逐条核对后再决定；默认排除 |
| PGMQ | 见上游仓库 | 灰 | 法务复核；默认排除 |
| `flow/` 内 vendored Python wheels | 各自许可 | 灰 | 逐 wheel 抄录许可与版权；未核完默认排除 |
| Contributor Covenant 2.1（行为准则文本） | CC BY 4.0 | 绿 | 文档使用；保留署名与许可链接 |

> 历史贡献不在本节：`81eecbb4`（PR #4）未获书面许可前不得进入商业版；future73807 的贡献由《共同所有者协议》覆盖；Loomic 由 MIT 与书面确认覆盖。见 `DEC-24` 与私有排除清单。

### H3. 门禁

1. 私有商业仓维护机器可读的 allowlist/denylist（从本节派生），构建时阻断红项与未登记资产。
2. 每次发布生成 SBOM 与许可清单；新增/升级依赖必须重新核对本节。
3. 商业版安装包必须带 `LICENSE`/`NOTICE.md`/`EULA`/`PRIVACY`/`THIRD-PARTY-NOTICES`/`COPYRIGHT` 与对应上游许可文本。
4. 本节变更需两位共同所有者复核（`.github/CODEOWNERS`）。
5. 商业版不得包含公开仓未出现、且未登记来源与许可的代码/素材。

### H4. 复核记录

| 日期 | 结论 | 备注 |
| --- | --- | --- |
| 2026-10-20 | 初版矩阵 | ZCode 版权人、sharp/libvips 链接方式、SenseVoice/PGMQ/flow wheels 仍待核；商业发布前必须清零 |

## I. 联系

许可与授权问题见 [`EULA.md`](EULA.md)；数据处理见 [`PRIVACY.md`](PRIVACY.md)；商业许可见 [`COMMERCIAL-LICENSING.md`](COMMERCIAL-LICENSING.md)；权利人主张与缺陷报告统一走 `https://github.com/IsKenKenYa/KenFutWork/issues`。
