import {
  conversationSnapshotSchema,
  conversationTopicWireFrameSchema,
  helloMessageSchema,
  sessionsIndexTopicWireFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";

/** 界面契约沿用固定 ZCode 原协议，宿主不维护另一套 rows/snapshot。 */
export * as zcodeUiProtocol from "@zcode/shared/zcode-protocol-v4";

export const codeUiWorkspaceSchema = z.object({
  projectId: z.string().uuid(),
  canvasId: z.string().uuid(),
  name: z.string(),
  path: z.string().min(1),
});
export const codeUiWorkspaceListSchema = z.object({
  workspaces: z.array(codeUiWorkspaceSchema),
});

export const codeUiRpcRequestSchema = z.object({
  service: z.string().min(1),
  method: z.string().min(1),
  args: z.array(z.unknown()),
  connectionId: z.string().optional(),
});
export const codeUiRpcResponseSchema = z.object({ result: z.unknown() });

export type CodeUiWorkspace = z.infer<typeof codeUiWorkspaceSchema>;
export type CodeUiRpcRequest = z.infer<typeof codeUiRpcRequestSchema>;

export const codeUiSnapshotParamsSchema = z.object({
  sessionId: z.string().uuid(),
});
export const codeUiSnapshotResponseSchema = z.object({
  snapshot: conversationSnapshotSchema,
});

/** SSE 仅承载原 physical wire frame；原 SessionDataLayer 负责 ownership、激活与装配。 */
export const codeUiEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("ready"), hello: helloMessageSchema }),
  z.object({
    event: z.literal("onDynamicConversationFrame"),
    workspacePath: z.string(),
    frame: conversationTopicWireFrameSchema,
  }),
  z.object({
    event: z.literal("onDynamicSessionsIndexFrame"),
    workspacePath: z.string(),
    frame: sessionsIndexTopicWireFrameSchema,
  }),
  z.object({
    event: z.literal("service"),
    service: z.string(),
    name: z.string(),
    workspacePath: z.string().optional(),
    data: z.unknown(),
  }),
]);
export type CodeUiEvent = z.infer<typeof codeUiEventSchema>;

/** IFileService 的宿主读取入参；长度由原 viewer 的分页请求决定。 */
export const codeUiFileReadParamsSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().nonnegative().optional(),
});
