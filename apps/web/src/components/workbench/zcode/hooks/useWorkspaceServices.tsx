import type { IServiceAccessor } from "@zcode/services";
import { Event, ProxyChannel, type IChannel } from "@zcode/rpc";
import { useMemo } from "react";
import { useOptionalServices, useServices } from "@zui/hooks/useServices.js";
import {
  useRemoteWorkspaceSessionStore,
} from "@zui/store/remoteWorkspaceSessionStore.js";
import { isRemoteWorkspaceTarget, resolveWorkspaceServices } from "@zui/lib/workspaceServiceResolver.js";
import { useTabStore } from "@zui/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@zui/store/tabStore.js";
import { REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE } from "@zui/lib/remoteWorkspaceServiceError.js";

let disconnectedRemoteServices: IServiceAccessor | null = null;

function createDisconnectedRemoteServices(): IServiceAccessor {
  const createDisconnectedError = () => {
    const error = new Error(REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) as Error & {
      code: string;
    };
    error.code = REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
    return error;
  };
  const disconnectedChannel: IChannel = {
    call: () => Promise.reject(createDisconnectedError()),
    listen: () => Event.None,
  };
  // 断连代理曾自行维护普通事件白名单，新增 onAgentRuntimeRestarted 后被误判成
  // RPC 方法并返回 Promise，释放订阅时触发 Promise.dispose 崩溃。这里复用真实 RPC 代理的
  // 事件分类契约：命令明确拒绝，普通/动态事件统一返回空订阅，避免两套规则再次漂移。
  const serviceProxy = ProxyChannel.toService<object>(disconnectedChannel);

  return new Proxy(Object.create(null), {
    get() {
      return serviceProxy;
    },
  }) as IServiceAccessor;
}

function getDisconnectedRemoteServices(): IServiceAccessor {
  if (!disconnectedRemoteServices) {
    disconnectedRemoteServices = createDisconnectedRemoteServices();
  }
  return disconnectedRemoteServices;
}

function resolveBaseWorkspaceServices(
  contextServices: IServiceAccessor,
  registeredBaseServices: IServiceAccessor | null,
): IServiceAccessor {
  return registeredBaseServices ?? contextServices;
}

export function useBaseWorkspaceServices(): IServiceAccessor {
  const contextServices = useServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // App 会在当前激活 workspace 外层再套一层 ServiceProvider。
  // 激活远端 tab 后，useServices() 读到的是远端 host；但 timeline/search/workspace
  // 这类跨 workspace 查询里的本地 shard 必须继续查本机 host。
  // 这里优先使用 renderer 启动时注册的根 services，避免远端连接污染本地任务列表。
  return resolveBaseWorkspaceServices(contextServices, registeredBaseServices);
}

export function useOptionalBaseWorkspaceServices(): IServiceAccessor | null {
  const contextServices = useOptionalServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // usage entitlement 等 app-global 能力曾从当前 workspace ServiceProvider
  // 取服务；远端 tab 在 attachment ready 前会得到断连代理并产生无效 RPC。base host 才是
  // app-global 权威；Web/SSR 未注册 base services 时保留原有 context/null 降级语义。
  return registeredBaseServices ?? contextServices;
}

interface WorkspaceServicesResolution {
  services: IServiceAccessor;
  remoteSessionId: string | null;
  isRemoteTarget: boolean;
  connectionKind: "local-ready" | "local-waiting" | "remote-waiting" | "remote-ready";
  rpcReady: boolean;
}

export function useWorkspaceServicesResolution(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): WorkspaceServicesResolution {
  const currentContextServices = useServices();
  const targetTab = useTabStore((state) => {
    if (!workspacePath) return null;
    const identity = workspaceIdentity?.trim();
    const matches = state.tabs.filter((tab): tab is WorkspaceTabState =>
      isWorkspaceTab(tab) && tab.workspacePath === workspacePath &&
      (!identity || tab.workspaceIdentity?.trim() === identity),
    );
    const active = matches.find((tab) => tab.id === state.activeTabId);
    return active ?? (matches.length === 1 ? matches[0] ?? null : null);
  });
  const target = useMemo(() => {
    if (!workspacePath) return null;
    const identity = workspaceIdentity?.trim() || targetTab?.workspaceIdentity?.trim();
    const sessionId = preferredRemoteSessionId?.trim() || targetTab?.remoteSessionId?.trim();
    const destination = remoteTarget ?? targetTab?.remoteTarget;
    return {
      workspacePath,
      ...(identity ? { workspaceIdentity: identity } : {}),
      ...(sessionId ? { remoteSessionId: sessionId } : {}),
      ...(destination ? { remoteTarget: destination } : {}),
    };
  }, [workspacePath, workspaceIdentity, preferredRemoteSessionId, remoteTarget, targetTab]);
  const state = useRemoteWorkspaceSessionStore();
  const baseServices = resolveBaseWorkspaceServices(currentContextServices, state.baseServices);
  const resolved = useMemo(() => target ? resolveWorkspaceServices(target, baseServices, state) : null, [target, baseServices, state]);
  const isRemoteTarget = target ? isRemoteWorkspaceTarget(target) : false;
  const rpcReady = !target || resolved !== null;
  const resolvedServices = resolved?.services ?? (target ? getDisconnectedRemoteServices() : baseServices);
  const resolvedRemoteSessionId = resolved?.remoteSessionId ?? null;
  const connectionKind = isRemoteTarget
    ? resolvedRemoteSessionId
      ? "remote-ready"
      : "remote-waiting"
    : rpcReady ? "local-ready" : "local-waiting";

  // 远程 SSH host 断开后，若在 resolvedRemoteSessionId 为空时回退到 baseServices，
  // /root 这类远程 task 会被本机 host 查询并报“task 不存在”。远程目标缺少 session 时必须保持断连态，
  // 由上面的断连代理给出可恢复错误，而不是把请求误路由到本机 workspace。
  // 启动重连期仅有 tab 元数据、真实 remote services 尚未注册时属于 remote-waiting；
  // 调用方必须暂停 workspace RPC，断连代理只保留为最终越界保护，不能把预期等待态当失败重试。
  return useMemo(
    () => ({
      services: resolvedServices,
      remoteSessionId: resolvedRemoteSessionId,
      isRemoteTarget,
      connectionKind,
      rpcReady,
    }),
    [connectionKind, isRemoteTarget, resolvedRemoteSessionId, resolvedServices, rpcReady],
  );
}

export function useWorkspaceServices(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): IServiceAccessor {
  return useWorkspaceServicesResolution(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  ).services;
}
