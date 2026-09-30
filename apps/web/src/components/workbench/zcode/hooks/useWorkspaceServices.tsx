/**
 * zcode 宿主适配 stub：`@/hooks/useWorkspaceServices` 的最小等价。
 * 来源：references/zcode/packages/ui/src/hooks/useWorkspaceServices.tsx
 *
 * zcode 的 workspace 级服务解析在「本机 host / 远端 host（SSH/WSL/Docker）」之间路由
 * IServiceAccessor。本仓宿主无 zcode RPC 层、无远端工作区（多端产品设计已去云托管/远控），
 * 故：
 * - `useBaseWorkspaceServices` / `useWorkspaceServices` 返回占位 accessor（成员访问得
 *   undefined）——消费方判空降级、隐藏能力入口（方法调用在 undefined 上自然 TypeError；
 *   「访问即抛错」版本曾让 mention 面板在 useMemo 里直接崩 Runtime Error）；
 * - `useOptionalBaseWorkspaceServices` 恒返回 null（沿用 zcode「未注册 base services」降级语义）；
 * - `useWorkspaceServicesResolution` 恒 local 目标且 `rpcReady: false`——消费方据此跳过
 *   workspace RPC 拉取、保持空态（无远端目标，`isRemoteTarget` 恒 false）。
 * 后续若接通 RPC 服务层，只需替换本文件的 accessor 构造，照搬组件零改动。
 * 适配注记：导出签名与原文件一致；数据恒空 / 服务成员访问得 undefined（stub 降级）。
 */
"use client";

import { useOptionalServices, useServices } from "@zui/hooks/useServices";
import type { IServiceAccessor } from "@zui/lib/zcode-services";

/**
 * 占位 accessor：成员访问返回 undefined（zcode 原生 IServiceAccessor 上未初始化的
 * 服务同为 undefined，消费方判空降级）；方法调用在 undefined 上自然 TypeError。
 * 此前「访问即抛错」会让 mention 面板（sessionsMentionProvider 在 useMemo 里取
 * zcodeAgentService）直接崩掉 Runtime Error——那是错误态不是降级态（P5b 真机）。
 */
function createUnavailableServices(): IServiceAccessor {
  return new Proxy(Object.create(null), {
    get() {
      return undefined;
    },
  });
}

let unavailableServices: IServiceAccessor | null = null;

function getUnavailableServices(): IServiceAccessor {
  unavailableServices ??= createUnavailableServices();
  return unavailableServices;
}

export interface WorkspaceServicesResolution {
  services: IServiceAccessor;
  remoteSessionId: string | null;
  isRemoteTarget: boolean;
  connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
  rpcReady: boolean;
}

export function useBaseWorkspaceServices(): IServiceAccessor {
  // 读一次 context 以保持 hook 语义（Provider 缺失时与 useServices 同步报错）。
  useServices();
  return getUnavailableServices();
}

export function useOptionalBaseWorkspaceServices(): IServiceAccessor | null {
  useOptionalServices();
  return null;
}

export function useWorkspaceServicesResolution(
  _workspacePath: string | null | undefined,
  _preferredRemoteSessionId?: string | null,
  _workspaceIdentity?: string | null,
  _remoteTarget?: unknown,
): WorkspaceServicesResolution {
  useServices();
  // 本仓无 RPC 层：local 目标但服务永不 ready，消费方据此保持空态、跳过 workspace RPC。
  return {
    services: getUnavailableServices(),
    remoteSessionId: null,
    isRemoteTarget: false,
    connectionKind: "local-ready",
    rpcReady: false,
  };
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
