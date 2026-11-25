import {
  type ApplicationErrorResponse,
  applicationErrorResponseSchema,
  permissionAuditEntrySchema,
  permissionPolicySchema,
  permissionRulesSchema,
  permissionTierSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { PermissionAuditStore } from "../features/permissions/audit-store.js";
import type { PermissionService } from "../features/permissions/permission-service.js";
import type { PermissionSettingsStore } from "../features/permissions/tier-store.js";
import { describeErrorDetail } from "../utils/error-sanitizer.js";

const saveFailureMessages = {
  settings: "权限设置未保存，原设置仍有效，请稍后再试。",
  approval: "永久批准未保存，当前仍有效，请稍后再试。",
};

function sendSaveFailure(
  reply: FastifyReply,
  operation: keyof typeof saveFailureMessages,
  error: unknown,
) {
  reply.log.error(
    { operation, detail: describeErrorDetail(error) },
    "权限配置写入失败",
  );
  const body: ApplicationErrorResponse = {
    error: { code: "settings_failed", message: saveFailureMessages[operation] },
  };
  return reply.code(500).send(applicationErrorResponseSchema.parse(body));
}

export async function registerPermissionRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    permissions: PermissionService;
    /** 设置写穿（app_config）；缺省时仅内存生效（部分装配/单测）。 */
    tierStore?: PermissionSettingsStore;
    /** 审计中心落库；缺省时不提供审计端点（部分装配/单测）。 */
    auditStore?: PermissionAuditStore;
  },
) {
  // GET /api/permissions/tier — 当前权限设置（档位 / 自动化档位 / 自定义规则 / 浏览器控制）
  app.get("/api/permissions/tier", async (request, reply) => {
    const user = await options.localAccess.authenticate(request);
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
    const settings = options.permissions.getSettings();
    return reply.code(200).send({
      tier: permissionTierSchema.parse(settings.tier),
      automationTier: permissionTierSchema.parse(settings.automationTier),
      rules: permissionRulesSchema.parse(settings.rules),
      policy: permissionPolicySchema.parse(settings.policy),
      browserControlEnabled: settings.browserControlEnabled,
      browserAutoScreenshot: settings.browserAutoScreenshot,
      browserHeadless: settings.browserHeadless,
      browserDevtoolsReadEnabled: settings.browserDevtoolsReadEnabled,
      browserEvalEnabled: settings.browserEvalEnabled,
      approvedForever: options.permissions.listApprovedForever(),
    });
  });

  // PUT /api/permissions/tier — 部分更新（只改送来的字段；写库失败即不改内存）
  app.put("/api/permissions/tier", async (request, reply) => {
    const user = await options.localAccess.authenticate(request);
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
    const body = (request.body ?? {}) as {
      tier?: unknown;
      automationTier?: unknown;
      rules?: unknown;
      policy?: unknown;
      browserControlEnabled?: unknown;
      browserAutoScreenshot?: unknown;
      browserHeadless?: unknown;
      browserDevtoolsReadEnabled?: unknown;
      browserEvalEnabled?: unknown;
    };
    const current = options.permissions.getSettings();
    let next = { ...current };
    try {
      if (body.tier !== undefined) {
        next = { ...next, tier: permissionTierSchema.parse(body.tier) };
      }
      if (body.automationTier !== undefined) {
        next = {
          ...next,
          automationTier: permissionTierSchema.parse(body.automationTier),
        };
      }
      if (body.rules !== undefined) {
        next = { ...next, rules: permissionRulesSchema.parse(body.rules) };
      }
      if (body.policy !== undefined) {
        next = { ...next, policy: permissionPolicySchema.parse(body.policy) };
      }
      if (body.browserControlEnabled !== undefined) {
        next = {
          ...next,
          browserControlEnabled: body.browserControlEnabled === true,
        };
      }
      if (body.browserAutoScreenshot !== undefined) {
        next = {
          ...next,
          browserAutoScreenshot: body.browserAutoScreenshot === true,
        };
      }
      if (body.browserHeadless !== undefined) {
        next = { ...next, browserHeadless: body.browserHeadless === true };
      }
      if (body.browserDevtoolsReadEnabled !== undefined) {
        next = {
          ...next,
          browserDevtoolsReadEnabled: body.browserDevtoolsReadEnabled === true,
        };
      }
      if (body.browserEvalEnabled !== undefined) {
        next = {
          ...next,
          browserEvalEnabled: body.browserEvalEnabled === true,
        };
      }
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid permission settings.",
          },
        }),
      );
    }
    // 先写库再改内存：写失败即 500（静默漂移正是本次要消灭的故障形态——
    // 内存保持旧档，UI 与服务端不会出现「显示已放行、实际 default」的分裂）
    if (options.tierStore) {
      try {
        await options.tierStore.save(next);
      } catch (error) {
        return sendSaveFailure(reply, "settings", error);
      }
    }
    options.permissions.applySettings(next);
    // 与 GET 同一形状（缺字段会让客户端把整个设置对象覆盖成缺键的——实测把权限页打崩过）
    return reply.code(200).send({
      tier: next.tier,
      automationTier: next.automationTier,
      rules: next.rules,
      policy: next.policy,
      browserControlEnabled: next.browserControlEnabled,
      browserAutoScreenshot: next.browserAutoScreenshot,
      browserHeadless: next.browserHeadless,
      browserDevtoolsReadEnabled: next.browserDevtoolsReadEnabled,
      browserEvalEnabled: next.browserEvalEnabled,
      approvedForever: options.permissions.listApprovedForever(),
    });
  });

  // POST /api/permissions/approve — 人审放行（agent 无自我授权路径）
  app.post("/api/permissions/approve", async (request, reply) => {
    const user = await options.localAccess.authenticate(request);
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
    try {
      const body = request.body as {
        toolName?: string;
        scope?: "once" | "thread" | "forever";
        threadId?: string;
      };
      if (!body.toolName) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_request", message: "toolName required." },
          }),
        );
      }
      options.permissions.approve(body.toolName, {
        scope: body.scope ?? "once",
        ...(body.threadId ? { threadId: body.threadId } : {}),
      });
      // 「永久」批准写穿持久化（与 PUT tier 同一纪律：写失败如实报错，不静默降级
      // ——内存已生效，但 UI 承诺的「永久」落不了盘必须让用户知道）。
      if (body.scope === "forever" && options.tierStore) {
        try {
          await options.tierStore.save(options.permissions.getSettings());
        } catch (error) {
          return sendSaveFailure(reply, "approval", error);
        }
      }
      return reply.code(204).send();
    } catch (error) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: error instanceof Error ? error.message : "Invalid body.",
          },
        }),
      );
    }
  });

  // GET /api/permissions/audit — 审计中心的最近记录（新的在前）
  app.get("/api/permissions/audit", async (request, reply) => {
    const user = await options.localAccess.authenticate(request);
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
    if (!options.auditStore) {
      return reply.code(404).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "not_found",
            message: "审计中心未启用。",
          },
        }),
      );
    }
    const query = request.query as { limit?: string };
    const limit = Number.parseInt(query.limit ?? "", 10);
    const entries = await options.auditStore.list(
      Number.isFinite(limit) ? { limit } : {},
    );
    return reply.code(200).send({
      entries: entries.map((entry) => permissionAuditEntrySchema.parse(entry)),
    });
  });

  // DELETE /api/permissions/audit — 清空记录
  app.delete("/api/permissions/audit", async (request, reply) => {
    const user = await options.localAccess.authenticate(request);
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
    if (!options.auditStore) {
      return reply.code(404).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "not_found",
            message: "审计中心未启用。",
          },
        }),
      );
    }
    await options.auditStore.clear();
    return reply.code(204).send();
  });
}
