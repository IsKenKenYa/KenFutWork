import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { ClientSceneConfig, IClientScenesService } from "@zcode/services";
import { createClientScenesVisibilityRecovery } from "@zui/hooks/clientScenesVisibilityRecovery.js";

const CLIENT_SCENES_RESOURCE_KEY = "client-scenes";
const CLIENT_SCENES_DEDUPING_INTERVAL_MS = 10 * 60 * 1000;

const EMPTY_SCENES: ClientSceneConfig[] = [];
const serviceAuthorityIds = new WeakMap<IClientScenesService, number>();
let nextServiceAuthorityId = 1;
const visibilityAuthorities = new WeakMap<IClientScenesService, WeakMap<object, object>>();
let visibilityRecovery: ReturnType<typeof createClientScenesVisibilityRecovery> | null = null;

function getServiceAuthorityId(service: IClientScenesService): number {
  const existing = serviceAuthorityIds.get(service);
  if (existing !== undefined) return existing;
  const next = nextServiceAuthorityId;
  nextServiceAuthorityId += 1;
  serviceAuthorityIds.set(service, next);
  return next;
}

function getVisibilityAuthority(service: IClientScenesService, cache: object): object {
  let cacheAuthorities = visibilityAuthorities.get(service);
  if (!cacheAuthorities) {
    cacheAuthorities = new WeakMap<object, object>();
    visibilityAuthorities.set(service, cacheAuthorities);
  }
  const existing = cacheAuthorities.get(cache);
  if (existing) return existing;
  const authority = {};
  cacheAuthorities.set(cache, authority);
  return authority;
}

function getClientScenesVisibilityRecovery() {
  if (typeof document === "undefined") return null;
  visibilityRecovery ??= createClientScenesVisibilityRecovery(document);
  return visibilityRecovery;
}

class ClientScenesBusinessError extends Error {
  readonly code: number;
  readonly responseMessage: string;

  constructor(code: number, responseMessage: string) {
    super(`Client Scenes returned business error ${code}: ${responseMessage}`);
    this.name = "ClientScenesBusinessError";
    this.code = code;
    this.responseMessage = responseMessage;
  }
}

export function isClientScenesBusinessError(error: unknown): error is ClientScenesBusinessError {
  return error instanceof ClientScenesBusinessError;
}

interface UseClientScenesResourceOptions {
  enabled?: boolean;
}

export function useClientScenesResource(
  clientScenesService: IClientScenesService,
  options: UseClientScenesResourceOptions = {},
) {
  const enabled = options.enabled ?? true;
  const authorityId = getServiceAuthorityId(clientScenesService);
  const { cache } = useSWRConfig();
  const visibilityAuthority = getVisibilityAuthority(clientScenesService, cache as object);
  // 宿主明确返回业务失败（如本机没有场景目录）后不再重新拉取：
  // focus/重连/可见性恢复的重验会把同一条业务错误反复刷进日志。
  const [hostDeclined, setHostDeclined] = useState(false);
  const resource = useSWR<ClientSceneConfig[], Error>(
    enabled ? [CLIENT_SCENES_RESOURCE_KEY, authorityId] : null,
    async () => {
      const response = await clientScenesService.list();
      if (response.code !== 0) {
        throw new ClientScenesBusinessError(response.code, response.msg);
      }
      return response.data;
    },
    {
      dedupingInterval: CLIENT_SCENES_DEDUPING_INTERVAL_MS,
      focusThrottleInterval: CLIENT_SCENES_DEDUPING_INTERVAL_MS,
      keepPreviousData: false,
      refreshInterval: 0,
      revalidateOnFocus: !hostDeclined,
      revalidateOnReconnect: !hostDeclined,
      shouldRetryOnError: false,
    },
  );

  useEffect(() => {
    if (isClientScenesBusinessError(resource.error)) setHostDeclined(true);
  }, [resource.error]);

  useEffect(() => {
    if (!enabled || hostDeclined) return;
    // macOS 点击关闭只 hide BrowserWindow，renderer 与 SWR 缓存不会销毁；
    // 重新 show 时若仍在去重窗口内，内建 focus revalidate 会继续复用旧 Scene。
    // hidden -> visible 必须绕过去重窗口强制重验，同时按 Service/cache authority 合并并发消费方。
    return getClientScenesVisibilityRecovery()?.subscribe(visibilityAuthority, () => {
      void resource.mutate().catch(() => undefined);
    });
  }, [enabled, hostDeclined, resource.mutate, visibilityAuthority]);

  return {
    scenes: resource.data ?? EMPTY_SCENES,
    loading: enabled && resource.data === undefined && resource.isLoading,
    revalidating: resource.isValidating,
    error: resource.error,
    revalidate: resource.mutate,
  };
}
