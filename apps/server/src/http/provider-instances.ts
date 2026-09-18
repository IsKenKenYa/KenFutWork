import {
  applicationErrorResponseSchema,
  providerInstanceCreateRequestSchema,
  providerInstanceListResponseSchema,
  providerInstanceResponseSchema,
  providerInstanceUpdateRequestSchema,
  providerPresetListResponseSchema,
  providerProbeResultSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import {
  type ModelProviderService,
  ModelProviderServiceError,
} from "../features/model-providers/model-provider-service.js";
import { describeZodIssues, isZodError } from "./zod-error.js";

/**
 * 请求体校验失败 → 400（而非 500）：契约层把「非法头名 / 保留头 / CRLF / 白名单外占位符」
 * 都做成了写入时拒绝（§4.8 fail loud），若落入 500 兜底，用户只会看到
 * 「Internal provider error.」——既误导（把客户端错误报成服务端故障），又丢掉原因。
 * 消息由 `describeZodIssues` 生成：只回字段路径与规则，不回显收到的值。
 */
function sendError(
  error: unknown,
  reply: FastifyReply,
  fallbackCode: string,
): FastifyReply {
  if (isZodError(error)) {
    return reply.code(400).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: describeZodIssues(error.issues),
        },
      }),
    );
  }
  if (error instanceof ModelProviderServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: { code: fallbackCode, message: "Internal provider error." },
    }),
  );
}

export async function registerProviderInstanceRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    modelProviders: ModelProviderService;
  },
) {
  // GET /api/provider-instances — 列出实例（凭证红线：只含 hasCredential）
  app.get("/api/provider-instances", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) {
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "Missing or invalid bearer token.",
            },
          }),
        );
      }
      const instances = await options.modelProviders.listInstances(user);
      return reply
        .code(200)
        .send(providerInstanceListResponseSchema.parse({ instances }));
    } catch (error) {
      return sendError(error, reply, "instance_query_failed");
    }
  });

  // POST /api/provider-instances — 创建实例（apiKey 只写）
  app.post("/api/provider-instances", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) {
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "Missing or invalid bearer token.",
            },
          }),
        );
      }
      const input = providerInstanceCreateRequestSchema.parse(request.body);
      const instance = await options.modelProviders.createInstance(user, input);
      return reply
        .code(201)
        .send(providerInstanceResponseSchema.parse(instance));
    } catch (error) {
      return sendError(error, reply, "instance_create_failed");
    }
  });

  // PATCH /api/provider-instances/:instanceId — 更新（apiKey 缺省即不改，更新即覆盖）
  app.patch("/api/provider-instances/:instanceId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) {
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "Missing or invalid bearer token.",
            },
          }),
        );
      }
      const { instanceId } = request.params as { instanceId: string };
      const input = providerInstanceUpdateRequestSchema.parse(request.body);
      const instance = await options.modelProviders.updateInstance(
        user,
        instanceId,
        input,
      );
      return reply
        .code(200)
        .send(providerInstanceResponseSchema.parse(instance));
    } catch (error) {
      return sendError(error, reply, "instance_update_failed");
    }
  });

  // GET /api/provider-instances/presets — models.dev 供应商预设（供应商设置
  // 「从预设选择」）：非权威 UI 数据，capability 由模态推导，用户可改。
  app.get("/api/provider-instances/presets", async (_request, reply) => {
    return reply
      .code(200)
      .send(
        providerPresetListResponseSchema.parse({
          presets: options.modelProviders.listProviderPresets(),
        }),
      );
  });

  // POST /api/provider-instances/:instanceId/probe — 能力探测（阶段 E）：
  // 连通性 + 中转方言四探测项，结果缓存到实例（运行期据此裁剪请求，fail open）。
  app.post(
    "/api/provider-instances/:instanceId/probe",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) {
          return reply.code(401).send(
            unauthenticatedErrorResponseSchema.parse({
              error: {
                code: "unauthorized",
                message: "Missing or invalid bearer token.",
              },
            }),
          );
        }
        const { instanceId } = request.params as { instanceId: string };
        const result = await options.modelProviders.probeInstance(
          user,
          instanceId,
        );
        return reply.code(200).send(providerProbeResultSchema.parse(result));
      } catch (error) {
        return sendError(error, reply, "instance_probe_failed");
      }
    },
  );

  // DELETE /api/provider-instances/:instanceId
  app.delete("/api/provider-instances/:instanceId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) {
        return reply.code(401).send(
          unauthenticatedErrorResponseSchema.parse({
            error: {
              code: "unauthorized",
              message: "Missing or invalid bearer token.",
            },
          }),
        );
      }
      const { instanceId } = request.params as { instanceId: string };
      await options.modelProviders.deleteInstance(user, instanceId);
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply, "instance_delete_failed");
    }
  });
}
