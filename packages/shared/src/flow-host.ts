import { z } from "zod";

/**
 * flow 宿主适配层契约（`ff-embed/v1`）。
 *
 * 定位：flow 子系统（`flow/` 子模块）被主仓当**外壳**嵌进来时，走的是宿主适配层六缝
 * ——本地身份适配 / 凭证 / 事件 / 主题 / 导航。本文件只定义**宿主侧**（本仓）对 flow 网关
 * 暴露的回调形状；flow 网关里的同名 DTO 是另一份实现（跨仓库不共享代码），两边靠本文件
 * 与 `flow/docs/ff-embed-v1.md` 对齐。
 *
 * 方向约定：
 * - 本地身份适配（DEC-20 免账户模型）：宿主前端凭本机接入换**短时身份票据**，
 *   经 `ff-embed/identity` 交给 flow 前端；flow 网关带票据回宿主验签，拿回稳定
 *   `subject`（= 本实例 instanceId）。宿主接入凭据本身不出宿主进程。
 * - 凭证 / 事件：同为 flow 网关 → 宿主（P3/P4/P5 逐个接上，形状同样落在这里）。
 *
 * 鉴权约定：调用方（flow 网关）用**共享密钥**做 bearer（`KENFUTWORK_FLOW_EMBED_SECRET`
 * ↔ flow 侧 `HOST_SHARED_SECRET`）；事件的 hostSubject 必须是该宿主稳定 instanceId。
 */
export const FLOW_EMBED_PROTOCOL_VERSION = "v1";

/**
 * flow 插件（`plugins/flow`，FORM-11 产品入口）的 bundle 名。
 * 工作台以「该插件已安装」+「宿主适配层已配齐」共同门控 Flow 模式入口；
 * 名字两端（市场清单 / 前端门控）只有这一处权威。
 */
export const FLOW_PLUGIN_BUNDLE_NAME = "kenfutwork-flow";

/**
 * flow 宿主能力探针（`GET /api/flow/host/status`，宿主自己的前端调用，本机接入验证）。
 *
 * 工作台据此决定 Flow 模式入口是否出现（入口纪律：未安装插件或适配层未接通时不摆空壳）。
 * 本期身份缝已按本地实例（DEC-20）接通：共享密钥 + 前端地址配齐即 `enabled: true`；
 * 缺项写进 `reasons`，界面把原因如实透出（fail loud，不放无提示的假开关）。
 */
export const flowHostStatusResponseSchema = z.object({
  enabled: z.boolean(),
  /** flow 前端地址（`KENFUTWORK_FLOW_FRONTEND_URL`）；未配置为 null。 */
  frontendUrl: z.string().nullable(),
  /** 未启用时缺什么（每条一句可读原因）；启用后为空数组。 */
  reasons: z.array(z.string()),
});
export type FlowHostStatusResponse = z.infer<
  typeof flowHostStatusResponseSchema
>;

/**
 * 宿主身份票据（本地实例身份适配）：宿主前端调用 `POST /api/flow/host/identity-ticket`
 * （本机接入验证）换取一次性的短时票据，经 `ff-embed/identity` 交给 flow 前端；
 * flow 网关再回传给宿主验签（见下）。
 *
 * 一次性 + 短 TTL（沿用本机接入票据的治理值 `localAccessTicketTtlMs`）：消费即失效，
 * 重放无效；服务重启票据作废（iframe 重载会重新握手、重新签发）。
 */
export const flowHostIdentityTicketResponseSchema = z.object({
  token: z.string().min(1).max(2048),
  expiresAt: z.string().min(1).max(64),
});
export type FlowHostIdentityTicketResponse = z.infer<
  typeof flowHostIdentityTicketResponseSchema
>;

/**
 * 身份验签（`POST /api/flow/host/identity`，flow 网关 → 宿主，共享密钥门）。
 * 请求形状与 flow 侧 `EmbeddedIdentityProvider` 对齐（token ≤ 8KB 后拒绝）。
 */
export const flowHostIdentityRequestSchema = z.object({
  token: z.string().min(1).max(8192),
  protocolVersion: z.string().min(1).max(16).optional(),
});

/**
 * 身份验签响应（与 flow 侧 `HostIdentityPayload` 对齐）：`subject` 是稳定外部标识，
 * flow 侧按它 get-or-create 账户；本地实例模型下 subject = 实例 instanceId。
 */
