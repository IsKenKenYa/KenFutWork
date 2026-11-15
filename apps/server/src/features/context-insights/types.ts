import type {
  ContextRequestAttempt,
  ContextRequestInput,
  ModelCallPurpose,
} from "@kenfutwork/shared";

export interface ContextRequestOwner {
  instanceId: string;
  taskId: string;
  runId: string;
  agentCallId?: string;
  agentName?: string;
}
export interface ContextRequestStart {
  purpose?: ModelCallPurpose;
  attempt?: ContextRequestAttempt;
  id: string;
  owner: ContextRequestOwner;
  startedAt: string;
  input: ContextRequestInput;
}
export interface ContextRequestFinish {
  id: string;
  owner: ContextRequestOwner;
  endedAt: string;
  status: "completed" | "failed" | "cancelled";
  httpStatus?: number;
  output: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  } | null;
}
/** 运行写入与界面读取分开；调用身份本身不授予 Task 访问权限。 */
export interface ContextRequestWriter {
  start(input: ContextRequestStart): Promise<void>;
  finish(input: ContextRequestFinish): Promise<void>;
}
