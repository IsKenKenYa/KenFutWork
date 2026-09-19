import { z } from "zod";

/**
 * models.dev 能力快照（docs/future/05 §4/§11）：上游 api.json → 白名单裁剪 →
 * camelCase 投影 → zod 校验。快照是**非权威 UI 提示**——用户实例声明优先，
 * 不进协议层；字段缺省 = 未知，不是不支持（与 provider-contracts 的语义红线同源）。
 */

/** 单模型裁剪条目：models.dev 的 snake_case 投影为本仓 camelCase，只留核心字段。 */
export const modelsDevModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  toolCall: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  temperature: z.boolean().optional(),
  releaseDate: z.string().optional(),
  openWeights: z.boolean().optional(),
  modalities: z
    .object({
      input: z.array(z.string()).optional(),
      output: z.array(z.string()).optional(),
    })
    .optional(),
  limit: z
    .object({
      context: z.number().optional(),
      output: z.number().optional(),
    })
    .optional(),
  cost: z.record(z.string(), z.number()).optional(),
});
export type ModelsDevModel = z.infer<typeof modelsDevModelSchema>;

export const modelsDevProviderSchema = z.object({
  name: z.string().optional(),
  /** 官方 API 网关（预设选择时预填 Base URL；openai 等缺省网关可能缺席）。 */
  api: z.string().optional(),
  /** 文档链接（预设选择器展示）。 */
  doc: z.string().optional(),
  /** Key 的环境变量名（展示用，BYOK 仍手填 Key）。 */
  env: z.array(z.string()).optional(),
  models: z.record(z.string(), modelsDevModelSchema),
});
export type ModelsDevProvider = z.infer<typeof modelsDevProviderSchema>;

export const modelsDevSnapshotSchema = z.record(
  z.string(),
  modelsDevProviderSchema,
);
export type ModelsDevSnapshot = z.infer<typeof modelsDevSnapshotSchema>;

/**
 * 白名单：只保留本仓协议与 BYOK 常用相关的 provider（实测 models.dev 全部存在；
 * 白名单里多列几个无害——上游缺席即跳过）。裁剪目标 < 500KB（原始 4.7MB）。
 */
export const modelsDevProviderWhitelist = [
  // 御三家 + 常用国际
  "openai",
  "anthropic",
  "google",
  "xai",
  "mistral",
  "groq",
  "cohere",
  "perplexity",
  "openrouter",
  "together",
  "fireworks",
  "deepinfra",
  // 国产（含中转 / 订阅计划变体）
  "deepseek",
  "moonshotai",
  "moonshotai-cn",
  "kimi-for-coding",
  "zhipuai",
  "zhipuai-coding-plan",
  "zai",
  "zai-coding-plan",
  "siliconflow",
  "siliconflow-cn",
  "minimax",
  "minimax-cn",
  "minimax-coding-plan",
  "minimax-cn-coding-plan",
  "volcengine",
  "volcengine-coding-plan",
  "stepfun",
  "stepfun-ai",
  "stepfun-step-plan",
  "stepfun-ai-step-plan",
] as const;

/** 布尔字段投影表：[models.dev 原始键, 快照键]。 */
const BOOLEAN_MODEL_FIELDS = [
  ["attachment", "attachment"],
  ["reasoning", "reasoning"],
  ["tool_call", "toolCall"],
  ["structured_output", "structuredOutput"],
  ["temperature", "temperature"],
  ["open_weights", "openWeights"],
] as const;

function trimModel(id: string, raw: unknown): ModelsDevModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const model: ModelsDevModel = {
    id,
    name: typeof source.name === "string" && source.name ? source.name : id,
  };
  for (const [from, to] of BOOLEAN_MODEL_FIELDS) {
    if (typeof source[from] === "boolean") {
      model[to] = source[from] as boolean;
    }
  }
  if (typeof source.release_date === "string") {
    model.releaseDate = source.release_date;
  }
  if (typeof source.modalities === "object" && source.modalities !== null) {
    const modalities = source.modalities as Record<string, unknown>;
    const input = Array.isArray(modalities.input)
      ? modalities.input.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined;
    const output = Array.isArray(modalities.output)
      ? modalities.output.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined;
    if (input?.length || output?.length) {
      model.modalities = {
        ...(input?.length ? { input } : {}),
        ...(output?.length ? { output } : {}),
      };
    }
  }
  if (typeof source.limit === "object" && source.limit !== null) {
    const limit = source.limit as Record<string, unknown>;
    const context =
      typeof limit.context === "number" ? limit.context : undefined;
    const output = typeof limit.output === "number" ? limit.output : undefined;
    if (context !== undefined || output !== undefined) {
      model.limit = {
        ...(context !== undefined ? { context } : {}),
        ...(output !== undefined ? { output } : {}),
      };
    }
  }
  if (typeof source.cost === "object" && source.cost !== null) {
    const cost: Record<string, number> = {};
    for (const [key, value] of Object.entries(
      source.cost as Record<string, unknown>,
    )) {
      if (typeof value === "number") {
        cost[key] = value;
      }
    }
    if (Object.keys(cost).length > 0) {
      model.cost = cost;
    }
  }
  return model;
}

export interface SnapshotStats {
  providersKept: number;
  /** 原始数据里被白名单排除的 provider 数。 */
  providersDropped: number;
  modelsKept: number;
  /** 裁剪产物 JSON 的 UTF-8 字节数（写盘体积的准确预估值）。 */
  bytes: number;
}

/**
 * 白名单裁剪 + 字段投影 + 改名，产物先过自身 zod 校验（写盘前自检）。
 * 任何非对象条目（模型级 / provider 级）一律跳过而非抛错——上游脏数据
 * 不该让整份快照刷不出来；结构性错误（根非对象）才 fail loud。
 */
