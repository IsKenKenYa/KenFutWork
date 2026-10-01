import type { ScreenshotResult } from "@kenfutwork/shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../kernel/types.js";
import type { ConnectionManager } from "../../../ws/connection-manager.js";
import type { BlobStore } from "../../blob/types.js";

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
 * （`ctx.tools`）贡献。截图 RPC 按用户路由（前端 canvas 页注册 handler），
 * 产物经 blob 缝换持久 URL——与运行时 persistImage 同一落盘规则。
 */
export function createScreenshotCanvasToolDefinition(deps: {
  connectionManager: ConnectionManager;
  blob?: BlobStore;
  rpcTimeout?: number;
}): ToolDefinition {
  const timeout = deps.rpcTimeout ?? 10_000;

  return {
    name: "screenshot_canvas",
    description:
      "Take a visual screenshot of the canvas to inspect layout, design quality, color harmony, and spatial relationships. Use this to visually verify your changes or understand the current canvas state. Supports full canvas, specific region, or current viewport capture.",
    scope: "design",
    zodSchema: screenshotCanvasSchema,
    parameters: z.toJSONSchema(screenshotCanvasSchema),
    execute: async (args, execCtx) => {
      const userId = execCtx.userId;

      if (typeof userId !== "string" || !userId) {
        return JSON.stringify({
          error: "no_user_context",
          message:
            "screenshot_canvas requires a user context to communicate with the browser.",
        });
      }

      const input = screenshotCanvasSchema.parse(args);

      try {
        const result = await deps.connectionManager.rpc<ScreenshotResult>(
          userId,
          "canvas.screenshot",
          {
            mode: input.mode,
            ...(input.region ? { region: input.region } : {}),
            max_dimension: input.max_dimension,
          },
          timeout,
        );

        // Upload screenshot to storage to get a short HTTPS URL.
        // Returning the raw data: URI (~1-2 MB base64) in the ToolMessage
        // would be serialized as text by LangChain adapters (Google Gemini,
        // OpenAI) since tool responses only support string content — this
        // causes the conversation to instantly exceed the model's token limit.
        // Pattern: same as generate_image — short URL in JSON, stream-adapter
        // extracts screenshotUrl as a frontend artifact.
        let screenshotUrl: string | undefined;
        if (deps.blob) {
          try {
            screenshotUrl = await persistImageViaBlob(
              deps.blob,
              execCtx.workspaceId ?? "default",
              result.url,
              "image/png",
              `canvas-screenshot-${input.mode}`,
            );
          } catch {
            // Non-fatal: fall back to text-only summary
          }
        }

        const output: Record<string, unknown> = {
          summary: `Canvas screenshot captured (${result.width}x${result.height}, mode: ${input.mode})`,
          width: result.width,
          height: result.height,
        };

        if (screenshotUrl) {
          output.screenshotUrl = screenshotUrl;
        }

        return JSON.stringify(output);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Screenshot failed";
        return JSON.stringify({
          error: "screenshot_failed",
          message: `Screenshot failed: ${message}`,
        });
      }
    },
  };
}

/**
 * 截图产物落盘（与 runtime 的 persistImage 同一规则）：下载 → 按工作区前缀
 * 上传 project-assets → 换持久 URL。工作区缺省 "default" 与运行时口径一致。
 */
async function persistImageViaBlob(
  blob: BlobStore,
  workspaceId: string,
  sourceUrl: string,
  mimeType: string,
  prompt: string,
): Promise<string> {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = mimeType === "image/webp" ? "webp" : "png";
  const slug = prompt
    .slice(0, 40)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const fileName = `gen-${slug}-${Date.now()}.${ext}`;
  const objectPath = `${workspaceId}/${Date.now()}-${fileName}`;

  const assetBucket = blob.bucket("project-assets");
  await assetBucket.upload(objectPath, buffer, {
    contentType: mimeType,
    upsert: false,
  });

  // 公开性由存储侧回答（实测 project-assets 可能非公开）
  return assetBucket.resolveUrl(objectPath);
}
