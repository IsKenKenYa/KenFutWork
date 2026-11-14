import type {
  zcodeUiProtocol as protocol,
  StreamEvent,
} from "@kenfutwork/shared";
import type { ModelSelection } from "@zcode/shared";
import type { ToolContributionSnapshot } from "../../kernel/types.js";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import type { LocalActor } from "../local-instance/types.js";
import type { CodeApprovalMode } from "../permissions/approval-types.js";
import type { TaskWorkRecord } from "../task-work/types.js";

export type CodeSubagentRole = "explore" | "review" | "worker";

/** 派发目标：内置角色或用户/工作区自定义智能体。 */
export interface CodeSubagentTarget {
  role: CodeSubagentRole;
  /** 用户可见名称（自定义智能体名；内置为派发名）。 */
  label: string;
  /** 自定义智能体的系统提示词；内置角色为空，沿用固定角色模板。 */
  systemPrompt?: string;
  /** 只允许调用的工具名；空/未提供 = 不限制。 */
  toolAllowlist?: readonly string[];
  /** 明确禁用的工具名。 */
  disallowedTools?: readonly string[];
  /** 子运行模型覆盖（`<providerId>:<modelId>`）。 */
  modelSelection?: ModelSelection;
  /** 是否注入实例级默认 AGENTS.md；缺省 true（与 ZCode 的 injectAgentsMd 同义）。 */
  injectAgentsMd?: boolean;
}
export interface ChildSession {
  sessionId: string;
  threadId: string;
  emit(event: StreamEvent): Promise<void>;
  storeResult(text: string): Promise<{
    path: string;
    stats: NonNullable<TaskWorkRecord["outputStats"]>;
  }>;
}
export interface CodeChildRequest {
  goalId?: string;
  workContext?: protocol.ConversationWorkContext;
  frozenContributions?: ToolContributionSnapshot;
  childSessionId: string;
  approvalCeiling: CodeApprovalMode;
  actor: LocalActor;
  scope: ExecutionScopeHandle;
  model: string;
  parentSessionId: string;
  parentRunId: string;
  toolCallId: string;
  branchGeneration: number;
  delegationDepth: number;
  role: CodeSubagentRole;
  description: string;
  ownership: string[];
  completionCriteria: string;
  detached: boolean;
  /** 自定义智能体的系统提示词；缺省用固定角色模板。 */
  systemPrompt?: string;
  toolAllowlist?: readonly string[];
  disallowedTools?: readonly string[];
  /** 自定义智能体显式关闭默认 AGENTS.md 注入。 */
  omitInstanceInstructions?: boolean;
}
export interface CodeChildSessions {
  open(request: CodeChildRequest): Promise<ChildSession>;
}
export interface CodeChildResult {
  status: "completed" | "failed" | "canceled";
  summary: string;
  outputRef: string;
  childSessionId: string;
  childRunId: string;
  outputStats: NonNullable<TaskWorkRecord["outputStats"]>;
}