export function buildModelsDevSnapshot(
  raw: unknown,
  whitelist: readonly string[] = modelsDevProviderWhitelist,
): { snapshot: ModelsDevSnapshot; stats: SnapshotStats } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("models.dev 数据根必须是 JSON 对象");
  }
  const source = raw as Record<string, unknown>;
  const snapshot: ModelsDevSnapshot = {};
  let modelsKept = 0;
  for (const key of whitelist) {
    const entry = source[key];
    if (typeof entry !== "object" || entry === null) continue;
    const modelsRaw = (entry as Record<string, unknown>).models;
    if (typeof modelsRaw !== "object" || modelsRaw === null) continue;
    const models: Record<string, ModelsDevModel> = {};
    for (const [modelId, modelRaw] of Object.entries(
      modelsRaw as Record<string, unknown>,
    )) {
      const trimmed = trimModel(modelId, modelRaw);
      if (trimmed) {
        models[modelId] = trimmed;
        modelsKept += 1;
      }
    }
    const name = (entry as Record<string, unknown>).name;
    const api = (entry as Record<string, unknown>).api;
    const doc = (entry as Record<string, unknown>).doc;
    const env = (entry as Record<string, unknown>).env;
    snapshot[key] = {
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof api === "string" && api ? { api } : {}),
      ...(typeof doc === "string" && doc ? { doc } : {}),
      ...(Array.isArray(env)
        ? { env: env.filter((e): e is string => typeof e === "string") }
        : {}),
      models,
    };
  }
  const providersKept = Object.keys(snapshot).length;
  const providersDropped = Object.keys(source).length - providersKept;
  const stats: SnapshotStats = {
    providersKept,
    providersDropped,
    modelsKept,
    bytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
  };
  // 写盘前自检：裁剪产物必须能通过自身契约（结构性回归立刻炸在刷新时刻）。
  modelsDevSnapshotSchema.parse(snapshot);
  return { snapshot, stats };
}

/** 快照里命中一个模型 id 的查找结果（provider 键 + 模型条目）。 */
export interface ModelsDevModelHit {
  provider: string;
  model: ModelsDevModel;
}

/**
 * 按模型 id 在快照里查找（BYOK 实例没有 models.dev 的 provider 键，只能按 id 匹配）。
 * 同一 id 出现在多个 provider 时：preferredProvider 命中优先（如 anthropic 协议实例
 * 偏好 anthropic 快照），否则按快照键序（= 生成时的白名单序）取第一个——查找确定性
 * 由键序保证。快照是 hints 而非权威，匹配歧义的代价可接受；出处随结果透出。
 */
export function findModelsDevModel(
  snapshot: ModelsDevSnapshot,
  modelId: string,
  preferredProvider?: string,
): ModelsDevModelHit | undefined {
  let first: ModelsDevModelHit | undefined;
  for (const [provider, entry] of Object.entries(snapshot)) {
    const model = entry.models[modelId];
    if (!model) continue;
    if (preferredProvider && provider === preferredProvider) {
      return { provider, model };
    }
    first ??= { provider, model };
  }
  return first;
}

/** 预设条目（供应商设置「从预设选择」用，阶段：BYOK 预设选择器）。 */
export interface ProviderPresetModel {
  id: string;
  name: string;
  capability: "chat" | "image" | "video";
}

export interface ProviderPreset {
  id: string;
  name: string;
  /** 官方 API 网关（预填 Base URL；缺席 = 用户手填）。 */
  api?: string;
  /** 文档链接。 */
  doc?: string;
  /** Key 环境变量名（展示，BYOK 仍手填 Key）。 */
  env: string[];
  models: ProviderPresetModel[];
}

/** 模型模态 → 任务 capability（output 决定；image-edit 留给用户在行编辑器调）。 */
function deriveCapability(
  model: ModelsDevModel,
): ProviderPresetModel["capability"] {
  const output = model.modalities?.output ?? [];
  if (output.includes("image")) return "image";
  if (output.includes("video")) return "video";
  return "chat";
}

/** 快照 → 供应商预设清单（非权威 UI 数据；BYOK 用户仍可完全手填）。 */
export function listProviderPresets(
  snapshot: ModelsDevSnapshot,
): ProviderPreset[] {
  const presets: ProviderPreset[] = [];
  for (const [id, entry] of Object.entries(snapshot)) {
    const models = Object.values(entry.models)
      .map((model) => ({
        id: model.id,
        name: model.name,
        capability: deriveCapability(model),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    presets.push({
      id,
      name: entry.name ?? id,
      ...(entry.api ? { api: entry.api } : {}),
      ...(entry.doc ? { doc: entry.doc } : {}),
      env: entry.env ?? [],
      models,
    });
  }
  return presets.sort((a, b) => a.name.localeCompare(b.name));
}

/** 校验快照工件（生成物或外部数据）；结构损坏返回 undefined（fail-open，快照非权威）。 */
export function parseSnapshotArtifact(
  raw: unknown,
): ModelsDevSnapshot | undefined {
  const parsed = modelsDevSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** 生成 .ts 数据模块文本（刷新脚本写盘用；被 import 前提是文本可被 JSON.parse 还原）。 */
export function renderSnapshotModule(snapshot: ModelsDevSnapshot): string {
  const header =
    "// 由 scripts/刷新模型能力快照.ts 生成（勿手改）。数据源 models.dev api.json（MIT），\n" +
    "// 白名单裁剪 + 字段投影见 ./models-dev-snapshot.ts；定位是非权威 UI 提示（docs/future/05 §4）。\n";
  return `${header}export const MODELS_DEV_SNAPSHOT = ${JSON.stringify(snapshot, null, 2)};\n`;
}
