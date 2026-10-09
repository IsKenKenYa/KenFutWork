import { z } from "zod";

/** 父窗口认证与导航缝；原界面的服务调用仍使用原 RPC/帧协议。 */
export const codeUiBootstrapSchema = z.object({
  type: z.literal("kenfutwork:code-bootstrap"),
  apiBase: z.string().url(),
  accessToken: z.string().optional(),
  user: z
    .object({ id: z.string(), username: z.string(), displayName: z.string() })
    .nullable(),
});
export const codeUiParentRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("kenfutwork:code-ready") }),
  z.object({ type: z.literal("kenfutwork:code-access-lost") }),
  z.object({ type: z.literal("kenfutwork:code-plugins-changed") }),
  z.object({
    type: z.literal("kenfutwork:code-open-plugin"),
    pluginId: z.string().min(1),
    entryId: z.string().min(1),
  }),
  z.object({
    type: z.literal("kenfutwork:code-navigate"),
    mode: z.literal("design"),
  }),
]);
export type CodeUiBootstrap = z.infer<typeof codeUiBootstrapSchema>;