export const flowHostIdentityResponseSchema = z.object({
  subject: z.string().min(1).max(256),
  displayName: z.string().min(1).max(128).optional(),
});
export type FlowHostIdentityResponse = z.infer<
  typeof flowHostIdentityResponseSchema
>;

/**
 * 凭证下发（P3，`POST /api/flow/host/credentials`）：请求体只有协议版本——
 * **这条缝是部署级的**（flow 网关一个引擎配置供该本地实例），与 flow 侧
 * `EmbeddedCredentialsProvider` 的实际调用形状一致；凭证来源是本地实例供应商列表里启用的 `protocol='dify-engine'` 实例。
 * 门禁只有共享密钥（机器对机器、无用户数据参与；会话令牌是交互式身份交换才需要的）。
 */
export const flowHostCredentialsRequestSchema = z.object({
  protocolVersion: z.string().min(1).max(16).optional(),
});

/**
 * 凭证下发响应：本地 dify-engine 实例的引擎地址与 Key。
 * 形状与 flow 侧 `HostCredentialsPayload`（class-validator）对齐：apiBase 必须 http(s)、
 * apiKey ≤512、label ≤64。
 *
 * **红线说明**：响应含明文 apiKey 是这条缝的**目的**（把 BYOK 引擎凭证下发给持有共享
 * 密钥的 flow 网关，服务端到服务端）——浏览器永远拿不到它；日志同样不落明文。
 */
export const flowHostCredentialsResponseSchema = z.object({
  apiBase: z.string().url(),
  apiKey: z.string().min(1).max(512),
  label: z.string().max(64).optional(),
});
export type FlowHostCredentialsRequest = z.infer<
  typeof flowHostCredentialsRequestSchema
>;
export type FlowHostCredentialsResponse = z.infer<
  typeof flowHostCredentialsResponseSchema
>;

/**
 * 事件透出（P5，`POST /api/flow/host/events`）：flow 网关按批推 run 事件，宿主
 * 原样转发到本仓 WS 通道（`flowRun.event`）。
 *
 * 形状与 flow 侧 `EmbeddedEventSink` 对齐：批 ≤25 条 / 250ms 攒批，`events[].seq` 是
 * **run 内**单调序号。每条事件带 `hostSubject`（与计费同一口径：宿主按它解析归属，
 * 把事件投给对应用户的 WS 连接）——批次可能跨 run/跨用户，故归属键在**每条**事件上。
 */
export const flowHostEventsRequestSchema = z.object({
  protocolVersion: z.string().min(1).max(16).optional(),
  events: z
    .array(
      z.object({
        runId: z.string().min(1).max(128),
        seq: z.number().int().min(1),
        /** flow 侧原事件类型名（宿主不解释，只透传）。 */
        type: z.string().min(1).max(128),
        payload: z.unknown(),
        at: z.string().min(1).max(64),
        hostSubject: z.string().min(1).max(256),
      }),
    )
    .min(1)
    .max(200),
});
export type FlowHostEventsRequest = z.infer<typeof flowHostEventsRequestSchema>;

/** 事件透出的响应：投递计数（宿主只做透传，不识别的归属逐条计入 skipped，不整批失败）。 */
export const flowHostEventsResponseSchema = z.object({
  accepted: z.number().int().min(0),
  skipped: z.number().int().min(0),
});
export type FlowHostEventsResponse = z.infer<
  typeof flowHostEventsResponseSchema
>;

/**
 * 引擎承载路径探测（P6 探测层，`GET /api/flow/host/engine`，宿主自己的前端调用）。
 *
 * 三条路径（《flow 集成方案》§3.5.1 的平台矩阵）：
 * - `wsl2`：Windows 专属，轻量 VM 内跑开源容器引擎（无 Docker Desktop 授权约束）；
 * - `container`：本机已有的 Docker / Podman（macOS 上 Colima 等 Docker 兼容运行时也走这条）；
 * - `remote`：不本地承载，引擎指向本地供应商设置里的 Dify 地址（Provider C 兜底）。
 *
 * `recommended` 按平台矩阵给出首选；都不可用时为 null（界面据此引导安装或去配 Provider C）。
 * `reason` 是**可读原因 + 怎么补**（不放无提示的不可用），`detail` 是可用时的补充事实。
 *
 * 边界（如实声明）：本层只做**探测**；引擎的按需下载与生命周期托管（provision/start/
 * stop/teardown）依赖方案 §9.1 待拍板的三个口径（WSL 分发形态 / 内存上限 / 数据卷落点），
 * 尚未实现——探测层不假装能做，界面也不得据此显示「可启动」。
 */
