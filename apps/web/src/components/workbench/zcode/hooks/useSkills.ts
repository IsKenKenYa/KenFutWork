/**
 * zcode 宿主适配 stub：`@/hooks/useSkills` 的最小等价。
 * 来源：references/zcode/packages/ui/src/hooks/useSkills.ts
 *
 * zcode 的对话 Skill catalog 经 zcodeAgentService RPC 拉取（workspace/session authority）。
 * 本仓无该服务层，故恒返回空 catalog（loading=false、error=null）：`@` 面板的 Skill 分组
 * 恒为空并自动隐藏，UI 结构与降级语义不变。后续接通 Skill 目录服务时替换本实现即可。
 * 适配注记：导出签名与原文件一致；数据恒空（stub 降级）。
 */
"use client";

import type { ZCodeSkillReferenceCatalogEntry } from "@zui/lib/zcode-shared";

interface ConversationSkillCatalogState {
  skills: ZCodeSkillReferenceCatalogEntry[];
  authority: "session" | "workspace" | null;
  loading: boolean;
  error: string | null;
}

interface UseSkillsOptions {
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  sessionId: string | null;
  enabled: boolean;
  preferredRemoteSessionId?: string | undefined;
}

const EMPTY_STATE: ConversationSkillCatalogState = {
  skills: [],
  authority: null,
  loading: false,
  error: null,
};

export function useSkills(
  _options: UseSkillsOptions,
): ConversationSkillCatalogState {
  return EMPTY_STATE;
}
