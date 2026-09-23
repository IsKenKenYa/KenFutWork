# 参考项目模型 Provider 调研（LLM / IGM / VGM）

> 角色：调研记录（参考）。非权威——落地结论一律写入权威文档：《改造计划》§4.8（BYOK 供应商缝）与 §4.10（扩展点机制表）。
> 依据：`references/` 下浅克隆子模块的**真实源码**（版本见 §8），非二手转述；引用均给出文件路径，便于复核。
> 覆盖范围：只分析「模型 Provider」这一横切——LLM（对话/推理）、**IGM**（图像生成）、**VGM**（视频生成 + 视觉输入）。agent 主循环、工具、MCP、skill 另有《01-deepseek-harness插件调研》与《Agent设计最佳实践研究报告》覆盖，本文不重复。
> 红线：`references/` 项目**只作方向参考**。cherry-studio 为 AGPL-3.0，移植其代码会污染本仓库许可；本文只提炼**结构与契约形状**，字段名、schema、代码一律不照抄。

---

## 1. 问题

当前项目的模型能力契约只有三个值：`modelCapabilitySchema = "chat" | "image" | "video"`，模型条目只有 `{ id, name, capability, vision?, contextWindow? }`（`packages/shared/src/provider-contracts.ts`）。

BYOK 用户手填模型清单后，系统**无法表达也无法校验**下列事实：

- 这个聊天模型支不支持工具调用、推理档位、图像/视频**输入**；
- 这个图像模型的参数词表是什么（比例、尺寸、负向词、步数、引导强度、水印…），哪些参数它根本不接受；
- 这个视频模型的时长/分辨率上限、是否支持首尾帧、同步还是异步端点；
- 同一模型名在不同网关下该走哪个端点、失败该归到哪一类。

结果是这些判断散落在适配器与产品代码里，用户与管理员都无法声明，且每次新增厂商都要改代码。本次调研回答一个具体问题：**成熟项目如何把「模型能力」做成可声明的数据，以及 IGM / VGM 这两条我们没有先例的路径该怎么分层。**

---

## 2. 本项目现状锚点（对比基线）

| 维度 | 现状 | 落点 |
| --- | --- | --- |
| 能力词表 | 单值枚举 `chat \| image \| video` | `packages/shared/src/provider-contracts.ts` |
| 模型行 | `{ id, name, capability, vision?, contextWindow? }`；`vision` 仅作前端徽标 | 同上（`providerInstanceModelSchema`） |
| 线协议 | 封闭 7 项：`openai-compatible` / `anthropic` / `gemini` / `google-image` / `replicate` / `volces` / `metaso` | 同上（`providerProtocolSchema`） |
| 协议→能力矩阵 | `CHAT_ADAPTERS` / `IMAGE_ADAPTERS` / `VIDEO_ADAPTERS` 三张表，缺项 fail loud | `apps/server/src/providers/resolve.ts` |
| 适配器 | `providers/<protocol>/index.ts`，聊天复用 LangChain，图/视频复用 `generation/providers/*` | `apps/server/src/providers/` |
| 旧注册路径 | `register-all.ts` 按服务端 env 注册图/视频 provider（迁移期遗留，待随 BYOK 切换退役） | `apps/server/src/generation/providers/register-all.ts` |
| 目录 | `modelCatalog` 由实例+模型**平坦推导**，specifier 为 `<instanceId>:<modelId>` | `apps/server/src/features/model-providers/model-catalog-service.ts` |
| 图像参数 | `ImageGenerateParams`：`prompt / model / aspectRatio? / inputImages? / quality?(standard\|hd\|ultra) / outputFormat?` | `apps/server/src/generation/types.ts` |
| 视频参数 | `VideoGenerateParams` + `VideoModelInfo.capabilities/limits/pricing`（**已领先**：能力与上限已成结构） | 同上 |
| 异步 | 生产侧有 job + 轮询兜底；provider 内自行 poll | `generation/providers/*-video.ts` |

**关键观察**：视频侧（VGM）已经有 `capabilities{textToVideo,imageToVideo,videoToVideo,audio}` 与 `limits{maxDuration,maxResolution,maxInputImages}` 这类结构化能力；**图像侧（IGM）与聊天侧（LLM）反而更弱**（聊天只有 `vision` 布尔 + `contextWindow`，图像只有语义化 `quality`）。调研的价值主要落在补齐这两处，并把「能力」从 provider 代码里提到契约层。

---

## 3. 逐项目发现

### 3.1 cherry-studio — IGM 最完整的参照（v2.0.14，AGPL-3.0）

**把模型目录做成代码生成流水线**（`packages/provider-registry/docs/architecture.md`）：

```text
手写源                          生成器                          生成物                       运行期
src/creators/<vendor>.ts  ──┐
  (defineCreator)           │
src/providers/<prov>.ts   ──┼──► scripts/generate-catalog.ts ──► data/models.json
  (defineProvider)          │      buildIndex / assignCreators     data/providers.json
models.dev + OpenRouter   ──┘      buildModels / buildProviders ──► data/provider-models.json
                                   buildProviderModels
```

