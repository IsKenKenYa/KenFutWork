import type {
  ImageProvider,
  VideoProvider,
} from "../../../generation/types.js";
import {
  type HeaderRenderContext,
  instanceHeadersOption,
} from "../../../providers/instance-headers.js";
import {
  resolveInstanceImageProvider,
  resolveInstanceVideoProvider,
} from "../../../providers/resolve.js";
import type { ModelProviderService } from "../../model-providers/model-provider-service.js";

/**
 * BYOK：任务载荷带 provider_instance_id 时，按用户供应商实例实例化协议适配器。
 * 无实例 id（内置目录）返回 undefined，走遗留全局注册表路径。
 *
 * 自定义请求头（§4.8）：会话上下文取自 **job 行**的 session_id/thread_id——
 * 必须逐会话取值，否则亲和类头会塌成实例级常量。
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
  headerContext: HeaderRenderContext = {},
): Promise<ImageProvider | undefined> {
  if (!instanceId) {
    return undefined;
  }
  const credentials = await resolveCredentials(instanceId, ctx);
  return resolveInstanceImageProvider(credentials.protocol, {
    credentials: {
      apiKey: credentials.apiKey,
      ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
      ...instanceHeadersOption(credentials.headers, headerContext),
    },
    models: credentials.models
      .filter((m) => m.capability === "image" || m.capability === "image-edit")
      .map((m) => ({ id: m.id, name: m.name })),
  });
}

/**
 * 视频版额外透出实例的 `configRevision`——异步任务 submit 时把修订号落进
 * job payload，poll 执行时比对不一致即拒（跨修订不复活旧任务，S6 老化治理）。
 */
export async function resolveInstanceVideoProviderFromPayload(
  instanceId: string | undefined,
  ctx: ExecutorCtx,
  headerContext: HeaderRenderContext = {},
): Promise<{ provider: VideoProvider; configRevision: number } | undefined> {
  if (!instanceId) {
    return undefined;
  }
  const credentials = await resolveCredentials(instanceId, ctx);
  const provider = resolveInstanceVideoProvider(credentials.protocol, {
    credentials: {
      apiKey: credentials.apiKey,
      ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
      ...instanceHeadersOption(credentials.headers, headerContext),
    },
    models: credentials.models
      .filter((m) => m.capability === "video")
      .map((m) => ({ id: m.id, name: m.name })),
  });
  return { provider, configRevision: credentials.configRevision };
}
