/**
 * zcode 移植层宿主适配：`@/hooks/useWorkspaceOpenInEditorTarget` 的最小等价。
 * 来源：references/zcode/packages/ui/src/hooks/useWorkspaceOpenInEditorTarget.ts
 *
 * zcode 从窗口 tab store 里反查工作区的远程连接（SSH/WSL/Docker），决定 openInEditor
 * 要不要带 remoteTarget。我们宿主没有远程工作区，恒返回本地口径；
 * 接口形状保持与 zcode 一致，照搬组件零改动。
 */
"use client";

import { useMemo } from "react";

import type { OpenInEditorRemoteTarget } from "../lib/zcode-shared.js";

interface WorkspaceOpenInEditorScope {
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

interface WorkspaceOpenInEditorTarget {
  isRemoteWorkspace: boolean;
  remoteTarget?: OpenInEditorRemoteTarget | undefined;
}

const LOCAL_TARGET: WorkspaceOpenInEditorTarget = {
  isRemoteWorkspace: false,
  remoteTarget: undefined,
};

export function useWorkspaceOpenInEditorTarget(
  _scope: WorkspaceOpenInEditorScope,
): WorkspaceOpenInEditorTarget {
  return useMemo(() => LOCAL_TARGET, []);
}
