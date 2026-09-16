import {
  applicationErrorResponseSchema,
  codeGitBranchCreateRequestSchema,
  codeGitCheckoutRequestSchema,
  codeDocsResponseSchema,
  codeFilesResponseSchema,
  codeShellsResponseSchema,
  codeTerminalRequestSchema,
  codeTerminalResponseSchema,
  codeGitChangesResponseSchema,
  codeGitCommitRequestSchema,
  codeGitDiffResponseSchema,
  codeGitFileResponseSchema,
  codeGitDiffStatResponseSchema,
  codeGitGraphResponseSchema,
  codeGitStatusResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RequestAuthenticator } from "../features/auth/types.js";
import {
  CodeGitError,
  type CodeGitService,
} from "../features/code-git/code-git-service.js";

/**
 * Code 模式 git 分支视图路由（工作目录=项目）。
 *
 * 归属校验在 service 里（画布必须属于当前用户的工作区）；这里只做鉴权与错误映射。
 */
export async function registerCodeGitRoutes(
  app: FastifyInstance,
  options: { auth: RequestAuthenticator; codeGitService: CodeGitService },
) {
  app.get<{ Querystring: { canvasId?: string } }>(
    "/api/code/git",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_input", message: "缺少 canvasId。" },
          }),
        );
      }
      try {
        const git = await options.codeGitService.status(user, canvasId);
        return reply.code(200).send(codeGitStatusResponseSchema.parse({ git }));
      } catch (error) {
        return sendCodeGitError(error, reply);
      }
    },
  );

  app.post("/api/code/git/checkout", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    try {
      const payload = codeGitCheckoutRequestSchema.parse(request.body);
      const git = await options.codeGitService.checkout(
        user,
        payload.canvasId,
        payload.branch,
      );
      return reply.code(200).send(codeGitStatusResponseSchema.parse({ git }));
    } catch (error) {
      return sendCodeGitError(error, reply);
    }
  });

  // --- R2-1：更改统计 / 提交 / 推送 / 新建分支（写操作纪律在 service 里） ---

  app.get<{ Querystring: { canvasId?: string } }>(
    "/api/code/git/diff-stat",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_input", message: "缺少 canvasId。" },
          }),
        );
      }
      try {
        const stat = await options.codeGitService.diffStat(user, canvasId);
        return reply
          .code(200)
          .send(codeGitDiffStatResponseSchema.parse({ stat }));
      } catch (error) {
        return sendCodeGitError(error, reply);
      }
    },
  );

  // GET /api/code/git/graph — git 图谱（R2-1 条目 6）。条数上限由查询给，
  // 这里夹到 1..200：界面只画最近几十条，给个越界值不该让服务端去 log 十万行。
  app.get<{ Querystring: { canvasId?: string; limit?: string } }>(
    "/api/code/git/graph",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_input", message: "缺少 canvasId。" },
          }),
        );
      }
      const limit = clampGraphLimit(request.query.limit);
      try {
        const graph = await options.codeGitService.graph(user, canvasId, limit);
        return reply
          .code(200)
          .send(codeGitGraphResponseSchema.parse({ graph }));
      } catch (error) {
        return sendCodeGitError(error, reply);
      }
    },
  );

  // GET /api/code/git/changes — 变更文件清单（R3-2）：逐文件增删行数与状态
  app.get<{ Querystring: { canvasId?: string } }>(
    "/api/code/git/changes",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_input", message: "缺少 canvasId。" },
          }),
        );
      }
      try {
        const changes = await options.codeGitService.changes(
          user,
          canvasId,
          MAX_CHANGED_FILES,
        );
        return reply
          .code(200)
          .send(codeGitChangesResponseSchema.parse({ changes }));
      } catch (error) {
        return sendCodeGitError(error, reply);
      }
    },
  );

  // GET /api/code/git/diff?path= — 单文件差异（R3-2「审查」）
  app.get<{ Querystring: { canvasId?: string; path?: string } }>(
    "/api/code/git/diff",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      const path = request.query.path ?? "";
      if (!canvasId || !path) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "invalid_input",
              message: "缺少 canvasId 或 path。",
            },
          }),
        );
      }
      try {
        const diff = await options.codeGitService.fileDiff(user, canvasId, path);
        return reply.code(200).send(codeGitDiffResponseSchema.parse({ diff }));
      } catch (error) {
        return sendCodeGitError(error, reply);
      }
    },
  );

  // GET /api/code/file?path= — 工作目录里的单文件内容（R3-2「打开」/ R3-3「文档入口」）。
  // 与 git 同一作用域（沙箱工作目录）+ 同一套归属校验，故并在这里注册；读取本身只是
  // 受限的只读文本预览（路径必须落在工作目录内、只读前 256 KB、二进制只回元信息）。
  app.get<{ Querystring: { canvasId?: string; path?: string } }>(
    "/api/code/file",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      const path = request.query.path ?? "";
      if (!canvasId || !path) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "invalid_input",
              message: "缺少 canvasId 或 path。",
            },
          }),
        );
      }
      try {
        const file = await options.codeGitService.readFile(user, canvasId, path);
        return reply.code(200).send(codeGitFileResponseSchema.parse({ file }));
      } catch (error) {
        return sendCodeGitError(error, reply);
      }
    },
  );

  // GET /api/code/files — 工作目录的文件目录（R3-1「文件目录」标签）：只列一层
  app.get<{ Querystring: { canvasId?: string; path?: string } }>(
    "/api/code/files",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_input", message: "缺少 canvasId。" },
          }),
        );
      }
      try {
        const files = await options.codeGitService.listFiles(
          user,
          canvasId,
          request.query.path ?? "",
        );
        return reply.code(200).send(codeFilesResponseSchema.parse({ files }));
      } catch (error) {
        return sendCodeGitError(error, reply);
      }
    },
  );

  // POST /api/code/terminal — 在画布的工作目录里跑一条用户命令（R3-1「终端」标签）。
  // 权限口径见 features/code-git/terminal-runner.ts（用户自己的操作，不套 agent 工具门；
  // 但同样要求登录 + 画布归属，且固定 cwd、有超时与输出上限）。
  app.post("/api/code/terminal", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    try {
      const payload = codeTerminalRequestSchema.parse(request.body);
      const result = await options.codeGitService.runTerminal(
        user,
        payload.canvasId,
        payload.command,
        payload.shell,
      );
      return reply.code(200).send(codeTerminalResponseSchema.parse({ result }));
    } catch (error) {
      return sendCodeGitError(error, reply);
    }
  });

  // GET /api/code/shells — 本机可用的 shell + 工作区默认（终端下拉与设置页共用）。
  // 只要求登录：清单里带可执行文件路径，而能开这个终端的人本来就能 `where bash` 问出来，
  // 多藏一层只会让界面说不清「为什么这个选项不可用」。
  app.get("/api/code/shells", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    try {
      const shells = await options.codeGitService.listTerminalShells(user);
      return reply.code(200).send(codeShellsResponseSchema.parse(shells));
    } catch (error) {
      return sendCodeGitError(error, reply);
    }
  });

  // GET /api/code/docs — 工作目录里的项目文档清单（R3-3「文档入口」）
  app.get<{ Querystring: { canvasId?: string } }>(
    "/api/code/docs",
    async (request, reply) => {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const canvasId = request.query.canvasId ?? "";
      if (!canvasId) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: { code: "invalid_input", message: "缺少 canvasId。" },
          }),
        );
      }
      try {
        const docs = await options.codeGitService.listDocs(user, canvasId);
        return reply.code(200).send(codeDocsResponseSchema.parse({ docs }));
      } catch (error) {
        return sendCodeGitError(error, reply);
      }
    },
  );

  // POST /api/code/git/init — 初始化仓库（幂等）：让「每次对话用 git 跟踪」在
  // 非仓库目录上也能开始（分支 chip 里「非 Git 仓库」时提供入口）
  app.post("/api/code/git/init", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    try {
      const payload = codeGitCheckoutRequestSchema
        .pick({ canvasId: true })
        .parse(request.body);
      const git = await options.codeGitService.init(user, payload.canvasId);
      return reply.code(200).send(codeGitStatusResponseSchema.parse({ git }));
    } catch (error) {
      return sendCodeGitError(error, reply);
    }
  });

  app.post("/api/code/git/commit", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    try {
      const payload = codeGitCommitRequestSchema.parse(request.body);
      const git = await options.codeGitService.commit(
        user,
        payload.canvasId,
        payload.message,
      );
      return reply.code(200).send(codeGitStatusResponseSchema.parse({ git }));
    } catch (error) {
      return sendCodeGitError(error, reply);
    }
  });

  app.post("/api/code/git/push", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    try {
      const payload = codeGitCheckoutRequestSchema
        .pick({ canvasId: true })
        .parse(request.body);
      const git = await options.codeGitService.push(user, payload.canvasId);
      return reply.code(200).send(codeGitStatusResponseSchema.parse({ git }));
    } catch (error) {
      return sendCodeGitError(error, reply);
    }
  });

  app.post("/api/code/git/branch", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthorized(reply);
    try {
      const payload = codeGitBranchCreateRequestSchema.parse(request.body);
      const git = await options.codeGitService.createBranch(
        user,
        payload.canvasId,
        payload.name,
      );
      return reply.code(200).send(codeGitStatusResponseSchema.parse({ git }));
    } catch (error) {
      return sendCodeGitError(error, reply);
    }
  });
}

/**
 * 图谱条数上限：默认 30，非法值回落默认，越界夹到 1..200。
 *
 * 上限存在的意义不是性能（git log 很快），而是别让一个越界的 `limit` 把十万行
 * 塞进 WS/HTTP 响应里。
 */
function clampGraphLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(Math.max(parsed, 1), 200);
}

/** 变更清单一次最多列多少个文件（超出的截断并标注）。 */
const MAX_CHANGED_FILES = 200;

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendCodeGitError(error: unknown, reply: FastifyReply) {
  if (error instanceof CodeGitError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: { code: "application_error", message },
    }),
  );
}
