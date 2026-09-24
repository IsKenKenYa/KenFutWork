import { z } from "zod";

/**
 * flow 宿主适配层契约（`ff-embed/v1`）。
 *
 * 定位：flow 子系统（`flow/` 子模块）被主仓当**外壳**嵌进来时，走的是宿主适配层六缝
 * ——身份 / 凭证 / 计费 / 事件 / 主题 / 导航。本文件只定义**宿主侧**（本仓）对 flow 网关
 * 暴露的回调形状；flow 网关里的同名 DTO 是另一份实现（跨仓库不共享代码），两边靠本文件
 * 与 `flow/docs/ff-embed-v1.md` 对齐。
 *
 * 方向约定：
 * - 身份：flow 网关 → 宿主（本文件的 `POST /api/flow/host/identity`）；
 * - 凭证 / 计费 / 事件：同为 flow 网关 → 宿主（P3/P4/P5 逐个接上，形状同样落在这里）。
 *
 * 鉴权约定：调用方（flow 网关）用**共享密钥**做 bearer（`KENFUTWORK_FLOW_EMBED_SECRET`
 * ↔ flow 侧 `HOST_SHARED_SECRET`），请求体里的宿主令牌再被当作宿主会话验一次——两道门
 * 缺一不可，任一不过都如实拒绝。
 */
export const FLOW_EMBED_PROTOCOL_VERSION = "v1";

/**
 * flow 插件（`plugins/flow`，FORM-11 产品入口）的 bundle 名。
 * 工作台以「该插件已安装」+「宿主适配层已配齐」共同门控 Flow 模式入口；
 * 名字两端（市场清单 / 前端门控）只有这一处权威。
 */
export const FLOW_PLUGIN_BUNDLE_NAME = "kenfutwork-flow";

/**
 * 身份交换请求：`token` 是宿主会话令牌（浏览器里那份），由 flow 网关原样转交。
 * 长度上限是防线也是实测（超长串没有验签价值，只用来烧 CPU）。
 */
export const flowHostIdentityRequestSchema = z.object({
  token: z.string().min(1).max(8192),
  protocolVersion: z.string().min(1).max(16).optional(),
});

export const flowHostIdentityResponseSchema = z.object({
  /** 宿主侧的稳定主体标识（本仓取用户 id）：flow 按它 get-or-create 自己的用户。 */
  subject: z.string().min(1).max(256),
  displayName: z.string().max(128).optional(),
  email: z.string().max(320).optional(),
});

export type FlowHostIdentityRequest = z.infer<
  typeof flowHostIdentityRequestSchema
>;
export type FlowHostIdentityResponse = z.infer<
  typeof flowHostIdentityResponseSchema
>;

/**
 * flow 宿主能力探针（`GET /api/flow/host/status`，宿主自己的前端调用，会话鉴权）。
 *
 * 工作台据此决定 Flow 模式入口是否出现（入口纪律：未安装插件或适配层未接通时不摆空壳）。
 * `enabled` 要求共享密钥与 flow 前端地址**都**配好；缺什么、原因写进 `reasons`，
 * 界面把原因如实透出（fail loud，不放无提示的假开关）。
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
 * 凭证下发（P3，`POST /api/flow/host/credentials`）：请求体只有协议版本——
 * **这条缝是部署级的**（flow 网关一个引擎配置供全体用户），与 flow 侧
 * `EmbeddedCredentialsProvider` 的实际调用形状一致；凭证来源是平台池
 * （`scope='system'`）里启用的 `protocol='dify-engine'` 实例。
 * 门禁只有共享密钥（机器对机器、无用户数据参与；会话令牌是交互式身份交换才需要的）。
 */
export const flowHostCredentialsRequestSchema = z.object({
  protocolVersion: z.string().min(1).max(16).optional(),
});

/**
 * 凭证下发响应：平台池 dify-engine 实例的引擎地址与 Key。
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
 * 计费三段事务（P4，`POST /api/flow/host/billing`）。
 *
 * 请求是 op 判别联合，形状与 flow 侧 `EmbeddedBillingProvider` 逐参对齐（多一个
 * `hostSubject`）：`hostSubject` 是**宿主侧稳定用户标识**（身份缝交换时宿主自己下发的），
 * flow 网关从 `users.hostSubject` 取出后随请求带上——机器对机器的回调发生在 run 的生命
 * 周期里（可能晚于身份交换很久），短命会话令牌不可用，稳定 subject 才是可用的归属键。
 *
 * 幂等：宿主按 `flow:<runId>:<op>` 去重（flow 侧同时以 `x-idempotency-key` 头下发）。
 * 金额口径：宿主按自己的 credits 单位解释 amount/actualCost（取整），
 * **冻结额是本次 run 的消费上限**（结算超出部分在 `uncoveredAmount` 里如实回报）。
 */
const flowBillingBase = {
  protocolVersion: z.string().min(1).max(16).optional(),
  runId: z.string().min(1).max(128),
  hostSubject: z.string().min(1).max(256),
};

export const flowHostBillingRequestSchema = z.discriminatedUnion("op", [
  z.object({
    ...flowBillingBase,
    op: z.literal("reserve"),
    /** 预扣金额（宿主 credits 单位；向上取整，不低估占用）。 */
    amount: z.number().finite().min(0),
  }),
  z.object({
    ...flowBillingBase,
    op: z.literal("settle"),
    /** flow 侧账目参考的冻结额（宿主以自己 hold 里的金额为准，不采信此值）。 */
    frozenAmount: z.number().finite().min(0),
    actualCost: z.number().finite().min(0),
    /** 用量明细（宿主折算自己计费单位用；缺省为空对象）。 */
    usage: z.record(z.string(), z.unknown()).optional(),
    remark: z.string().max(512).optional(),
  }),
  z.object({
    ...flowBillingBase,
    op: z.literal("refund"),
    /** flow 侧账目参考的冻结额（宿主以自己 hold 里的金额为准）。 */
    amount: z.number().finite().min(0),
  }),
]);
export type FlowHostBillingRequest = z.infer<
  typeof flowHostBillingRequestSchema
>;

/**
 * 计费响应：每段都带 `replayed`（同键重放为 true，宿主未重复动账）与
 * 实际生效金额；结算的 `uncoveredAmount` = 超出冻结上限、未扣的部分（如实回报，不静默）。
 */
export const flowHostBillingResponseSchema = z.object({
  op: z.enum(["reserve", "settle", "refund"]),
  replayed: z.boolean(),
  /** 冻结/释放金额（reserve / refund）。 */
  amount: z.number().int().min(0).optional(),
  /** 实扣金额（settle）。 */
  settledAmount: z.number().int().min(0).optional(),
  /** 超出冻结上限未扣的部分（settle；0 表示全额结算）。 */
  uncoveredAmount: z.number().int().min(0).optional(),
});
export type FlowHostBillingResponse = z.infer<
  typeof flowHostBillingResponseSchema
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
 * - `remote`：不本地承载，引擎指向平台池里配置的 Dify 地址（Provider C 兜底）。
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
