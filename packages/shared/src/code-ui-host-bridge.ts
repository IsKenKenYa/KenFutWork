import { z } from "zod";

/** 可用模式由既有宿主能力判定，顺序沿现有顶部按钮。 */
export const workbenchModesSchema = z
  .tuple([z.literal("code"), z.literal("design")])
  .rest(z.literal("flow"))
  .refine((modes) => modes.length <= 3);
export type WorkbenchModes = z.infer<typeof workbenchModesSchema>;
export const workbenchNavigationSchema = z
  .object({
    type: z.literal("kenfutwork:workbench-navigation"),
    availableModes: workbenchModesSchema,
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
export const codeUiParentRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("kenfutwork:code-ready") }),
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
  z.object({
    type: z.literal("kenfutwork:code-navigate"),
    mode: z.enum(["design", "flow"]),
  }),
]);
export type CodeUiBootstrap = z.infer<typeof codeUiBootstrapSchema>;