三个生成物各司其职，**这是最值得借的形状**：

| 生成物 | 职责 | 主键 |
| --- | --- | --- |
| `models.json` | 模型**固有**元数据：`capabilities`、`inputModalities`/`outputModalities`、`contextWindow`、`maxOutputTokens`、`ownedBy` | 归一化模型 id |
| `providers.json` | **连接配置**：`endpointConfigs`（每种端点类型的 `adapterFamily` + `baseUrl` + `dialect` + `reasoningFormat`）、`defaultChatEndpoint`、`apiFeatures` | provider id |
| `provider-models.json` | **M:N 例外**：`apiModelId`、pricing、image transport、按端点区分的 `reasoningContracts`、`disabled` | (providerId, modelId) |

第一方/标准情形**不产生行**——运行期走 `apiModelId → normalizeModelId → models.json` 推导；只有推导不出来的东西才落一行。这条「例外才落行」的纪律，正是我们当前契约把「固有元数据」与「实例覆盖」混在一张 `models[]` 里的反面。

**禁手改门禁**：CI 做**路径耦合检查**——PR 只改 `data/**` 而不改 `src/**` 或 `scripts/**` 即失败。刻意不做「重新生成后 diff」（免去确定性构建的负担），只拦住「直接编辑生成物」这一件事。

**能力词表**（`packages/provider-registry/src/schemas/enums.ts`，kebab-case 值 + `objectValues()` 喂 `z.enum`）：

- `MODEL_CAPABILITY` 16 项，含 `image-generation` / `video-generation` / `image-recognition` / `video-recognition` / `embedding` / `rerank` / `structured-output` / `file-input` / `code-execution` / `computer-use`；
- `MODALITY = text | image | audio | video | vector`（输入/输出各一份数组）；
- `ENDPOINT_TYPE` 15 项，含 `openai-image-generation` / `openai-image-edit` / `openai-video-generation` / `openai-audio-transcription` / `jina-rerank`。

**模型行**（`src/schemas/model.ts`）：`capabilities[]` + `inputModalities[]`/`outputModalities[]` + `contextWindow`/`maxInputTokens`/`maxOutputTokens` + `endpointTypes[]` + `reasoning{controls, thinkingTokenLimits, selectableEfforts, defaultEffort, interleaved}` + `parameterSupport`（**DB 表单形与 Runtime 形两套**：DB 存 `{supported, range}`，运行期物化为 `{supported, min, max, default}`）+ `pricing{tiers, cacheRead, cacheWrite}` + `imageGeneration` + `isEnabled` / `isHidden` / `isDeprecated` / `replaceWith`。

**IGM 分层**（architecture.md 的 Design B：「**creator 拥有元数据，provider 拥有参数支持**」）：

- 模型级 `imageGeneration.modes{mode}.supports`：`mode ∈ generate | edit | remix | upscale | merge`；`supports` 是参数词表的**子集**，逐模型声明其可接受的键与取值约束；
- 模型级另有 `maxInputImages`、`requirePrompt`——DashScope `qwen-mt-image`（图文翻译，无提示词）与 PPIO 去背景/放大类模型要求 `requirePrompt: false`，通用管线据此**不强制非空 prompt**；
- provider 级 `ModeDef.vendorTransport{endpoint, isSync}`：异步/同步端点路由按 provider 覆盖。**覆盖是整体替换而非深合并**（`override.imageGeneration ?? model.imageGeneration`），因此模型级块**不得**携带 provider 专有 transport，否则每个未覆盖的 provider 都会继承错误端点；
- 参数词表**单一来源**：`CANONICAL_PARAM_KEY`（44 键，**刻意 camelCase**——它们就是运行期参数包 `painting.params` 的键，转 kebab 会破坏线上契约）+ `IMAGE_PARAM_CATALOG`（`satisfies Record<CanonicalParamKey, …>` 做**穷尽编译校验**，键集与词表精确相等 44:44；每键 = zod 值类型 + 厂商线上字段名 `wire`，默认 camelCase→snake_case；`imageResolution→size`、`addWatermark→watermark` 这类不规则单独声明）；
- 线上拼装与投递分离：`WireProfile{forward, fields{to|map|contribute}}` + `buildImageRequest()` 负责「canonical 参数包 → 厂商 body」；`WireRegistration`（`dualOpenAI`/`passthrough`）+ `buildVendorProviderOptions()` 负责「body 挂在哪个 provider 键下、未映射字段是否透传」。**profile 不承担投递决策**；
- 传输三层：`ImageGenerationTransport{submit, poll?, cancel?}` + `ImageTransportDescriptor{id, endpoint, isSync, mode}`（**由服务端从注册表推导，不是用户参数**）+ `imageTransportRegistry.ts`（`supports(modelId)` + 惰性 `import()` 装载，避免首屏打包全部厂商）；
- 落地形态：图像生成包装成 AI SDK 的 `ImageModelV3`（`createImageGenerationModel()` 内部 `submit → 可选 poll → 返回 URL`），与对话走**同一条插件/中间件链**；`maxImagesPerCall` 声明在模型上。

