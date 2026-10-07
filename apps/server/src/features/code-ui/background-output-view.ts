import { StringDecoder } from "node:string_decoder";
import {
  codeUiViewerScopeSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import {
  BACKGROUND_BASH_OUTPUT_MAX_BYTES,
  backgroundBashOutputResultSchema,
} from "@zcode/shared";
import { z } from "zod";
import type { LocalActor } from "../local-instance/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import type { CodeUiOutputHistory } from "./output-history-types.js";
import { CodeUiRepositoryError } from "./repository.js";
import type { CodeUiService } from "./service.js";

type Loaded = Awaited<ReturnType<CodeUiService["loadConversation"]>>;
const locationSchema = z.object({
  workspacePath: z.string().min(1),
  projectId: z.string().optional(),
  workspaceIdentity: z.string().optional(),
  sessionId: z.string().min(1),
  workId: z.string().min(1),
});
const fileSchema = z.object({
  path: z.string().min(1),
  viewerScope: codeUiViewerScopeSchema,
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().optional(),
});
const resourceSchema = z.object({ taskId: z.uuid(), id: z.uuid() });
const missing = (message: string) =>
  new CodeUiRepositoryError("not_found", message);

function previewResult(
  workId: string,
  value: Awaited<ReturnType<CodeUiOutputHistory["readView"]>>,
) {
  if (value?.kind !== "command")
    return backgroundBashOutputResultSchema.parse({
      kind: value ? "unsupported" : "unavailable",
      workId,
    });
  const bytes = Buffer.from(value.bytes);
  const output =
    value.status === "running"
      ? new StringDecoder("utf8").write(bytes)
      : bytes.toString("utf8");
  return backgroundBashOutputResultSchema.parse({
    kind: "output",
    workId,
    status:
      value.status === "canceled" || value.status === "interrupted"
        ? "cancelled"
        : value.status,
    output,
    truncated:
      value.offset > 0 ||
      value.discardedBytes > 0 ||
      Buffer.byteLength(output) < bytes.length,
    outputPath: value.outputRef,
  });
}

export function createCodeUiBackgroundOutputView(deps: {
  load(actor: LocalActor, sessionId: string): Promise<Loaded>;
  outputs: Pick<CodeUiOutputHistory, "readView">;
  settings: Pick<SettingsService, "getInstanceSettings">;
}) {
  return {
    async query(actor: LocalActor, raw: unknown) {
      const location = locationSchema.parse(raw);
      const parsed = protocol.v4BackgroundBashOutputParamsSchema.parse({
        sessionId: location.sessionId,
        workId: location.workId,
      });
      const loaded = await deps.load(actor, parsed.sessionId);
      if (
        location.workspacePath !== loaded.project.path ||
        (location.projectId &&
          location.projectId !== loaded.project.projectId) ||
        (location.workspaceIdentity &&
          location.workspaceIdentity !==
            JSON.stringify([loaded.project.projectId, loaded.project.path]))
      )
        throw missing("后台日志不属于该Task固定目录。");
      const limits = await deps.settings.getInstanceSettings(
        actor,
        loaded.instanceId,
      );
      const workId = parsed.workId;
      let result: Awaited<ReturnType<CodeUiOutputHistory["readView"]>>;
      try {
        result = await deps.outputs.readView(actor, loaded.root, workId, {
          offset: 0,
          maxBytes: Math.min(
            limits.codeReadMaxBytes,
            // UTF-8每码点最多四字节；预览预算仍由实例设置持有。
            limits.processPreviewMaxChars * 4,
            BACKGROUND_BASH_OUTPUT_MAX_BYTES,
          ),
          tail: true,
        });
      } catch (cause) {
        const code =
          cause instanceof Error &&
          "code" in cause &&
          typeof cause.code === "string"
            ? cause.code
            : undefined;
        return {
          result: backgroundBashOutputResultSchema.parse({
            kind: "read_failed",
            workId,
            ...(code ? { code } : {}),
          }),
        };
      }
      return { result: previewResult(workId, result) };
    },
    async file(actor: LocalActor, method: string, raw: unknown) {
      if (
        !raw ||
        typeof raw !== "object" ||
        !("path" in raw) ||
        typeof raw.path !== "string" ||
        !raw.path.startsWith("code-output:")
      )
        return null;
      const params = fileSchema.parse(raw);
      const parts = params.path.slice("code-output:".length).split("/");
      const ref = resourceSchema.safeParse({ taskId: parts[0], id: parts[1] });
      if (!ref.success || parts.length !== 2)
        throw missing("私有日志引用无效。");
      const loaded = await deps.load(actor, ref.data.taskId);
      if (
        (params.viewerScope.kind === "task" &&
          params.viewerScope.taskId !== loaded.root.id) ||
        (params.viewerScope.kind === "project" &&
          params.viewerScope.projectId !== loaded.root.project_id)
      )
        throw missing("私有日志不属于当前查看工作域。");
      if (
        !["readTextFile", "readFileRange", "stat", "resolvePath"].includes(
          method,
        )
      )
        throw missing("私有日志仅提供只读文本及字节分页。");
      const limits = await deps.settings.getInstanceSettings(
        actor,
        loaded.instanceId,
      );
      const result = await deps.outputs.readView(
        actor,
        loaded.root,
        ref.data.id,
        {
          offset: params.offset,
          maxBytes: Math.min(
            params.length ?? params.maxBytes ?? limits.codeReadMaxBytes,
            limits.codeReadMaxBytes,
          ),
          tail: false,
        },
      );
      if (!result || result.outputRef !== params.path)
        throw missing("私有日志引用不存在或已清理。");
      if (method === "resolvePath") return { result: params.path };
      if (method === "stat")
        return {
          result: {
            path: params.path,
            type: "file",
            size: result.retainedBytes,
          },
        };
      const bytes = Buffer.from(result.bytes);
      if (method === "readFileRange")
        return {
          result: { encoding: "base64", data: bytes.toString("base64") },
        };
      const isBinary = bytes.includes(0);
      return {
        result: {
          path: params.path,
          content: isBinary ? "" : bytes.toString("utf8"),
          offset: result.offset,
          bytesRead: bytes.length,
          totalBytes: result.retainedBytes,
          truncated:
            result.offset + bytes.length < result.retainedBytes ||
            result.discardedBytes > 0,
          isBinary,
        },
      };
    },
  };
}
