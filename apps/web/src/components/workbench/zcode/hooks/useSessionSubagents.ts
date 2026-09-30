/**
 * zcode 宿主适配 stub：`@/hooks/useSessionSubagents.ts` 的恒空等价。
 * 来源：references/zcode/packages/ui/src/hooks/useSessionSubagents.ts
 * 许可证：Apache-2.0（zcode）。
 *
 * 原实现经 zcodeAgentService.listSessionSubagents 分页拉取子智能体目录（running 由
 * projection 携带，ended 走 cursor 分页）。本仓无该 RPC 数据源，恒返回空目录：
 * ended 列表恒空、loading 恒 false、无 nextCursor（「加载更多」入口自动隐藏），
 * 消费方走 zcode 自身的空态降级。导出签名与原文件对齐。
 * 消费方：app-shell/SubagentDirectorySidePane。
 */

import type { ZCodeSessionEndedSubagent } from "@zui/lib/zcode-shared";
import { useMemo } from "react";

const EMPTY_ENDED: readonly ZCodeSessionEndedSubagent[] = [];

export function useSessionSubagents(options: {
  enabled?: boolean | undefined;
  refreshKey?: string | number | null | undefined;
  remoteSessionId?: string | undefined;
  sessionId?: string | null | undefined;
  workspaceIdentity?: string | undefined;
  workspacePath: string;
}) {
  void options;
  return useMemo(
    () => ({
      revision: 0,
      ended: { total: 0, items: EMPTY_ENDED, nextCursor: undefined },
      error: null as string | null,
      loading: false,
      async loadMore() {},
      async refresh() {},
    }),
    [],
  );
}