**VGM 现状（重要）**：词表已就位、**实现未落地**——`video-generation` 能力与 `openai-video-generation` 端点类型已建模（生成数据 `data/models.json` 中 63 处 `video-generation`），但仓库内视频相关代码只有消息渲染与标签（`MessageVideo.tsx` / `VideoTag.tsx`），没有视频生成 provider。**它不能作为 VGM 实现参照，只能作为 VGM 词表参照。**

**其他可借**：`UniqueModelId = providerId::modelId`（zod 校验 + `parseUniqueModelId`）；`ReasoningControl` 判别联合（`effort | budget | toggle`）把「档位 / token 预算 / 开关」三种推理控制形态统一；`reasoningFamilies` **把模型 id 正则知识写成数据**，生成期编译成每模型 `controls` 与产物 `patterns/reasoning-families.gen.ts`，并明确「一个规则只带模型旋钮、绝不带 wire 格式——开放权重模型的序列化方言跟随服务端点，不跟模型 id」；`serverTools`（provider 原生内置工具，作用域 `all-chat-models | model-dependent`）。
### 3.2 kimi-code — LLM 能力模型与媒体降级最完整（v0.1.1，MIT）

**Provider 抽象**（`packages/agent-core-v2/src/human/llm/provider/definition.ts`）：

- `ProviderDefinition = { id, protocols: { openai | openai_responses | anthropic | google-genai → ProtocolBinding }, media?, models? }`；
- `ProtocolBinding = { base, trait?, connection?, classifyError?, capability? }`——**协议实现（base）与线上微调（trait）分离**，`capability(modelName)` 可按模型名推断能力；
- `createProvider()` 校验「至少声明一个协议」「未知协议报错并列出可用协议」；
- `Provider = { id, protocols[], listModels(), resolveModel(model, opts), createRequester(protocol?) }`——**同一 provider 可挂多协议**（openai 同时挂 `openai` 与 `openai_responses`）。

**能力模型**（`human/llm/capability.ts`）——这是本次调研里最有价值的一个小文件：

```ts
ModelCapability = { image_in, video_in, audio_in, thinking, tool_use, dynamically_loaded_tools }
```

并配 `UNKNOWN_CAPABILITY` 冻结哨兵 + `isUnknownCapability()`：**「未知」与「全否」是两种不同状态**。未识别模型走哨兵而非默认全 false，避免把「还没搞清楚」当成「肯定不支持」而错误降级——这对 BYOK 用户手填模型的场景是刚需。

**目录（三层：发现 / 覆盖 / 错误）**（`human/llm/provider-catalog.ts`）：

- 每个 provider 一条 `CatalogProviderEntry{ info, discovered, override, pingErrors }`；
- `modelSource: 'static' | 'discover' | 'oauth-catalog'`——目录来源本身是被声明的；
- `CatalogModelOverrides{ maxContextSize, maxInputSize, maxOutputSize, capability, displayName, reasoningKey, adaptiveThinking, supportEfforts, defaultEffort, offEffort, alwaysThinking }`——**发现结果可被逐字段覆盖，而不必整体重写**；
- 事件 `upsert | remove | refresh | ping`，且 `pingError` **按模型单独记录**：一个模型探测失败不阻断其它模型可用。

**上游目录与凭证**：models.dev 作为上游（`app/kosongConfig/modelsDev*.ts`，含**内置快照兜底**，公共目录不可达时可离线导入）；用户配置 `config.toml` 的 `[providers.<name>]`（`type` 决定协议）+ `[models.<alias>]`（`provider`/`model`/`max_context_size`/`capabilities`）；**凭证优先级 `api_key` 字段 > `env` 子表 > 启动期报错**，且「CLI 不会从 shell 环境变量自动取凭证」。目录中未声明协议的厂商按 OpenAI 兼容导入并显示 "guessed" 提示，专有协议（Bedrock/Cohere）直接拒绝导入，deprecated/alpha 模型不入列表——**推测要标注、拒绝要显式**。

**媒体层（VGM「视觉输入」侧的最佳参照）**（`human/llm/media/*`）：`ref/source/store/upload/resolver/mime/image-formats/cache` + `degrade.ts`。`degrade.ts` 两个策略：`degradeOlderMediaParts(messages, keepRecent)`（超请求体积上限时丢最旧的媒体、**保留最近 N 个**）与 `stripMediaParts()`（provider 不支持该模态时整体剥离），**占位文本明确写出「已省略、如何重新读取」**（如 `[image omitted: dropped to fit the provider request size limit; re-read the file to view it]`）。provider 级用 `media: { inlineVideo: true }`（`provider/providers/standard.ts` 的 google provider）声明差异。

