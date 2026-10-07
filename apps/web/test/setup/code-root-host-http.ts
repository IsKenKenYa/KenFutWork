import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import {
  appSettingsSchema,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeSessionStateSnapshotSchema,
} from "../../../../packages/zcode-shared/dist/index.js";
import { codeHostNotificationResponse } from "./code-host-http";

export const rootProjectId = "30000000-0000-4000-8000-000000000003";
export const rootWorkspace = {
  projectId: rootProjectId,
  path: "/code",
  name: "目录",
  additionalDirectories: [],
};

/** 未声明metadata偏差时，原协议的合法只读空快照投影。 */
export function codeRootNativeSessionSnapshot(
  taskId: string,
  title: string,
  workspacePath = "/code",
  workspaceIdentity?: string,
) {
  return zcodeSessionStateSnapshotSchema.parse({
    protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
    session: {
      sessionId: taskId,
      workspace: {
        workspacePath,
        workspaceKey: workspaceIdentity ?? workspacePath,
      },
      sessionKind: "interactive",
      title,
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
    settings: {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
    projection: {
      sessionId: taskId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 0,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    messages: [],
  });
}

/** 原 Root 的外部 HTTP/SSE 服务夹具，不替换原组件、store 或 projection。 */
export function createCodeRootHostFetch(
  calls: Array<{ service: string; method: string; args: unknown[] }>,
  selection: { rejectOpen: boolean },
) {
  return async (url: string, options?: RequestInit) => {
    if (url.endsWith("/events"))
      return codeHostNotificationResponse(options?.signal ?? undefined);
    if (url.endsWith("/workspaces"))
      return Response.json({ workspaces: [rootWorkspace] });
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
    if (call.service === "zcode-task" && call.method === "getTaskMeta") {
      const target = call.args[0];
      return Response.json({
        result: {
          taskId: target.taskId,
          traceId: target.taskId,
          mode: "build",
          title: "旧任务",
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          projectId: rootProjectId,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    }
    if (call.service === "zcode-task") return Response.json({ result: [] });
    if (call.service === "window-controller" && call.method === "listTaskList")
      return Response.json({ result: { items: [], total: 0, hasMore: false } });
    if (
      call.service === "window-controller" &&
      call.method === "subscribeControllerV4"
    )
      return Response.json({
        result: {
          ack: {
            subscriptionId: `root-${call.args[0].topic}`,
            logEpoch: "root-epoch",
            mode: "snapshot",
          },
        },
      });
    if (
      call.service === "window-controller" &&
      call.method === "unsubscribeControllerV4"
    )
      return Response.json({ result: null });
    if (call.service === "file" && call.method === "resolvePath")
      return Response.json({ result: "/code" });
    if (call.service === "workspace" && call.method === "open")
      return selection.rejectOpen
        ? Response.json(
            { error: { message: "目录项目已归档" } },
            { status: 409 },
          )
        : Response.json({ result: rootWorkspace });
    if (call.service === "file" && call.method === "readdir")
      return Response.json({ result: [] });
    if (
      call.service === "file" &&
      call.method === "ensureConversationWorkspace"
    )
      return Response.json({
        result: {
          ...rootWorkspace,
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
    if (call.method === "helloConversationV4")
      return Response.json({
        result: protocol.helloMessageSchema.parse({
          kind: "hello",
          protocolVersion: 3,
          connectionId: "test-host",
          clientMode: "web-remote-replayable",
          deliveryProfile: "replayable",
          serverTime: 1,
          auth: {},
          capabilities: {
            nativeDialogs: false,
            localTerminal: false,
            binaryFrames: false,
            compression: "none",
          },
        }),
      });
    if (call.method === "initializeConversationV4")
      return Response.json({ result: { accepted: true } });
    return Response.json(
      { error: { message: "该能力未接通" } },
      { status: 501 },
    );
  };
}
