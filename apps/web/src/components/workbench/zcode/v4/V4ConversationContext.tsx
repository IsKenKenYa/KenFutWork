/**
 * zcode 宿主适配 stub：`@/v4/V4ConversationContext.tsx` 的恒空等价。
 * 来源：references/zcode/packages/ui/src/v4/V4ConversationContext.tsx
 * 许可证：Apache-2.0（zcode）。
 *
 * 原实现按 workspace 解析 services、经 workspaceConnectionRegistry 租用连接并装配
 * SessionDataLayer + ConversationTransport（per-pane 数据面）。本仓没有该 RPC 数据源，
 * Provider 恒注入「未接通」的空数据面：方法全部 reject（调用方走 zcode 自身的
 * catch 降级），layer.acquire 返回即释放的空租约——消费方全部落到空态。
 * 上下文缺省仍为 null：useHasV4Conversation() 在无 Provider 子树恒 false（完成卡画冷态）。
 * 导出面与原文件对齐（消费切片）：V4ConversationContextValue / V4ConversationContext /
 * V4ConversationProvider / useV4Conversation / useHasV4Conversation / V4PaneConversationProvider。
 * 消费方：app-shell/SubagentDirectorySidePane、hooks/useWorkflowRunArtifact{Bytes,Data,s}、
 * v4/ConversationWorkflowCompletion。
 */

import type {
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
} from "@zui/lib/zcode-shared/zcode-protocol-v4";
import type { PaneWorkspaceScope } from "@zui/v4/paneLayoutStore";
import type { SessionLease } from "@zui/v4/sessionDataLayer";
import { createContext, type ReactNode, useContext, useMemo } from "react";

/** 会话数据层的宿主切片（原 SessionDataLayer；消费方仅触达 acquire/release）。 */
export interface V4SessionDataLayerSlice {
  acquire(sessionId: string): SessionLease;
}

export interface V4ConversationContextValue {
  layer: V4SessionDataLayerSlice;
  /** workflow run 的用户面产物清单（冷恢复的 durable 读法）。 */
  workflowRunArtifacts(
    params: V4ConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** 预置看板的条目分页（cursor = journal sequence）。 */
  workflowRunArtifactData(
    params: V4ConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** 内容产物的字节，一次一块（≤ 512 KiB）；拼接归调用方的 hook。 */
  workflowRunArtifactRead(
    params: V4ConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
}

const UNCONNECTED = new Error("v4 conversation 数据层未接通（宿主 stub）");

const stubValue: V4ConversationContextValue = {
  layer: {
    acquire(sessionId: string): SessionLease {
      return {
        sessionId,
        release() {},
      };
    },
  },
  async workflowRunArtifacts() {
    throw UNCONNECTED;
  },
  async workflowRunArtifactData() {
    throw UNCONNECTED;
  },
  async workflowRunArtifactRead() {
    throw UNCONNECTED;
  },
};

// 导出 context 本体：无 Provider 时为 null，消费方据此画冷态。
export const V4ConversationContext =
  createContext<V4ConversationContextValue | null>(null);

/** 每个 workspace 一条 host 连接 + 一个 SessionDataLayer（本仓恒注入未接通空数据面）。 */
export function V4ConversationProvider({ children }: { children: ReactNode }) {
  return (
    <V4ConversationContext.Provider value={stubValue}>
      {children}
    </V4ConversationContext.Provider>
  );
}

export function useV4Conversation(): V4ConversationContextValue {
  const ctx = useContext(V4ConversationContext);
  if (!ctx) {
    throw new Error("useV4Conversation 必须在 V4ConversationProvider 内使用");
  }
  return ctx;
}

/**
 * 有没有会话上下文可用。给那些可以在没有会话的宿主里渲染的组件（静态渲染、回放、
 * 转录里的完成卡）决定要不要挂上取数的那一层——挂了就得有上下文，没有就画冷态。
 */
export function useHasV4Conversation(): boolean {
  return useContext(V4ConversationContext) !== null;
}

/**
 * per-pane 数据面：同 scope 的 pane 共享一条 transport + SessionDataLayer
 * （本仓恒注入未接通空数据面，子树整体走空态降级）。
 */
export function V4PaneConversationProvider({
  scope: _scope,
  children,
}: {
  scope: PaneWorkspaceScope;
  children: ReactNode;
}) {
  const value = useMemo(() => stubValue, []);
  return (
    <V4ConversationContext.Provider value={value}>
      {children}
    </V4ConversationContext.Provider>
  );
}