**其他**：`completion-budget.ts`（输出预算）、`model-auth.ts` / `model-oauth.ts` / `credential-recovery.ts`、`host-request-headers.ts`；TUI `/provider` 交互式管理 + `kimi-inspect` 的 `ModelCatalogView`；ACP 侧 `packages/acp-server/src/model-catalog.ts` 复用同一目录。

### 3.3 nomifun-tauri — 能力持久化与协议修订号

**任务优先的能力分类**（`crates/backend/nomifun-api-types/src/model_task.rs`）：

- `ModelTask = chat | realtime_conversation | image_generation | image_edit | video_generation | speech_synthesis | speech_recognition | embedding | rerank`——**任务决定协议描述符，描述符拥有传输与端点契约**；
- `ModelTrait = vision_input | function_calling | reasoning | web_search | audio_input | audio_output | video_input | realtime | streaming`——任务内修饰，主要作用于 chat；
- `realtime_conversation` **刻意与 `chat` 分离**：「能力不可在两个任务之间互相替代」。

**持久化形状**：表 `provider_model_capabilities`，一行一权威，键 =（provider, model, **task**），列含 `traits`、`protocol`（如 `ark.images`）、`connection_role`、`base_url_override`、`endpoint`、`poll_endpoint`、`content_endpoint`。注意：**协议是按任务绑定的，而不是按实例绑定的**——同一实例的图片生成与视频生成可以是两套协议。

**「推测 ≠ 授权」写得非常明确**（`model_capability.rs` 文件头）：名字推断（`infer_model_modalities` / `infer_generation_capabilities`，`IMAGE_GENERATION_INCLUDE` 含 `seedream/flux/nano-banana/...`，`VIDEO_GENERATION_INCLUDE` 含 `veo/kling/seedance/...`）**只用于目录建议与默认值，永不授权调用；持久化行是唯一运行期权威**。这与我们的 BYOK 红线同向，是可引用的原则原文。

**`providers.config_revision`**：能力图变化时自增修订号，使**已持久化的异步句柄与已解析的缓存调用不得跨升级复用**（迁移 `051_ark_image_edit_capabilities.sql` 的写法）。对「异步视频任务在能力声明变更后仍引用旧协议」这类老化问题，这是很轻的解法。

**线上怪癖收敛在适配器**：`crates/agent/nomi-providers/src/{openai,openai_responses,anthropic,anthropic_shared,gemini,vertex,bedrock}.rs` + `retry.rs`；`OutputCeilingLocation` 专门表达「`max_tokens` 被改名 / 顶层 vs 嵌套」这类输出上限位置差异——**把「同一语义在不同线上的位置」建模成一等类型**。


### 3.4 deepseek-harness — provider-neutral 服务与图像预算

- **逻辑契约中立、适配器拥有 wire**；注册表是拓扑属主；请求深冻结可回放；每次 stream 恰好一个终态 `finish`（`packages/llm/llm/README.md`）。
- 模型能力解析包含**上下文窗口、输出默认、`reasoningEfforts`、输入模态、`systemPromptUpdate` 模式**；`systemPromptUpdate === 'in-history'` 表示「任意位置的 system 消息都被当作有效系统提示」，缺省表示「只读开头那条」；其它取值以 `INVALID_MODEL_INFO` 拒绝。
- **图像预算与卸载**：`LlmImageRequestBudget` 超限以 `IMAGE_OFFLOAD_REQUIRED` 失败并**点名最旧的若干张**（`requiredImageOffload()`）；纯文本路由收到**确定性占位文本**（含嵌套工具结果里的图像），**绝不改写只追加的会话历史**；收费视觉 token 的路由声明 `imageRequestPricing`，由 `ctx.llm.imageRequestPricing()` 同步解析给 token meter。
- **pi-ai 路由配置面**（`packages/llm/llm-pi-ai/README.md`）：`api` / `apiKeyEnv` / `baseURL` / `models` / `modelOverrides` / `compat` / `defaultContextWindow` / `defaultMaxTokens` / `requestImagePixelBudget` / `requestImageMaxBytes` / `maxRequestImageBytes` / `retryPolicy`。两条纪律值得直接借：
  - `reasoningEfforts` 是**「档位 → 线上拼写」映射**（如 `max: ultra`，给网关改名用），档位词表与线上词表解耦；
  - `models` 是**整体替换**目录而非追加，且 `modelOverrides` 与 `models` 同时出现即拒——「一个静默不生效的模型，会变成以后有人到处找的错别字」。
- **稳定错误码**：`NO_ADAPTER` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `UNKNOWN_MODEL` / `QUOTA` / `RATE_LIMIT` / `CONTEXT_WINDOW_EXCEEDED` / `UNSUPPORTED_OPTION`——消费方**按码路由，不按文案**。
- 未配置的路由可保持「configured-but-keyless」，`LlmConfigurableProvider.error` 报诊断而不阻断其它 provider 可服务。

### 3.5 jaaz — 零改动注册

