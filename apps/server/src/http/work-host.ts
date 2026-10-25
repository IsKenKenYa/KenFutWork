import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  unauthenticatedErrorResponseSchema,
  type WorkEditor,
  type WorkHostEditorsResponse,
  type WorkHostStatusResponse,
  workEditorSchema,
  workHostEditorsResponseSchema,
  workHostStatusResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import { listWorkEditorRegistrations } from "../features/work/registry.js";

/**
 * work 宿主适配层路由（`/api/work/host/*`）。
 *
 * 能力缝三元组（W1）：
 * - Service Definition：`packages/shared/src/work-host.ts`（探针 + 注册表响应形状）；
 * - Service Provider：本路由（注册表事实 + 扩展包数据目录落位检查）；
 * - Consumer：工作台 Work 模式入口门控与「Work 引擎」信息页（`WorkSurface`）。
 *
 * 路由始终注册：status 是能力探针，如实回答启用状态与原因；编辑器 `installed`
 * 按数据目录落位事实计算（W1 无下载器，恒 false——不假装能装）。
 */
export async function registerWorkHostRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    editors: {
      /** 返回带落位事实的注册表（`installed` 按数据目录计算）。 */
      list(): WorkEditor[];
    };
    /** 扩展包数据目录（信息页如实展示；W2 下载器落位在这里）。 */
    dataDir: string;
  },
): Promise<void> {
  const unauthorized = (reply: FastifyReply, message: string) =>
    reply.code(401).send(
      unauthenticatedErrorResponseSchema.parse({
        error: { code: "unauthorized", message },
      }),
    );
  const requireLocalAccess = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (await options.localAccess.authenticate(request)) return true;
    unauthorized(reply, "本机接入凭据缺失或无效。");
    return false;
  };

  app.get("/api/work/host/status", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    const body: WorkHostStatusResponse = workHostStatusResponseSchema.parse({
      enabled: true,
      registeredEditors: options.editors.list().length,
      reasons: [],
    });
    return reply.send(body);
  });

  app.get("/api/work/host/editors", async (request, reply) => {
    if (!(await requireLocalAccess(request, reply))) return;
    const body: WorkHostEditorsResponse = workHostEditorsResponseSchema.parse({
      editors: options.editors.list(),
      dataDir: options.dataDir,
    });
    return reply.send(body);
  });
}

/**
 * 计算注册表的落位事实：扩展包目录 `<dataDir>/work/editors/<id>` 存在即视为
 * 已落位（W2 下载器以「目录完整 + 校验和通过」为落位口径，本检查与之对齐）。
 */
export function resolveInstalledEditors(input: {
  editorsDir: string;
}): WorkEditor[] {
  return listWorkEditorRegistrations().map((registration) => {
    const installed = existsSync(join(input.editorsDir, registration.id));
    return workEditorSchema.parse({ ...registration, installed });
  });
}
