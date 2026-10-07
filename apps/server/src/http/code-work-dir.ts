import {
  codeWorkDirResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { ProjectRepository } from "../features/projects/repository.js";

/**
 * Code 模式工作目录的**生效绑定**（只读）。
 *
 * 用途：无项目绑定时（工作台首页直接发话 / 对话未绑项目），run 的作用域解析到工作区
 * 隐藏的「Code 工作台」画布——若它被 `KENFUTWORK_CANVAS_WORK_DIRS` 映射到本机目录，
 * 界面必须把这个**生效目录与来源**显示出来；此前工作目录 chip 一律显示「未绑定工作目录」，
 * 而 agent 实际落在映射目录里，用户从界面上看不出差别（真机走查登记项）。
 *
 * 归属校验：映射读取按**本工作区的隐藏载体画布**取（不是让客户端随便报 canvasId），
 * 因此这里没有可枚举的输入——不泄露任何其它工作区/部署的映射情况。
 */
export async function registerCodeWorkDirRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    viewerService: ViewerService;
    projectRepository: Pick<ProjectRepository, "findCodeWorkbenchCanvas">;
    canvasWorkDirs?: Record<string, string> | undefined;
  },
) {
  app.get("/api/code/work-dir", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    /**
     * 只读端点与「runs/activity」同一口径：工作区解析失败**降级为 none**，不报错——
     * 这是一条显示辅助（界面据此把「未绑定」显示成生效目录），失败回落既有显示即可；
     * 解析失败本身也不该给账号/资源枚举留信号。
     */
    const workspace = await options.viewerService
      .resolveWorkspace(user)
      .catch(() => null);
    // 从未跑过 Code 的工作区还没有「Code 工作台」画布（不创建，纯读）；没有它就没有映射可报。
    const canvasId = workspace
      ? await options.projectRepository
          .findCodeWorkbenchCanvas(workspace.id)
          .catch(() => null)
      : null;
    const mapped = canvasId
      ? options.canvasWorkDirs?.[canvasId]?.trim()
      : undefined;
    return reply.code(200).send(
      codeWorkDirResponseSchema.parse({
        binding: mapped ? { source: "env", path: mapped } : { source: "none" },
      }),
    );
  });
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: { code: "unauthorized", message: "请先登录。" },
    }),
  );
}
