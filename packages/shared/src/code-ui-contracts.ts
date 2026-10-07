import {
  conversationSnapshotSchema,
  conversationTopicWireFrameSchema,
  helloMessageSchema,
  sessionsIndexTopicWireFrameSchema,
  workspaceConfigTopicWireFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";
import { additionalDirectorySchema } from "./execution-contracts.js";
import { governanceSetting } from "./governance.js";

export type {
  ModelConfigObject,
  ProviderConfigObject,
  ProviderSettingsCreationResult,
  ProviderSettingsModelView,
  ProviderSettingsProviderView,
  ProviderSettingsView,
  SavePersonalModelDraftInput,
} from "@zcode/provider";
export type {
  IWindowControllerService,
  WindowHostControllerFrame,
  WindowHostControllerTaskListResult,
  ZCodeTaskListQuery,
} from "@zcode/services";
// 原插件市场与服务沿用固定原契约，权威由KWF服务持有。
export type {
  AppSettings,
  FileEntry,
  IPlatformService,
  ZCodeSessionStateSnapshot,
  ZCodeTaskMeta,
} from "@zcode/shared";
export {
  appSettingsPatchSchema,
  appSettingsSchema,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeInstalledPluginSummarySchema,
  zcodePluginsInstallParamsSchema,
  zcodePluginsInstallResultSchema,
  zcodePluginsListResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodePluginsSetEnabledParamsSchema,
  zcodePluginsSetEnabledResultSchema,
  zcodePluginsUninstallParamsSchema,
  zcodePluginsUninstallResultSchema,
  zcodeSessionStateSnapshotSchema,
} from "@zcode/shared";
/** 界面契约沿用固定 ZCode 原协议，宿主不维护另一套 rows/snapshot。 */
export * as zcodeUiProtocol from "@zcode/shared/zcode-protocol-v4";

export const codeUiWorkspaceSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string(),
  path: z.string().min(1),
  additionalDirectories: z.array(additionalDirectorySchema).default([]),
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

/** 原 Window Controller 查询入参；服务定义与结果类型仍直接引用固定原契约。 */
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

/** HTTP 成功响应是 SSE 文本流；每条事件的原协议定义仍由 codeUiEventSchema 持有。 */
export const codeUiEventStreamSchema = z
  .string()
  .describe(
    "SSE 文本流，每条 data 记录的结构见原 Code 宿主事件契约与 ws-protocol.md",
  );

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
  viewerScope: codeUiViewerScopeSchema,
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().nonnegative().optional(),
});

/** 原 IFileService.readdir 参数面，不另造客户端目录条目结构。 */
export const codeUiFileDirectoryParamsSchema = z
  .object({
    path: z.string().trim().min(1),
    includeHidden: z.boolean().optional(),
  })
  .strict();
