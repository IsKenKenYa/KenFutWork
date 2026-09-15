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
