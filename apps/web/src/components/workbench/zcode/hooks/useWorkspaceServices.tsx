/**
 * zcode 宿主适配 stub：`@/hooks/useWorkspaceServices` 的最小等价。
 * 来源：references/zcode/packages/ui/src/hooks/useWorkspaceServices.tsx
 *
 * zcode 的 workspace 级服务解析在「本机 host / 远端 host（SSH/WSL/Docker）」之间路由
 * IServiceAccessor。本仓宿主无 zcode RPC 层、无远端工作区（多端产品设计已去云托管/远控），
 * 故：
 * - `useBaseWorkspaceServices` / `useWorkspaceServices` 返回恒抛错的占位 accessor——消费方
 *   一旦真正触达服务方法即落 error 态（fail loud），UI 按各自的降级分支隐藏能力入口；
 * - `useOptionalBaseWorkspaceServices` 恒返回 null（沿用 zcode「未注册 base services」降级语义）；
 * - `useWorkspaceServicesResolution` 恒 local 目标且 `rpcReady: false`——消费方据此跳过
 *   workspace RPC 拉取、保持空态（无远端目标，`isRemoteTarget` 恒 false）。
 * 后续若接通 RPC 服务层，只需替换本文件的 accessor 构造，照搬组件零改动。
 * 适配注记：导出签名与原文件一致；数据恒空 / 服务访问恒抛错（stub 降级）。
 */
"use client";

import { useOptionalServices, useServices } from "@zui/hooks/useServices";
import type { IServiceAccessor } from "@zui/lib/zcode-services";

/** 恒抛错占位 accessor：任何成员访问都代表「zcode RPC 服务未接通」。 */
function createUnavailableServices(): IServiceAccessor {
  return new Proxy(Object.create(null), {
    get() {
      throw new Error("zcode RPC services 未接通（useWorkspaceServices stub）");
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
