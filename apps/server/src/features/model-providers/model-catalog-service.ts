import type {
  ModelCapability,
  ModelCatalogEntry,
  ModelCatalogHints,
  ProviderInstanceModel,
  ProviderInstanceResponse,
  ProviderProtocol,
} from "@kenfutwork/shared";

import type { AuthenticatedUser } from "../auth/types.js";
import type { ModelProviderService } from "./model-provider-service.js";
import {
  findModelsDevModel,
  type ModelsDevSnapshot,
} from "./models-dev-snapshot.js";

/**
 * modelCatalog 缝（§4.8）：从用户供应商实例 + capability 推导可选模型目录。
 * 目录条目的 specifier 约定：`<instanceId>:<modelId>`——run 请求的 model 字段
 * 携带该 specifier 时，agent 链路按实例解析协议适配器（见 providers/resolve.ts）。
 */

export interface ModelCatalogService {
  listCatalog(user: AuthenticatedUser): Promise<ModelCatalogEntry[]>;
  /** 为已鉴权的完整配置快照补模型元信息；候选保留停用项，不二次查询实例。 */
  describeInstanceModels(
    instances: readonly ProviderInstanceResponse[],
  ): ModelCatalogEntry[];
  /**
   * 校验「实例:模型」是否真的在这个用户的目录里（R5-2/E：模型名不在目录时 fail loud）。
   * 返回可读原因 + 可用清单摘要，供保存期与 run 起始期直接透出。
   */
  validateSpecifier(
    user: AuthenticatedUser,
    specifier: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
}

/** 可用清单摘要（最多 8 条，避免把整目录塞进错误文案）。 */
function describeAvailable(entries: ModelCatalogEntry[]): string {
  if (entries.length === 0)
    return "（当前没有任何可用模型——先到「设置 → 供应商」添加实例）";
  const sample = entries
    .slice(0, 8)
    .map((entry) => `${entry.provider.instanceId}:${entry.id}`)
    .join("、");
  return entries.length > 8 ? `${sample} …（共 ${entries.length} 个）` : sample;
}

/**
 * 实例协议 → 快照 provider 偏好：BYOK 实例没有 models.dev 的 provider 键，
 * 只能按模型 id 匹配；同 id 多 provider 命中时该偏好决定取哪份（其余按快照键序）。
 */
const PROTOCOL_PREFERRED_SNAPSHOT_PROVIDER: Partial<
  Record<ProviderProtocol, string>
> = {
  anthropic: "anthropic",
  gemini: "google",
  "google-image": "google",
  "openai-compatible": "openai",
};

/**
 * 快照 hints（三层合并的「补缺」层，docs/future/05 §4.2）：只填用户模型行上
 * **未声明**的字段，声明过的绝不进 hints（用户声明优先，无双源歧义）；
 * 快照未收录 → undefined（未知 ≠ 不支持）。toolCall/reasoning 无用户声明
 * 对应字段，恒为快照值。
 */
function buildHints(
  model: ProviderInstanceModel,
  protocol: ProviderProtocol,
  snapshot: ModelsDevSnapshot | undefined,
): ModelCatalogHints | undefined {
  if (!snapshot) return undefined;
  const hit = findModelsDevModel(
    snapshot,
    model.id,
    PROTOCOL_PREFERRED_SNAPSHOT_PROVIDER[protocol],
  );
  if (!hit) return undefined;
  const hints: ModelCatalogHints = {
    source: "models-dev",
    snapshotProvider: hit.provider,
  };
  if (model.contextWindow === undefined && hit.model.limit?.context) {
    hints.contextWindow = hit.model.limit.context;
  }
  if (model.maxOutputTokens === undefined && hit.model.limit?.output) {
    hints.maxOutputTokens = hit.model.limit.output;
  }
  if (
    model.vision === undefined &&
    hit.model.modalities?.input?.includes("image")
  ) {
    hints.imageInput = true;
  }
  if (hit.model.toolCall !== undefined) {
    hints.toolCall = hit.model.toolCall;
  }
  if (hit.model.reasoning !== undefined) {
    hints.reasoning = hit.model.reasoning;
  }
  return hints;
}

interface CatalogInstance {
  id: string;
  name: string;
  protocol: string;
  models: ProviderInstanceModel[];
}

function toCatalogEntry(
  model: ProviderInstanceModel,
  instance: CatalogInstance,
  scope: "workspace" | "system",
  snapshot: ModelsDevSnapshot | undefined,
): ModelCatalogEntry {
  const protocol = instance.protocol as ProviderProtocol;
  const hints = buildHints(model, protocol, snapshot);
  return {
    id: model.id,
    name: model.name,
    capability: model.capability,
    model,
    ...(hints ? { hints } : {}),
    provider: {
      instanceId: instance.id,
      name: instance.name,
      protocol,
      scope,
    },
  };
}

export function createModelCatalogService(options: {
  modelProviders: ModelProviderService;
  /** models.dev 快照（可选）：缺席 = 无 hints，目录照常（fail-open）。 */
  snapshot?: ModelsDevSnapshot;
}): ModelCatalogService {
  const { modelProviders, snapshot } = options;
  return {
    describeInstanceModels(instances) {
      return instances.flatMap((instance) =>
        instance.models.map((model) =>
          toCatalogEntry(model, instance, instance.scope, snapshot),
        ),
      );
    },
    async listCatalog(user) {
      const instances = await modelProviders.listInstances(user);
      const entries: ModelCatalogEntry[] = [];
      for (const instance of instances) {
        if (!instance.enabled) {
          continue;
        }
        for (const model of instance.models) {
          // 模型级开关：false = 用户在供应商详情里隐藏（缺省启用）
          if (model.enabled === false) continue;
          entries.push(toCatalogEntry(model, instance, "workspace", snapshot));
        }
      }

      // 平台池（scope='system'）：管理员配置一次，分发给全体用户。
      // 目录读取失败不阻断用户自有实例目录（降级为空）。
      try {
        const systemInstances = await modelProviders.listSystemInstances();
        for (const instance of systemInstances) {
          if (!instance.enabled) {
            continue;
          }
          for (const model of instance.models) {
            if (model.enabled === false) continue;
            entries.push(toCatalogEntry(model, instance, "system", snapshot));
          }
        }
      } catch (error) {
        console.warn("[modelCatalog] system instance merge failed:", error);
      }

      return entries;
    },

    async validateSpecifier(user, specifier) {
      const parsed = parseInstanceSpecifier(specifier);
      const entries = await this.listCatalog(user);
      if (!parsed) {
        // 不带实例前缀：按 id 同名匹配（平台池/内置协议词走这条）
        const match = entries.find((entry) => entry.id === specifier);
        if (match) return { ok: true };
        return {
          ok: false,
          message: `模型「${specifier}」不在你的模型目录里。可用：${describeAvailable(entries)}`,
        };
      }
      const match = entries.find(
        (entry) =>
          entry.provider.instanceId === parsed.instanceId &&
          entry.id === parsed.model,
      );
      if (match) return { ok: true };
      // 实例在但模型不在 / 实例整个不在：分别给可读原因
      const instanceKnown = entries.some(
        (entry) => entry.provider.instanceId === parsed.instanceId,
      );
      return {
        ok: false,
        message: instanceKnown
          ? `实例里没有模型「${parsed.model}」（instanceId=${parsed.instanceId}）。可用：${describeAvailable(entries)}`
          : `找不到供应商实例 ${parsed.instanceId}（可能已被删除或停用）。可用：${describeAvailable(entries)}`,
      };
    },
  };
}

/** 目录条目 → agent 链路的模型 specifier（`<instanceId>:<modelId>`）。 */
export function toInstanceSpecifier(entry: {
  id: string;
  provider: { instanceId: string };
}): string {
  return `${entry.provider.instanceId}:${entry.id}`;
}

/** 解析 instance specifier；非实例 specifier（内置目录/裸模型名）返回 undefined。 */
export function parseInstanceSpecifier(
  specifier: string,
): { instanceId: string; model: string } | undefined {
  const separatorIndex = specifier.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= specifier.length - 1) {
    return undefined;
  }
  const instanceId = specifier.slice(0, separatorIndex);
  // 内置目录用 "openai:"/"google:" 等协议词前缀，实例 id 是 uuid（含连字符）。
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      instanceId,
    )
  ) {
    return undefined;
  }
  return { instanceId, model: specifier.slice(separatorIndex + 1) };
}

export type { ModelCapability };
