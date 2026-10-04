import {
  conversationSnapshotSchema,
  conversationTopicWireFrameSchema,
  helloMessageSchema,
  sessionsIndexTopicWireFrameSchema,
  workspaceConfigTopicWireFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";
import { governanceSetting } from "./governance.js";

export type {
  IWindowControllerService,
  WindowHostControllerFrame,
  WindowHostControllerTaskListResult,
  ZCodeTaskListQuery,
} from "@zcode/services";
// 原插件市场沿用ZCode契约，库存与执行权威仍归服务端registry。
export {
  zcodeInstalledPluginSummarySchema,
  zcodePluginsInstallParamsSchema,
  zcodePluginsInstallResultSchema,
  zcodePluginsListResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodePluginsSetEnabledParamsSchema,
  zcodePluginsSetEnabledResultSchema,
  zcodePluginsUninstallParamsSchema,
  zcodePluginsUninstallResultSchema,
} from "@zcode/shared";
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

/** 原 Window Controller 查询入参；结果类型直接引用固定原契约。 */
export const codeUiControllerTaskListQuerySchema = z
  .object({
    kind: z.enum(["pinned", "archived", "timeline", "active"]),
    workspaceScopes: z.array(
      z
        .object({
          workspacePath: z.string().trim().min(1),
          workspaceIdentity: z.string().trim().min(1).optional(),
          workspacePurpose: z.enum(["project", "conversation"]).optional(),
        })
        .strict(),
    ),
    sortBy: z.enum(["created", "updated"]),
    search: z.string().optional(),
    limit: z.number().int().nonnegative().optional(),
  })
  .strict();

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
  z.object({
    event: z.literal("ready"),
    hello: helloMessageSchema,
    reconnectDelayMs: governanceSetting("codeUiReconnectDelayMs")
      .removeDefault()
      .optional(),
  }),
  z.object({
    event: z.literal("onDynamicConversationFrame"),
    workspacePath: z.string(),
    workspaceIdentity: z.string().optional(),
    frame: conversationTopicWireFrameSchema,
  }),
  z.object({
    event: z.literal("onDynamicSessionsIndexFrame"),
    workspacePath: z.string(),
    workspaceIdentity: z.string().optional(),
    frame: sessionsIndexTopicWireFrameSchema,
  }),
  z.object({
    event: z.literal("onDynamicWorkspaceConfigFrame"),
    workspacePath: z.string(),
    workspaceIdentity: z.string().optional(),
    frame: workspaceConfigTopicWireFrameSchema,
  }),
  z.object({
    event: z.literal("service"),
    service: z.string(),
    name: z.string(),
    workspacePath: z.string().optional(),
    workspaceIdentity: z.string().optional(),
    terminalId: z.string().optional(),
    watcherId: z.string().optional(),
    data: z.unknown(),
  }),
]);
export type CodeUiEvent = z.infer<typeof codeUiEventSchema>;

/** IFileService 的宿主读取入参；长度由原 viewer 的分页请求决定。 */
export const codeUiViewerScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskId: z.string().uuid() }),
  z.object({ kind: z.literal("project"), projectId: z.string().uuid() }),
]);
export type CodeUiViewerScope = z.infer<typeof codeUiViewerScopeSchema>;

export const codeUiFileReadParamsSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().nonnegative().optional(),
});
