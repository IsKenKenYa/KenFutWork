import {
  flowLayoutParamsSchema,
  flowLayoutSnapshotSchema,
  flowLayoutWriteSchema,
  flowProjectFileMetadataSchema,
  flowProjectFileMoveSchema,
  flowProjectFileParamsSchema,
  flowProjectFileReceiptSchema,
  flowProjectFileUploadSchema,
  flowProjectFileVersionSchema,
} from "@kenfutwork/shared";
import type {
  FastifyContextConfig,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
} from "fastify";
import type { FlowProjectFiles } from "../features/flow/project-files.js";
import { authorizeFlowGateway } from "./flow-gateway-auth.js";
import { isZodError } from "./zod-error.js";

const MAX_BYTES = 250 * 1024 * 1024;
const callbackConfig: FastifyContextConfig & { skipLocalAccess: true } = {
  skipLocalAccess: true,
};

export async function registerFlowProjectFileRoutes(
  app: FastifyInstance,
  deps: { files: FlowProjectFiles; secret?: string | undefined },
) {
  const handler =
    (
      action: (
        token: string,
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<unknown>,
    ): RouteHandlerMethod =>
    async (request, reply) => {
      if (!authorizeFlowGateway(request, reply, deps.secret)) return;
      const token = request.headers["x-ff-project-binding"];
      if (typeof token !== "string" || !token || token.length > 2048)
        return reply.code(401).send({
          error: {
            code: "invalid_project_binding",
            message: "Flow 项目连接已失效，请重新选择项目。",
          },
        });
      try {
        return await action(token, request, reply);
      } catch (error) {
        if (isZodError(error))
          return reply.code(400).send({
            error: {
              code: "invalid_file_request",
              message: "Flow 文件参数无效。",
            },
          });
        // 服务错误只公开受控代码和用户文案，不把绑定或请求正文回显。
        if (
          error instanceof Error &&
          "statusCode" in error &&
          "code" in error &&
          typeof error.statusCode === "number" &&
          typeof error.code === "string"
        )
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } });
        throw error;
      }
    };
  app.post(
    "/api/flow/host/project-files/upload",
    { config: callbackConfig },
    handler(async (token, request, reply) => {
      const fields: Record<string, string> = {};
      let bytes: Buffer | undefined;
      for await (const part of request.parts({
        limits: { files: 1, fields: 4, parts: 5, fileSize: MAX_BYTES },
      })) {
        if (part.type === "file") {
          if (part.fieldname !== "file" || bytes)
            return reply.code(400).send({
              error: {
                code: "invalid_file_request",
                message: "请选择一个文件。",
              },
            });
          bytes = await part.toBuffer();
        } else {
          if (typeof part.value !== "string" || part.fieldname in fields)
            return reply.code(400).send({
              error: {
                code: "invalid_file_request",
                message: "Flow 文件参数无效。",
              },
            });
          fields[part.fieldname] = part.value;
        }
      }
      if (!bytes?.byteLength)
        return reply.code(400).send({
          error: { code: "invalid_file_request", message: "文件内容为空。" },
        });
      return flowProjectFileReceiptSchema.parse(
        await deps.files.upload(
          token,
          flowProjectFileUploadSchema.parse(fields),
          bytes,
        ),
      );
    }),
  );
  app.get(
    "/api/flow/host/project-files/:assetId/metadata",
    { config: callbackConfig },
    handler(async (token, request) => {
      const { assetId } = flowProjectFileParamsSchema.parse(request.params);
      return flowProjectFileMetadataSchema.parse(
        await deps.files.metadata(token, assetId),
      );
    }),
  );
  app.get(
    "/api/flow/host/project-files/:assetId",
    { config: callbackConfig },
    handler(async (token, request, reply) => {
      const { assetId } = flowProjectFileParamsSchema.parse(request.params);
      const { version } = flowProjectFileVersionSchema.parse(request.query);
      const bytes = await deps.files.read(token, assetId, version);
      const metadata = await deps.files.metadata(token, assetId);
      reply
        .type(metadata.mimeType)
        .header("etag", `"${version}"`)
        .header("accept-ranges", "bytes");
      const range = request.headers.range;
      if (!range) return reply.send(Buffer.from(bytes));
      const interval = fileRange(range, bytes.byteLength);
      if (!interval)
        return reply
          .code(416)
          .header("content-range", `bytes */${bytes.byteLength}`)
          .send();
      const { start, end } = interval;
      return reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${bytes.byteLength}`)
        .send(Buffer.from(bytes.subarray(start, end + 1)));
    }),
  );
  app.post(
    "/api/flow/host/project-files/:assetId/move",
    { config: callbackConfig },
    handler(async (token, request) => {
      const { assetId } = flowProjectFileParamsSchema.parse(request.params);
      return flowProjectFileReceiptSchema.parse(
        await deps.files.move(
          token,
          assetId,
          flowProjectFileMoveSchema.parse(request.body),
        ),
      );
    }),
  );
  app.delete(
    "/api/flow/host/project-files/:assetId",
    { config: callbackConfig },
    handler(async (token, request) => {
      const { assetId } = flowProjectFileParamsSchema.parse(request.params);
      const { version } = flowProjectFileVersionSchema.parse(request.query);
      await deps.files.remove(token, assetId, version);
      return { ok: true };
    }),
  );
  app.get(
    "/api/flow/host/project-files/layouts/:workflowId",
    { config: callbackConfig },
    handler(async (token, request, reply) => {
      const { workflowId } = flowLayoutParamsSchema.parse(request.params);
      const snapshot = await deps.files.readLayout(token, workflowId);
      if (!snapshot)
        return reply.code(404).send({
          error: {
            code: "file_missing",
            message: "工作流文件缺失，请重新关联。",
          },
        });
      return flowLayoutSnapshotSchema.parse(snapshot);
    }),
  );
  app.put(
    "/api/flow/host/project-files/layouts/:workflowId",
    { config: callbackConfig, bodyLimit: 4 * 1024 * 1024 },
    handler(async (token, request) => {
      const { workflowId } = flowLayoutParamsSchema.parse(request.params);
      return flowLayoutSnapshotSchema.parse(
        await deps.files.saveLayout(
          token,
          workflowId,
          flowLayoutWriteSchema.parse(request.body),
        ),
      );
    }),
  );
}

function fileRange(
  value: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0
      ? { start: Math.max(0, size - suffix), end: size - 1 }
      : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    start > end
  )
    return null;
  return { start, end: Math.min(end, size - 1) };
}
