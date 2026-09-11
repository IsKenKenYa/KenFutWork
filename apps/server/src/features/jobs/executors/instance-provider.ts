import type {
  ImageProvider,
  VideoProvider,
} from "../../../generation/types.js";
import {
  resolveInstanceImageProvider,
  resolveInstanceVideoProvider,
} from "../../../providers/resolve.js";
import type { ModelProviderService } from "../../model-providers/model-provider-service.js";

/**
 * BYOK：任务载荷带 provider_instance_id 时，按用户供应商实例实例化协议适配器。
 * 无实例 id（内置目录）返回 undefined，走遗留全局注册表路径。
 */

type ExecutorCtx = { modelProviders?: ModelProviderService };

async function resolveCredentials(instanceId: string, ctx: ExecutorCtx) {
  if (!ctx.modelProviders) {
    throw new Error(
      `任务携带 provider_instance_id ${instanceId}，但当前进程未装配 modelProviders 缝（fail loud）。`,
    );
  }
  return ctx.modelProviders.resolveCredentialsById(instanceId);
}

export async function resolveInstanceImageProviderFromPayload(
  instanceId: string | undefined,
  ctx: ExecutorCtx,
): Promise<ImageProvider | undefined> {
  if (!instanceId) {
    return undefined;
  }
  const credentials = await resolveCredentials(instanceId, ctx);
  return resolveInstanceImageProvider(credentials.protocol, {
    credentials: {
      apiKey: credentials.apiKey,
      ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
    },
    models: credentials.models
      .filter((m) => m.capability === "image")
      .map((m) => ({ id: m.id, name: m.name })),
  });
}

export async function resolveInstanceVideoProviderFromPayload(
  instanceId: string | undefined,
  ctx: ExecutorCtx,
): Promise<VideoProvider | undefined> {
  if (!instanceId) {
    return undefined;
  }
  const credentials = await resolveCredentials(instanceId, ctx);
  return resolveInstanceVideoProvider(credentials.protocol, {
    credentials: {
      apiKey: credentials.apiKey,
      ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
    },
    models: credentials.models
      .filter((m) => m.capability === "video")
      .map((m) => ({ id: m.id, name: m.name })),
  });
}
