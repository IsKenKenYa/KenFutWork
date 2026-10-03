import { appSettingsSchema } from "@kenfutwork/shared";
import { codeHostNotificationResponse } from "./code-host-http";

/** 原 Root 的外部 HTTP/SSE 服务夹具，不替换原组件、store 或 projection。 */
export function createCodeRootHostFetch(
  calls: Array<{ service: string; method: string; args: unknown[] }>,
  selection: { rejectOpen: boolean },
) {
  return async (url: string, options?: RequestInit) => {
    if (url.endsWith("/events"))
      return codeHostNotificationResponse(options?.signal ?? undefined);
    const call = JSON.parse(String(options?.body));
    calls.push(call);
    if (call.service === "setting")
      return Response.json({
        result: appSettingsSchema.parse({}),
      });
    if (call.service === "providerSettingsService")
      return Response.json({
        result: {
          revision: 1,
          providerTemplates: [],
          providers: [],
          providerOrder: [],
        },
      });
    if (call.service === "modelSelectionService")
      return Response.json({ result: { revision: 1, providers: [] } });
    if (call.service === "zcode-task") return Response.json({ result: [] });
    if (call.service === "file" && call.method === "resolvePath")
      return Response.json({ result: "/code" });
    if (call.service === "workspace" && call.method === "open")
      return selection.rejectOpen
        ? Response.json(
            { error: { message: "目录项目已归档" } },
            { status: 409 },
          )
        : Response.json({ result: { path: "/code" } });
    if (call.service === "file" && call.method === "readdir")
      return Response.json({ result: [] });
    if (
      call.service === "file" &&
      call.method === "ensureConversationWorkspace"
    )
      return Response.json({
        result: {
          path: "/code",
          created: true,
          workspacePurpose: "conversation",
        },
      });
    if (call.service === "onboarding-record")
      return Response.json({
        result: call.method === "shouldOnboard" ? false : null,
      });
    if (call.service === "system")
      return Response.json({
        result: { platform: "darwin", homedir: "/fixture" },
      });
    return Response.json(
      { error: { message: "该能力未接通" } },
      { status: 501 },
    );
  };
}
