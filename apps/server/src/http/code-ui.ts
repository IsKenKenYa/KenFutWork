import {
  codeUiRpcRequestSchema,
  codeUiRpcResponseSchema,
  codeUiSnapshotParamsSchema,
  codeUiWorkspaceListSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { AdminServiceError } from "../features/admin/admin-service.js";
import type { RequestAuthenticator } from "../features/auth/types.js";
import { CodeTerminalError } from "../features/code-terminal/service.js";
import { CodeAttachmentError } from "../features/code-ui/attachments/types.js";
import { CodeUiRepositoryError } from "../features/code-ui/repository.js";
import type { CodeUiService } from "../features/code-ui/service.js";
import { ExecutionScopeError } from "../features/execution/scope-service.js";
import { ModelProviderServiceError } from "../features/model-providers/model-provider-service.js";
import { PluginRegistryError } from "../features/plugins/plugin-registry-service.js";
import { ProjectServiceError } from "../features/projects/project-service.js";
import { isZodError } from "./zod-error.js";

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AdminServiceError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof PluginRegistryError)
    return reply
      .code(
        error.report
          ? 422
          : error.code === "system_plugin"
            ? 403
            : error.code === "plugin_not_found" ||
                error.code === "not_installed"
              ? 404
              : 400,
      )
      .send({
        error: {
          code: error.report ? "plugin_incompatible" : error.code,
          message: error.message,
        },
        ...(error.report ? { report: error.report } : {}),
      });
  if (error instanceof ProjectServiceError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof CodeAttachmentError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof ModelProviderServiceError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof CodeTerminalError)
    return reply.code(error.statusCode).send({
      error: { code: `code_terminal_${error.code}`, message: error.message },
    });
  if (error instanceof ExecutionScopeError)
    return reply
      .code(error.code === "path_denied" ? 404 : error.statusCode)
      .send({
        error: { code: `code_ui_${error.code}`, message: error.message },
      });
  if (isZodError(error))
    return reply.code(400).send({
      error: {
        code: "invalid_code_ui_request",
        message: "Code 宿主请求不符合原协议",
        details: error.issues,
      },
    });
  if (error instanceof CodeUiRepositoryError)
    return reply.code(error.code === "not_found" ? 404 : 409).send({
      error: { code: `code_ui_${error.code}`, message: error.message },
    });
  return reply.code(500).send({
    error: {
      code: "code_ui_error",
      message: error instanceof Error ? error.message : "Code 宿主请求失败",
    },
  });
}

export async function registerCodeUiRoutes(
  app: FastifyInstance,
  deps: { auth: RequestAuthenticator; service: CodeUiService },
) {
  app.addHook("preClose", async () => deps.service.closeConnections());
  app.get("/api/code-ui/events", async (request, reply) => {
    const user = await deps.auth.authenticate(request);
    if (!user)
      return reply
        .code(401)
        .send({ error: { code: "unauthenticated", message: "请先登录" } });
    const connection = await deps.service.openConnection(
      user,
      async (event) => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        // 等待底层回压消退，不另排无界帧队列；关闭时解除等待。
        if (!reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              reply.raw.off("drain", finish);
              reply.raw.off("close", finish);
              resolve();
            };
            reply.raw.once("drain", finish);
            reply.raw.once("close", finish);
          });
        }
      },
      () => reply.raw.end(),
    );
    reply.raw.once("close", () => {
      void connection
        .dispose()
        .catch((error: unknown) =>
          request.log.warn({ error }, "Code连接资源尚未确认关闭"),
        );
    });
    reply.hijack();
    for (const [key, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) reply.raw.setHeader(key, value);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
    reply.raw.write(
      `data: ${JSON.stringify({ event: "ready", hello: connection.hello, reconnectDelayMs: connection.reconnectDelayMs })}\n\n`,
    );
  });
  app.get("/api/code-ui/workspaces", async (request, reply) => {
    const user = await deps.auth.authenticate(request);
    if (!user)
      return reply
        .code(401)
        .send({ error: { code: "unauthenticated", message: "请先登录" } });
    try {
      return codeUiWorkspaceListSchema.parse({
        workspaces: await deps.service.listWorkspaces(user),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get("/api/code-ui/sessions/:sessionId", async (request, reply) => {
    const user = await deps.auth.authenticate(request);
    if (!user)
      return reply
        .code(401)
        .send({ error: { code: "unauthenticated", message: "请先登录" } });
    try {
      const { sessionId } = codeUiSnapshotParamsSchema.parse(request.params);
      return { snapshot: await deps.service.getSnapshot(user, sessionId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post("/api/code-ui/rpc", async (request, reply) => {
    const user = await deps.auth.authenticate(request);
    if (!user)
      return reply
        .code(401)
        .send({ error: { code: "unauthenticated", message: "请先登录" } });
    try {
      const { service, method, args, connectionId } =
        codeUiRpcRequestSchema.parse(request.body);
      const hostResult = await deps.service.hostRpc(
        user,
        service,
        method,
        args,
        connectionId,
      );
      if (hostResult) return codeUiRpcResponseSchema.parse(hostResult);
      if (service === "zcodeAgentService") {
        const prepared = await deps.service.transportRpc(
          user,
          connectionId,
          method,
          args,
        );
        if (prepared) {
          if (prepared.publish) {
            const publish = prepared.publish;
            let published = false;
            const publishAfterResponse = () => {
              if (published) return;
              published = true;
              reply.raw.off("finish", publishAfterResponse);
              reply.raw.off("close", publishAfterResponse);
              void publish().catch((error: unknown) =>
                request.log.warn({ error }, "Code 订阅通知失败"),
              );
            };
            // 输入已经持久认领，HTTP响应丢失不能把它留成永不派发的accepted状态。
            if (reply.raw.destroyed || reply.raw.writableEnded)
              publishAfterResponse();
            else {
              reply.raw.once("finish", publishAfterResponse);
              reply.raw.once("close", publishAfterResponse);
            }
          }
          return codeUiRpcResponseSchema.parse({ result: prepared.result });
        }
      }
      let result: unknown;
      if (service === "providerSettingsService" && method === "getView")
        result = (await deps.service.modelViews(user)).settings;
      else if (service === "modelSelectionService" && method === "getView") {
        const input = args[0] as
          | { selection?: protocol.SessionConfigState["modelSelection"] | null }
          | undefined;
        result = (await deps.service.modelViews(user, input?.selection))
          .selection;
      } else if (
        service === "zcodeAgentService" &&
        method === "sendConversationCommandV4"
      ) {
        const target = args[0] as { envelope?: unknown } | undefined;
        const parsed = protocol.parseCommandEnvelope(target?.envelope);
        if (!parsed.ok) throw parsed.error;
        if (parsed.envelope.type !== "createSession")
          return reply.code(501).send({
            error: {
              code: "code_ui_command_unavailable",
              message: `Code 命令 ${parsed.envelope.type} 尚未接通`,
            },
          });
        result = await deps.service.createSession(user, parsed.envelope);
      } else
        return reply.code(501).send({
          error: {
            code: "code_ui_method_unavailable",
            message: `Code 宿主接口 ${service}.${method} 尚未接通`,
          },
        });
      return codeUiRpcResponseSchema.parse({ result });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