`server/tools/image_providers/image_base_provider.py` 与 `video_providers/video_base_provider.py`：抽象基类 + `__init_subclass__(provider_name=…)` **自动登记**进类级 `_providers` 字典 + `create_provider(name)` 工厂 + `get_available_providers()`；`video_generation_core.py` 只 import 具体 provider 以触发注册（注释明确「don't delete these imports」）。收益：新增 provider 只加一个文件；代价：注册依赖 import 副作用，漏 import 即静默缺能力。产物形状：图像返回 `(mime, width, height, filename)`，视频返回 URL——**把「生成调用」与「产物取回」分成两件事**。

### 3.6 jellyfish — ProviderSpec + 类别矩阵

`backend/app/services/llm/provider_registry.py`：`ProviderSpec{ key, display_name, aliases, supported_categories, default_base_url, requires_api_key, requires_api_secret, is_experimental }`，注册表带 **别名冲突检测**（`provider alias conflict`）与 `is_provider_category_supported(provider_key, category)`；`provider_bootstrap.py` 种子内置 provider，`provider_resolver.py` / `runtime.py` 按行组装 chat model。与我们的 `features/model-providers` 同形，差异在于**每个 provider 显式声明它支持哪些模型类别**（对应我们的 `resolve.ts` 三张表，但他们把矩阵变成了数据）。

### 3.7 futureFlow — 反面参照

`gateway/src/llm/llm-proxy.controller.ts`：单一上游 LLM 代理，用**服务端 Key**、**忽略请求方 `Authorization` 头**、模型被 `LLM_DEFAULT_MODEL` 强制覆盖（画布模型名仅作展示）。它解决的是「浏览器直连供应商的 CORS 预检 403 + Key 不下发浏览器」，**不是 BYOK**。我们的 BYOK 语义（用户自带实例、按实例解析协议与凭证）与之相反，不应照搬；仅可借鉴「代理只转发到配置的单一上游、不构成开放代理」这条收敛原则。

### 3.8 loomic — 本项目前身快照

`apps/server/src/generation/providers/*` 与 `http/models.ts` 与当前仓库同构（同一代码系），**无新增信息**，仅作回归对照，不单独列为学习来源。

### 3.9 seedance-2.0-skill / codex / system-prompts（旁证，非 provider 参照）

- `seedance-2.0-skill`：Seedance 视频生成的**提示词工程与质检**参照（`references/storytelling-framework.md`、`continuity-qc.md`、首尾帧指南、eval rubric），是**内容层**参照，不含 provider 抽象——VGM 的「怎么调」可从这里学，「怎么接」仍需自己设计。
- `codex`：用 TOML 的 `model_providers` 表声明 provider（含 `env_key`、`wire_api`、`query_params`），可作「配置即 provider 注册」的极简参照。
- `system-prompts-and-models-of-ai-tools`：第三方工具的模型/提示词清单，仅作名称与档位对照，无 provider 设计。
- `mcp-servers` / `mcp-typescript-sdk`：与模型 Provider 无关。

---

## 4. 三维度汇总对照

| 维度 | cherry-studio | kimi-code | nomifun-tauri | deepseek-harness | jaaz | jellyfish | 本项目现状 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LLM 能力表达 | `capabilities[]` + 模态数组 + `endpointTypes[]` + reasoning 结构 + `parameterSupport` | `{image_in,video_in,audio_in,thinking,tool_use}` + UNKNOWN 哨兵 | `ModelTask.chat` + `ModelTrait.*` | 上下文/输出/`reasoningEfforts`/输入模态/systemPrompt 模式 | 单 `generate()`，无能力模型 | `supported_categories` 矩阵 | `chat` 单值 + `vision` 布尔 |
| 目录来源 | 手写源 → 生成 JSON（models.dev/OpenRouter 上游） | models.dev + 内置快照 + 自定义 registry | 用户配置持久化为能力行 | 目录由 profile 声明，`discover` 仅作候选 | 无目录，运行时按名分发 | 内置 spec + 用户行 | 用户实例平坦推导 |
| IGM 参数 | canonical 词表（44 键）+ 逐模型 `supports` + wire profile + 传输注册表 + `ImageModelV3` | 无（只有视觉**输入**） | `image_generation`/`image_edit` 任务行 + `ark.images` 协议 | 无生成侧（只有图像**输入**预算） | 基类 `generate(prompt,model,aspect_ratio,input_images,metadata,**kwargs)` | 无 | `aspectRatio`/`inputImages`/语义 `quality`/`outputFormat` |
| VGM | **词表有、实现无** | 无视频生成；有 `video_in` 与 `inlineVideo` 媒体贡献 | `video_generation` 任务 + `poll_endpoint`/`content_endpoint` 列 | 无 | `VideoProviderBase`（分辨率/时长/比例/`camera_fixed`）+ 自动注册 | 无 | `capabilities`/`limits`/`pricing` 已成结构（**相对领先**） |
| 异步 | `submit/poll?/cancel?` + 服务端推导的 transport descriptor | 无 | 端点拆分（submit/poll/content）+ `config_revision` | 单次 stream 不重试（重试是独立包） | 各 provider 自管 | 无 | provider 内自管 poll |
| 失败语义 | per-model `pingErrors` | per-model `pingError` + 稳定码 | 能力行健康复位 | 稳定错误码 + 按码路由 | 抛 `ValueError` | `HTTPException` | `GenerationError(name, code, msg)`（已有码） |

