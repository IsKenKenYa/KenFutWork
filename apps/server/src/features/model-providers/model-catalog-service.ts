import type {
  ModelCapability,
  ModelCatalogEntry,
  ProviderProtocol,
} from "@kenfutwork/shared";

import type { AuthenticatedUser } from "../auth/types.js";
import type { ModelProviderService } from "./model-provider-service.js";

/**
 * modelCatalog 缝（§4.8）：从用户供应商实例 + capability 推导可选模型目录。
 * 目录条目的 specifier 约定：`<instanceId>:<modelId>`——run 请求的 model 字段
 * 携带该 specifier 时，agent 链路按实例解析协议适配器（见 providers/resolve.ts）。
 */

export interface ModelCatalogService {
  listCatalog(user: AuthenticatedUser): Promise<ModelCatalogEntry[]>;
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

export function createModelCatalogService(options: {
  modelProviders: ModelProviderService;
}): ModelCatalogService {
  const { modelProviders } = options;
  return {
    async listCatalog(user) {
      const instances = await modelProviders.listInstances(user);
      const entries: ModelCatalogEntry[] = [];
      for (const instance of instances) {
        if (!instance.enabled) {
          continue;
        }
        for (const model of instance.models) {
          entries.push({
            id: model.id,
            name: model.name,
            capability: model.capability,
            model,
            provider: {
              instanceId: instance.id,
              name: instance.name,
              protocol: instance.protocol as ProviderProtocol,
              scope: "workspace",
            },
          });
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
            entries.push({
              id: model.id,
              name: model.name,
              capability: model.capability,
              model,
              provider: {
                instanceId: instance.id,
                name: instance.name,
                protocol: instance.protocol as ProviderProtocol,
                scope: "system",
              },
            });
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
