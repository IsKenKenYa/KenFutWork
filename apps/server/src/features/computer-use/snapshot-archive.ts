import { createHash } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { ToolExecutionContext } from "../../kernel/types.js";
import type { BlobStore } from "../blob/types.js";
import type { LocalActor } from "../local-instance/types.js";
import type { PersistenceService } from "../persistence/types.js";
import type { CuToolResult } from "./service.js";

export interface CuSnapshotArchive {
  project(
    result: CuToolResult,
    context: ToolExecutionContext,
  ): Promise<CuToolResult>;
  read(
    actor: LocalActor,
    taskId: string,
    digest: string,
    maxBytes: number,
  ): Promise<Uint8Array | undefined>;
}

/** 大图走既有blob服务和受鉴权的Task读取，模型/MCP仍得到原PNG，不受UI内联限额裁剪。 */
export function createCuSnapshotArchive(deps: {
  blob: BlobStore;
  persistence: PersistenceService;
}): CuSnapshotArchive {
  const bucket = deps.blob.bucket("computer-use-snapshots");
  const path = (instanceId: string, taskId: string, digest: string) =>
    `${instanceId}/${taskId}/${digest}.png`;
  return {
    async project(result, context) {
      const display = result.display;
      if (!display || !Array.isArray(display.media)) return result;
      const scope = context.scopeHandle?.describe();
      const replacements = new Map<string, string>();
      const media: unknown[] = [];
      for (const item of display.media) {
        if (
          !item ||
          typeof item !== "object" ||
          typeof item.data !== "string" ||
          protocol.toolOutputSchema.parse({
            text: "",
            display: {
              kind: "cua",
              schemaVersion: 1,
              toolName: display.toolName,
              status: display.status,
              media: [item],
            },
          }).display !== undefined
        ) {
          media.push(item);
          continue;
        }
        if (
          !scope ||
          !context.actor ||
          context.actor.instanceId !== scope.instanceId ||
          !context.runId ||
          !context.toolCallId ||
          item.mimeType !== "image/png"
        )
          throw new Error("大图归档缺少可信Task或PNG结果。");
        const digest: string = createHash("sha256")
          .update(`${context.runId}\0${context.toolCallId}\0${media.length}`)
          .digest("hex");
        await bucket.upload(
          path(scope.instanceId, scope.taskId, digest),
          Buffer.from(item.data, "base64"),
          { contentType: "image/png", upsert: true },
        );
        const uri: string = `/api/computer-use/snapshots?taskId=${scope.taskId}&digest=${digest}`;
        replacements.set(item.data, uri);
        media.push({ mimeType: item.mimeType, artifactUri: uri });
      }
      if (!replacements.size) return result;
      const canonical = result.canonicalOutput;
      const structured = { ...canonical?.structuredContent };
      const image = structured.image;
      if (image && typeof image === "object" && !Array.isArray(image)) {
        const { data, ...metadata } = image as Record<string, unknown>;
        structured.image = {
          ...metadata,
          ...(typeof data === "string"
            ? { artifactUri: replacements.get(data) }
            : {}),
        };
      }
      return {
        ...result,
        display: { ...display, media },
        ...(canonical
          ? {
              canonicalOutput: {
                ...canonical,
                structuredContent: structured,
                content: canonical.content.map((block) =>
                  block.type === "image" && replacements.has(block.data)
                    ? {
                        type: "text" as const,
                        text: `[Attached ${block.mimeType}: ${replacements.get(block.data)}]`,
                      }
                    : block,
                ),
              },
            }
          : {}),
      };
    },
    async read(actor, taskId, digest, maxBytes) {
      const task = await deps.persistence
        .forInstance(actor.instanceId)
        .queryOne(
          "select id from public.code_ui_sessions where instance_id=:instance and id=$1 and deleted_at is null",
          [taskId],
        );
      if (!task) return undefined;
      try {
        return await bucket.download(path(actor.instanceId, taskId, digest), {
          maxBytes,
        });
      } catch {
        return undefined;
      }
    },
  };
}