---

## 5. 对本项目的可学习点（按落点给出提案）

> 下列提案**本次不实施**；实施按《日志》台账逐 PR 进行，并遵守「能力缝三元组完整」与「新增协议先扩契约」两条硬约束。

### 5.0 统一前提：能力词表从「生成能力」升级为「任务 + 修饰」

现状（`chat|image|video` 单值）与四个项目的做法（**任务决定协议与传输，修饰描述任务内能力**）差异最大。最小步子的形状：

- 保留 `modelCapabilitySchema` 作为**任务**词表，但补齐：`chat | image-generation | video-generation | image-edit | embedding`（先只加 `image-edit`——「参考图编辑」在现有 `inputImages` 里已经存在，却无法被声明）；
- 新增 `modelModifiersSchema`（对应 nomifun `ModelTrait` / kimi `ModelCapability`）：`vision-input | video-input | audio-input | tool-calling | reasoning | structured-output`，替代裸 `vision?: boolean`；
- **引入「未知」语义**（kimi `isUnknownCapability`）：`modifiers` 缺省 = 未知而非全否；只有显式否定才走「不支持」路径。

落点：`packages/shared/src/provider-contracts.ts`（+ 契约测试）、`model-catalog-service.ts`（目录条目透出）、`apps/web` 徽标与筛选。

### 5.1 LLM

1. **能力未知哨兵**（kimi）：未识别模型不得默认按纯文本处理——我们目前没有这条，会把「没声明」误当「不支持」而错误降级。
2. **端点/协议按模型路由**（cherry `endpointTypes` + `resolveEffectiveEndpoint`；kimi 一 provider 多协议）：我们的 `providerProtocolSchema` 是**实例级单值**，无法表达「同一网关 chat 走 `/v1/chat/completions`、图像走 `/v1/images/generations`」，现在只能把实例拆成两个。可提案：模型级可选 `protocol` 覆盖实例级默认，解析集中在 `providers/resolve.ts`（避免协议判断散进业务代码）。
3. **覆盖与发现分层**（kimi `discovered/override/pingErrors`；dsh `models` 替换 vs `modelOverrides`）：我们的实例 `models[]` 同时承担「目录」与「覆盖」，且**整体替换语义未写明**。建议契约注释写明替换语义，并加「同键不得重复声明」校验，挡住静默不生效。
4. **推理档位与线上拼写分离**（dsh `reasoningEfforts`）：我们用 LangChain，暂无推理档位面；若补，必须照 dsh 把「UI 档位词表」与「线上拼写」分开，否则每个网关都要在业务代码里加分支。
5. **稳定错误码并按码路由**（dsh + nomifun `ProviderError`）：我们已有 `GenerationError(code)`，但 `providers/*` 与 agent 链路仍以 message 文本为主；建议把「按码路由」写进错误码表（落点：共享契约 + `resolve.ts` 的 fail loud 分支）。
6. **保存期 fail loud**（kimi 凭证优先级 + 启动期报错；仓库 AGENTS.md 已有同名硬约束）：具体到 BYOK——「实例声明了 chat 模型但协议不支持聊天」应在保存期拒绝，而不是运行 agent 时才炸。`resolve.ts` 的三张表已能给出判定，把它前移到实例校验即可。

### 5.2 IGM（图像生成）— 最该补的一块

1. **参数词表 + 逐模型子集**（cherry `CANONICAL_PARAM_KEY` + `imageGeneration.modes[].supports`）：把 `ImageGenerateParams` 从「一堆可选字段」升级为「一个规范化参数包（canonical 键：`aspectRatio`/`size`/`seed`/`negativePrompt`/`guidanceScale`/`steps`/`n`/`watermark`/`outputFormat`…）+ 每模型声明其**支持的子集与取值约束**」；参数键**单一来源 + 穷尽校验**（`satisfies Record<Key, Entry>`，缺键即编译错），避免「表单加了字段、适配器忘了读」。
2. **wire 映射与投递分离**（cherry `WireProfile`：`forward` 平推 / `fields.to|map` 显式改名与变换 / `contribute` 一对多嵌套；投递由注册声明处理）：我们现在是每个 provider 手写 body 组装（`openai-image.ts`、`volces-image.ts` 各自拼），加第二个厂商就会复制第二十份——这是仓库「消灭复制粘贴」护栏的直接落点。
3. **模式（mode）而不是一个 `generate`**（cherry `generate|edit|remix|upscale|merge` + `requirePrompt`）：我们有 `inputImages`，但没有「生成还是编辑」的显式声明，也没有「不需要 prompt 的模型」（超分/去背景/图像翻译类）。建议 `imageGeneration` 按模式声明支持面，`requirePrompt` 默认 true。
4. **传输三段式**（cherry `submit/poll?/cancel?` + descriptor；nomifun `endpoint`/`poll_endpoint`/`content_endpoint` 三列；jaaz 分离生成与取回）：我们的视频 provider 已在内部自己 poll（`replicate-video.ts`、`metaso-video.ts`），图像全同步。建议把「提交/轮询/取消」提为 `ImageProvider`/`VideoProvider` 的可选第三段；至少把 descriptor 从**服务端注册表**推导（cherry 的纪律：路由不是用户参数）。
5. **张数与参考图上限声明在模型上**（cherry `maxImagesPerCall` / `maxInputImages`）：我们的 `n`（张数）与参考图上限目前不可声明，只能适配器硬编。
6. **语义 `quality` 保留但要可推导**：`ImageQuality = standard|hd|ultra` 是有意的好设计（供应商各自翻译成自己的 resolution），与 cherry 的参数词表不冲突——建议保留语义档位，同时让它成为词表里的一个键，取值约束逐模型声明。

