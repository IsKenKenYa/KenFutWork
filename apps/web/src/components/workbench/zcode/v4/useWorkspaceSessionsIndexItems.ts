/**
 * zcode 宿主适配 stub：`@/v4/useWorkspaceSessionsIndexItems` 的最小等价。
 * 来源：references/zcode/packages/ui/src/v4/useWorkspaceSessionsIndexItems.ts
 *
 * zcode 把若干 workspace scope 的 sessions-index 会话经 agentService RPC 聚合成
 * ZCodeTaskMeta[]（侧栏/`#` 会话面板共用）。本仓无该 RPC 数据源，故恒返回空聚合：
 * items 恒空、无 hydrating endpoint——消费方（sessionsMentionProvider 的 `#` 面板等）
 * 恒为空并自动隐藏。scope 类型与 sourceKey 构造逐字保留，便于后续接通数据源零改动替换。
 * 适配注记：导出签名与原文件一致；数据恒空（stub 降级）。
 */
"use client";

import { buildTaskWorkspaceKey } from "@zui/lib/taskQueryCache";
import type { ZCodeTaskMeta } from "@zui/lib/zcode-shared";

export interface WorkspaceSessionsIndexScope {
  workspacePath: string;
  workspaceIdentity?: string;
  /** endpoint 维度（remote shard 的 remoteSessionId）；缺省 = 本机 __base__。 */
  endpointKey?: string;
  /** scope 所属 endpoint 的 agent service（resolveWorkspaceServices 产物）；缺省 = base services。 */
  agentService?: unknown;
}

interface WorkspaceSessionsIndexItemsResult {
  /** 聚合会话 meta（running 置顶；其余按 updatedAt 降序；tick 驱动重算，引用稳定）。 */
  items: ZCodeTaskMeta[];
  /** 每个 endpoint + workspace scope 的只读代次。 */
  sourceRevisionByScopeKey: Readonly<Record<string, string>>;
  /** 已订阅但尚未收到首个 snapshot 的 endpoint。 */
  hydratingEndpointKeys: string[];
}

/** workspace 复用键 = services resolveWorkspaceKey 口径（identity ?? path）。 */
function workspaceKeyOf(scope: WorkspaceSessionsIndexScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

export function buildWorkspaceSessionsIndexSourceKey(
  scope: Pick<
    WorkspaceSessionsIndexScope,
    "workspacePath" | "workspaceIdentity" | "endpointKey"
  >,
): string {
  return workspaceKeyOf(scope);
}

const EMPTY_RESULT: WorkspaceSessionsIndexItemsResult = {
  items: [],
  sourceRevisionByScopeKey: {},
  hydratingEndpointKeys: [],
};

export function useWorkspaceSessionsIndexItems(
  _scopes: WorkspaceSessionsIndexScope[],
): WorkspaceSessionsIndexItemsResult {
  // 本仓无 sessions-index 数据源：恒空聚合，scope 仅作签名保留。
  return EMPTY_RESULT;
}
