import { z } from "zod";

/** 可用模式由既有宿主能力判定，顺序沿现有顶部按钮（work 由 work 插件探针门控）。 */
export const workbenchModesSchema = z
  .tuple([z.literal("code"), z.literal("design")])
  .rest(z.enum(["flow", "work"]))
  .refine((modes) => modes.length <= 4);
export type WorkbenchModes = z.infer<typeof workbenchModesSchema>;
export const workbenchModeSchema = z.enum(["code", "design", "flow", "work"]);
export type WorkbenchMode = z.infer<typeof workbenchModeSchema>;
export const workbenchNavigationSchema = z
  .object({
    type: z.literal("kenfutwork:workbench-navigation"),
    availableModes: workbenchModesSchema,
    /** 父→壳推送当前模式（深链 / 外部导航同步）；缺省 code。 */
    mode: workbenchModeSchema.optional(),
    documentTarget: z
      .object({ resourceType: z.literal("canvas"), documentId: z.uuid() })
      .strict()
      .optional(),
  })
  .strict();

/** 宿主控制当前文档的输入活动，不控制Run或会话生命周期。 */
export const workspaceActivitySchema = z
  .object({
    type: z.literal("kenfutwork:workspace-activity"),
    active: z.boolean(),
  })
  .strict();
export type WorkspaceActivity = z.infer<typeof workspaceActivitySchema>;

/** 原管理页的导航目标；不包含执行身份或凭据。 */
export const managementTargetSchema = z.discriminatedUnion("page", [
  z
    .object({
      page: z.literal("settings"),
      section: z
        .enum([
          "general",
          "appearance",
          "migration",
          "browser",
          "modelProvider",
          "memory",
          "plugin",
          "mcp",
          "skill",
          "usage",
          "subagents",
          "commands",
          "hooks",
          "shortcuts",
          "computerUse",
        ])
        .optional(),
      modelProviderId: z.string().min(1).optional(),
      pluginTab: z.enum(["plugins", "mcps", "skills", "commands"]).optional(),
      pluginOrigin: z.literal("plugin-store").optional(),
      pluginScopeKey: z.literal("user").optional(),
      usageTab: z.literal("app").optional(),
    })
    .strict(),
  z
    .object({
      page: z.literal("plugins"),
      pluginId: z.string().min(1).optional(),
      intent: z.literal("add-marketplace").optional(),
      returnScopeKey: z.literal("user").optional(),
    })
    .strict(),
]);
export type ManagementTarget = z.infer<typeof managementTargetSchema>;

/** 父窗口认证与导航缝；原界面的服务调用仍使用原 RPC/帧协议。 */
export const codeUiBootstrapSchema = z.object({
  type: z.literal("kenfutwork:code-bootstrap"),
  apiBase: z.string().url(),
  accessToken: z.string().optional(),
  user: z
    .object({ id: z.string(), username: z.string(), displayName: z.string() })
    .nullable(),
  management: managementTargetSchema.optional(),
  managementAvailable: z.boolean().optional(),
  workbenchModes: workbenchModesSchema.optional(),
});
/** 父→管理文档推送导航目标（keep-alive 复用同一文档时换目标用）。 */
export const managementNavigationSchema = z
  .object({
    type: z.literal("kenfutwork:management-target"),
    target: managementTargetSchema,
  })
  .strict();

export const codeUiParentRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("kenfutwork:code-ready") }),
  // 壳层应用已提交到 DOM：父页据此撤下启动加载屏（`code-ready` 只是「来要身份」，界面还没出来）。
  z.object({ type: z.literal("kenfutwork:code-mounted") }),
  z.object({ type: z.literal("kenfutwork:code-access-lost") }),
  z.object({ type: z.literal("kenfutwork:code-plugins-changed") }),
  z.object({ type: z.literal("kenfutwork:management-close") }),
  z.object({
    type: z.literal("kenfutwork:open-management"),
    target: managementTargetSchema,
  }),
  z.object({
    type: z.literal("kenfutwork:code-open-plugin"),
    pluginId: z.string().min(1),
    entryId: z.string().min(1),
  }),
]);
export type CodeUiBootstrap = z.infer<typeof codeUiBootstrapSchema>;