export const flowEnginePathIdSchema = z.enum(["wsl2", "container", "remote"]);
export type FlowEnginePathId = z.infer<typeof flowEnginePathIdSchema>;

export const flowEnginePathSchema = z.object({
  id: flowEnginePathIdSchema,
  /** 界面用中文名（如「WSL2」「本机容器」「指向自管地址」）。 */
  label: z.string().min(1),
  available: z.boolean(),
  /** 不可用/降级时的可读原因（缺什么、怎么补）。 */
  reason: z.string().optional(),
  /** 可用时的补充事实（版本、发行版名、地址来源）。 */
  detail: z.string().optional(),
});
export type FlowEnginePath = z.infer<typeof flowEnginePathSchema>;

export const flowHostEngineResponseSchema = z.object({
  /** `process.platform`（界面按平台提示不同安装指引）。 */
  platform: z.string().min(1),
  paths: z.array(flowEnginePathSchema),
  recommended: flowEnginePathIdSchema.nullable(),
});
export type FlowHostEngineResponse = z.infer<
  typeof flowHostEngineResponseSchema
>;

/**
 * 引擎栈安装状态（FORM-11 探测后的「确认 → 下载 → 托管」）。
 *
 * `installing` = 拉镜像/起栈进行中（长任务，轮询本端点）；`ready` = 栈已起且健康；
 * `error` = 失败（logTail 给出可读原因）；`idle` = 尚未发起。重启服务后状态归零，
 * 由调用方按 `docker compose ps` 重新探测（后续增量）。
 */
export const flowEngineInstallStatusSchema = z.object({
  state: z.enum(["idle", "installing", "ready", "error"]),
  logTail: z.array(z.string()),
  error: z.string().optional(),
  startedAt: z.string().optional(),
});
export type FlowEngineInstallStatus = z.infer<
  typeof flowEngineInstallStatusSchema
>;

/**
 * 引擎栈停止/卸载（FORM-11 生命周期，`POST /api/flow/host/engine/stop`）。
 *
 * `deleteData` 缺省 false = 只 `down` 保容器卷数据（下次起栈沿用）；
 * `true` = 追加 `--volumes` 全删（§9.1③ 的卸载策略：**显式选择全删才动数据**）。
 */
export const flowHostEngineStopRequestSchema = z.object({
  deleteData: z.boolean().optional(),
});
export type FlowHostEngineStopRequest = z.infer<
  typeof flowHostEngineStopRequestSchema
>;

/**
 * 引擎栈容器（`docker compose ps --format json` 的**运行期事实**，不猜配置文件）。
 * `ports` 是 docker 报告原文（如 `127.0.0.1:15001->5001/tcp`），查询失败时容器清单为空
 * 且 `error` 说明原因（docker 不可用等）。
 */
export const flowEngineStackContainerSchema = z.object({
  service: z.string().min(1),
  name: z.string().min(1),
  state: z.string().min(1),
  health: z.string().nullable(),
  ports: z.array(z.string()),
});
export type FlowEngineStackContainer = z.infer<
  typeof flowEngineStackContainerSchema
>;

/**
 * 引擎信息页（`GET /api/flow/host/engine/info`）：工作台「引擎」页一次取全 ——
 * 托管状态（install）+ 承载路径探测（probe）+ 栈容器事实（stack）+ 地址/路径（addresses）。
 * 不编不确定的信息：地址只列宿主真正知道的（flow 前端地址、宿主身份回调、compose 与数据目录）。
 */
export const flowHostEngineInfoResponseSchema = z.object({
  install: flowEngineInstallStatusSchema,
  probe: flowHostEngineResponseSchema,
  stack: z.object({
    containers: z.array(flowEngineStackContainerSchema),
    error: z.string().optional(),
  }),
  addresses: z.object({
    /** flow 画布（前端）地址；未配置为 null。 */
    frontendUrl: z.string().nullable(),
    /** 宿主身份交换回调（flow 侧 HOST_IDENTITY_VERIFY_URL 应指向它）。 */
    hostIdentityUrl: z.string().min(1),
    /** 引擎栈 compose 文件路径。 */
    composeFile: z.string().min(1),
    /** 安装数据目录（自动生成的密钥 env 与安装日志都在这里）。 */
    dataDir: z.string().min(1),
  }),
});
export type FlowHostEngineInfoResponse = z.infer<
  typeof flowHostEngineInfoResponseSchema
>;
