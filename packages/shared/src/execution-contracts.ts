import { z } from "zod";

export const directoryAccessSchema = z.enum(["read-only", "read-write"]);
export const additionalDirectorySchema = z.object({
  path: z.string().trim().min(1),
  access: directoryAccessSchema,
}).strict();
export const sandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

/** 服务端签发的执行事实；凭据和审批不能进入可序列化目录授权。 */
export const codeExecutionScopeSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  taskId: z.uuid(),
  generation: z.number().int().nonnegative().safe(),
  rootDirectory: z.string().min(1),
  additionalDirectories: z.array(additionalDirectorySchema),
  sandboxMode: sandboxModeSchema,
}).strict();

/** 主目录创建时固定；Task 调整只允许附加目录与沙箱档，不能伪造身份/代际。 */
export const codeTaskScopeUpdateRequestSchema = z.object({
  additionalDirectories: z.array(additionalDirectorySchema).optional(),
  sandboxMode: sandboxModeSchema.optional(),
}).strict();
export const codeTaskScopeResponseSchema = z.object({ scope: codeExecutionScopeSchema });
export const codeTaskScopeParamsSchema = z.object({ taskId: z.uuid() });

export type AdditionalDirectory = z.infer<typeof additionalDirectorySchema>;
export type DirectoryAccess = z.infer<typeof directoryAccessSchema>;
export type SandboxMode = z.infer<typeof sandboxModeSchema>;
export type CodeExecutionScope = z.infer<typeof codeExecutionScopeSchema>;
export type CodeTaskScopeUpdateRequest = z.infer<typeof codeTaskScopeUpdateRequestSchema>;

/** Code 工作目录只用 Task；Canvas 目标保留给 Design/Flow，两个身份不得混用。 */
export const codeWorkDirectoryTargetSchema = z.object({ taskId: z.uuid() }).strict();
export const visualWorkDirectoryTargetSchema = z.object({ canvasId: z.string().min(1) }).strict();
export const workDirectoryTargetSchema = z.union([codeWorkDirectoryTargetSchema, visualWorkDirectoryTargetSchema]);
export type WorkDirectoryTarget = z.infer<typeof workDirectoryTargetSchema>;

/** 用户可见后台工作事实；执行宿主 owner、凭据与私有句柄不进入事件契约。 */
export const taskWorkStateSchema = z.object({
  workId: z.uuid(), taskId: z.uuid(), branchGeneration: z.number().int().positive(),
  originRunId: z.string().min(1), toolCallId: z.string().min(1),
  kind: z.enum(["command", "subagent"]), label: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled", "interrupted"]),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime().optional(),
  childSessionId: z.uuid().optional(), summary: z.string().optional(), consumed: z.boolean(), detached: z.boolean().optional(),
}).strict();
export type TaskWorkState = z.infer<typeof taskWorkStateSchema>;