### 5.3 VGM（视频生成 + 视觉输入）

1. **任务级能力行**（nomifun）：`VideoModelInfo.capabilities/limits/pricing` 已是好结构，缺的是「**按任务绑定协议**」——同一实例的图与视频目前靠 `IMAGE_ADAPTERS`/`VIDEO_ADAPTERS` 两张表按**实例协议**分发，无法表达「同一实例内某模型走 `ark.images` 协议」。若出现「同网关图像/视频协议不同」，需按任务解析协议。
2. **`config_revision` 式老化治理**（nomifun）：异步视频任务（job + 轮询兜底）在用户修改实例能力声明后，**不应跨修订复用已持久化的句柄与缓存**。当前契约无此信号，属于「改声明 → 老任务引用旧协议」的隐藏风险；提案给实例加单调递增的配置修订号，job 落盘时记录、执行时比对不一致即拒。
3. **媒体降级占位**（kimi `degrade.ts`；dsh `IMAGE_OFFLOAD_REQUIRED`）：视频/图像作为**输入**进上下文时（首尾帧、参考图），必须有「超限丢最旧 + 保留最近 N + 占位文本写明如何重新读取」的策略，且不得改写历史。我们目前是 `inputImages?: string[]` 直传，没有预算与降级。
4. **`video_input` / `inlineVideo` 两级声明**（kimi）：视觉输入不止图像，视频输入也需被声明；`ProviderMediaContribution` 的「provider 级默认 + 模型级覆盖」值得借。
5. **产物取回与生成分离**（jaaz）：视频产物普遍「先拿 URL/句柄、再取回」，显式建模可简化重试与幂等（与仓库「持久副作用与幂等性」硬约束对齐）。

### 5.4 目录与治理（跨横切）

1. **「固有元数据 / 连接配置 / M:N 例外」三层分离**（cherry 三个生成物）：我们的对应物是「模型固有能力（随契约发布）」与「用户实例覆盖（随工作区持久化）」，现状混在实例 `models[]` 一层。分离后 `modelCatalog` 只需合并两层，用户覆盖不必重复声明固有字段。
2. **「推测 ≠ 授权」**（nomifun）：若将来做模型名推断（如自动猜 `vision`），推断只能填默认值，**不得成为调用授权**；BYOK 红线要求用户声明才是授权。
3. **稳定 id 形态**（cherry `UniqueModelId = providerId::modelId`）：我们已有 `<instanceId>:<modelId>` specifier，但解析靠 UUID 正则（`parseInstanceSpecifier`）。cherry 把它做成 schema + 解析函数，两端共用；提案把该 specifier 提为共享契约的具名类型，避免两端各自解析。
4. **`isDeprecated` / `replaceWith`**（cherry 模型行）：模型下线是常态（nomifun 里 sora 因 API 关停被移除）。我们的目录无「已弃用 / 替代模型」语义，用户会被上游关停反复踩坑；提案加两个可选字段，前端只提示、不自动改写用户选择。
5. **生成物 + 禁手改门禁**（cherry CI 路径耦合）：仅在将来出现「随包发布的预设目录」时才需要；当前 BYOK 目录是运行时数据，**不引入生成器**（见 §6）。
---

## 6. 取舍（Alternatives considered）

**不引入 cherry-studio 的代码生成流水线（手写源 → 三个 JSON → CI 禁手改）。** 该流水线解决的是「随包发布几十家厂商、数百个模型的预设目录，且随版本漂移」。我们的目录是**用户 BYOK 运行时声明**，规模与生命周期都不同；引入生成器会把「用户数据」与「发布物」混淆，并新增一条 CI 门禁。**借形状、不引流水线**：三层分离（固有元数据 / 连接配置 / 例外）与「参数键单一来源 + 穷尽校验」可借，生成器与路径耦合门禁不必借。

