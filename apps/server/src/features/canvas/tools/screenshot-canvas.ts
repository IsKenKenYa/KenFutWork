import { createHash, randomUUID } from "node:crypto";
import { screenshotResultSchema } from "@kenfutwork/shared";
import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../../kernel/types.js";
import type { ConnectionManager } from "../../../ws/connection-manager.js";
import type { BlobStore } from "../../blob/types.js";
import type { LocalInstanceService } from "../../local-instance/types.js";
import type { ProjectFileService } from "../../project-files/types.js";
import { resolveCanvasActor } from "../canvas-actor.js";
import type { CanvasDocumentAccess } from "../document-access.js";

const screenshotCanvasSchema = z.object({
  mode: z
    .enum(["full", "region", "viewport"])
    .describe(
      "full: all elements; region: specific area; viewport: current user view",
    ),
  region: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional()
    .describe("Required when mode is 'region'. Defines the crop rectangle."),
  max_dimension: z
    .number()
    .default(1024)
    .describe(
      "Max width or height in pixels. 512=low, 1024=medium, 2048=high quality",
    ),
});

/**
 * `screenshot_canvas`（design preset）：画布视觉验证工具，经内核工具注册表
 * （`ctx.tools`）贡献。RPC 只发给 Task 绑定画布，产物写入 Task 项目文件。
 */
export function createScreenshotCanvasToolDefinition(deps: {
  connectionManager: ConnectionManager;
  localInstance: LocalInstanceService;
  documentAccess: Pick<CanvasDocumentAccess, "authorize">;
  blob: BlobStore;
  projectFiles: Pick<ProjectFileService, "prepareWrite">;
  rpcTimeout?: number;
}): ToolDefinition {
  const timeout = deps.rpcTimeout ?? 10_000;

  return {
    name: "screenshot_canvas",
    description:
      "Take a visual screenshot of the canvas to inspect layout, design quality, color harmony, and spatial relationships. Use this to visually verify your changes or understand the current canvas state. Supports full canvas, specific region, or current viewport capture.",
    scope: "design",
    access: "write",
    zodSchema: screenshotCanvasSchema,
    parameters: z.toJSONSchema(screenshotCanvasSchema),
    execute: async (args, execCtx) => {
      const actor = await resolveCanvasActor(
        deps.localInstance,
        execCtx,
        deps.documentAccess,
      );
      const instanceId = actor.instanceId;
      const canvasId = execCtx.canvasId;
      if (!canvasId) throw new Error("截图缺少Task绑定的画布。");

      const input = screenshotCanvasSchema.parse(args);

      try {
        const result = screenshotResultSchema.parse(
          await deps.connectionManager.rpcCanvas(
            instanceId,
            canvasId,
            "canvas.screenshot",
            {
              mode: input.mode,
              ...(input.region ? { region: input.region } : {}),
              max_dimension: input.max_dimension,
            },
            timeout,
          ),
        );

        // Upload screenshot to storage to get a short HTTPS URL.
        // Returning the raw data: URI (~1-2 MB base64) in the ToolMessage
        // would be serialized as text by LangChain adapters (Google Gemini,
        // OpenAI) since tool responses only support string content — this
        // causes the conversation to instantly exceed the model's token limit.
        // Pattern: same as generate_image — short URL in JSON, stream-adapter
        // extracts screenshotUrl as a frontend artifact.
        const stored = await persistImageViaBlob(deps, execCtx, result.url);

        const output: Record<string, unknown> = {
          summary: `Canvas screenshot captured (${result.width}x${result.height}, mode: ${input.mode})`,
          width: result.width,
          height: result.height,
        };

        output.screenshotUrl = stored.url;
        output.assetId = stored.assetId;
        output.relativePath = stored.relativePath;

        return JSON.stringify(output);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Screenshot failed";
        throw new Error(`画布截图失败：${message}`, { cause: error });
      }
    },
  };
}

/**
 * 截图产物通过项目文件端口登记，写入前后复验当前 Task 与 Run 授权。
 */
async function persistImageViaBlob(
  deps: Parameters<typeof createScreenshotCanvasToolDefinition>[0],
  context: ToolExecutionContext,
  sourceUrl: string,
) {
  const data = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
    sourceUrl,
  );
  if (!data?.[1]) throw new Error("截图返回了无效的PNG数据。");
  const buffer = Buffer.from(data[1], "base64");
  if (buffer.toString("base64") !== data[1])
    throw new Error("截图PNG编码无效。");
  const authorize = async () => {
    const actor = await resolveCanvasActor(
      deps.localInstance,
      context,
      deps.documentAccess,
    );
    await context.scopeHandle?.resolvePath(".", "write");
    return actor;
  };
  const actor = await authorize();
  const scope = context.scopeHandle;
  if (!scope) throw new Error("截图缺少真实Task。");
  const assetId = randomUUID();
  const receipt = await deps.projectFiles.prepareWrite(actor, {
    target: { kind: "task", taskId: scope.describe().taskId },
    assetId,
    relativePath: `canvas-screenshot-${assetId}.png`,
    mimeType: "image/png",
    writeFingerprint: createHash("sha256").update(buffer).digest("hex"),
  });
  await authorize();
  const assetBucket = deps.blob.bucket(receipt.bucket);
  await assetBucket.upload(receipt.objectPath, buffer, {
    contentType: "image/png",
    upsert: false,
  });

  // 公开性由存储侧回答（实测 project-assets 可能非公开）
  await authorize();
  return { ...receipt, url: await assetBucket.resolveUrl(receipt.objectPath) };
}