**不把 AI SDK 作为新底座（cherry 把图像生成做成 `ImageModelV3` 插进同一条链）。** 我们已是 LangChain（聊天）+ 自研 `ImageProvider`/`VideoProvider`（生成）的双底座，换底座是重写而非学习；且现有 `ImageProvider` 形状健康（`generate(params) → GeneratedImage`）。只借「模型参数化、传输注入」这一点到现有接口内。

**不做 models.dev 在线拉取（kimi-code 的做法）。** 桌面内嵌服务端与自托管形态下，引入外部目录源带来网络依赖、隐私面与版本漂移；BYOK 实例目录不需要它。若将来做「模型发现」，应设计为**可选建议源**（离线快照优先），且不得成为唯一真相。

**不照搬名字推断作为授权依据（nomifun）。** 其源码自身已写明「推断只做建议、持久化行才是权威」；抄推断逻辑而丢掉这句话会破坏 BYOK 红线。

**不引 futureFlow 式单上游代持 Key。** 那是浏览器 CORS 场景的代理，与 BYOK 语义相反；仅保留「代理只转发到配置的单一上游」的收敛原则。

**不把 cherry-studio 当 VGM 参照。** 其视频能力只有词表没有实现；VGM 的 provider 参照应取 `nomifun-tauri`（任务级协议行 + 三端点列）与 `jaaz`（`VideoProviderBase`），内容层参照取 `seedance-2.0-skill`。

---

## 7. 遗留与未做

- **未做**：任何契约与代码改动。本文只产出调研结论；落地需在《日志》台账按 PR 记账，并遵守「每个 PR 行为不变、测试护航」。
- **未做**：cherry-studio v1（`src/renderer/src/providers/AiProvider/*`）的历史实现对比——v2 已重构到 `src/main/ai/provider/*`，历史形态对当前设计无增量信息。
- **未覆盖**：`references/` 中与模型 Provider 无关的子模块（MCP、skill、浏览器、UI 组件库）。
- **明确的风险**：`references/` 项目均为**浅克隆**（仅 1 个提交），上述结构与路径引用绑定 §8 所列 commit；上游演进后需按 `references/submodule-maintain.sh update` 重新核对再引用。

---

## 8. 证据与版本

| 项目 | 本文中的角色 | commit | 许可 | 主要证据路径 |
| --- | --- | --- | --- | --- |
| cherry-studio | IGM 最完整参照 | `d6cf4b7` | AGPL-3.0 | `packages/provider-registry/{docs/architecture.md,src/schemas/enums.ts,src/schemas/model.ts,src/schemas/imageParamCatalog.ts,src/providers/types.ts,src/creators/_api.ts}`、`src/main/ai/provider/custom/{imageGenerationModel.ts,imageTransportRegistry.ts,wire/wireProfile.ts,wire/buildImageRequest.ts,minimax/minimaxImageModel.ts}`、`packages/aiCore/src/core/providers/` |
| kimi-code | LLM 能力 + 媒体降级参照 | `bd06178` | MIT | `packages/agent-core-v2/src/human/llm/{capability.ts,provider-catalog.ts,provider/definition.ts,provider/providers/standard.ts,media/degrade.ts}`、`docs/zh/configuration/providers.md` |
| nomifun-tauri | 能力持久化 + 任务/协议参照 | 随子模块浅克隆 | 见仓库 | `crates/backend/nomifun-api-types/src/{model_task.rs,model_capability.rs}`、`crates/backend/nomifun-db/migrations/{032_provider_model_capabilities.sql,051_ark_image_edit_capabilities.sql}`、`crates/agent/nomi-providers/src/` |
| deepseek-harness | provider-neutral + 图像预算参照 | 随子模块浅克隆 | MIT | `packages/llm/llm/README.md`、`packages/llm/llm-pi-ai/{README.md,src/context.ts}` |
| jaaz | 自动注册 + VGM 基类参照 | 随子模块浅克隆 | 见仓库 | `server/tools/{image_providers/image_base_provider.py,video_providers/video_base_provider.py,video_generation/video_generation_core.py}` |
| jellyfish | ProviderSpec 参照 | 随子模块浅克隆 | 见仓库 | `backend/app/services/llm/{provider_registry.py,provider_bootstrap.py,provider_resolver.py,runtime.py}` |
| futureFlow | 反面参照 | `eba16d8`（根级 `flow/` 子模块，完整克隆） | 见仓库 | `gateway/src/llm/llm-proxy.controller.ts` |
| loomic | 本项目前身快照 | 随子模块浅克隆 | 见仓库 | `apps/server/src/generation/providers/` |
| seedance-2.0-skill | VGM 内容层参照 | 随子模块浅克隆 | 见仓库 | `references/{storytelling-framework.md,continuity-qc.md,first-last-frame-guide.md}` |

本次新增的两个子模块（`references/cherry-studio`、`references/kimi-code`）均为**浅克隆**（`.gitmodules` 中 `shallow = true`，URL 为规范 https），由 `references/submodule-maintain.sh` 统一维护：`check` 验证状态、`convert` 转浅、`update` 拉取到远端最新。
