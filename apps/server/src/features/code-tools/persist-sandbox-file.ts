import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { z } from "zod";
import type { ToolDefinition } from "../../kernel/types.js";
import type { BlobStore } from "../blob/types.js";

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const persistSandboxFileSchema = z.object({
  filePath: z
    .string()
    .describe(
      "Absolute path to the file in the workspace directory (e.g., the absolute path of a file written by execute in the current working directory)",
    ),
  title: z
    .string()
    .optional()
    .describe("Optional human-readable title for the file"),
});

export type PersistSandboxFileDeps = {
  /** 对象存储（blob 缝）：上传沙箱产物并按需签名。 */
  blob: BlobStore;
  /** 本 run 后端的沙箱目录（路径守卫口径与 backend 一致，per-run 解析）。 */
  sandboxDir?: string;
};

/**
 * `persist_sandbox_file`（shared）：沙箱产物上传换签名 URL。沙箱目录是
 * per-run 事实（dev=per-run tmp），经内核动态工具缝在 run 起始期解析；
 * 工作区从 execCtx.workspaceId 直取（runtime 已解析，不再经画布 JOIN 反查）。
 */
export function createPersistSandboxFileToolDefinition(
  deps: PersistSandboxFileDeps,
): ToolDefinition {
  return {
    name: "persist_sandbox_file",
    description:
      "Upload a file generated in the sandbox (e.g., a PDF or PNG created by Python code execution) " +
      "to persistent storage. Returns a signed URL the user can access. " +
      "Use this after execute() produces an output file you want to share with the user.",
    scope: "shared",
    zodSchema: persistSandboxFileSchema,
    parameters: z.toJSONSchema(persistSandboxFileSchema),
    execute: async (args, execCtx) => {
      const input = persistSandboxFileSchema.parse(args);

      // Path traversal guard: restrict reads to sandbox directory.
      // Use realpathSync to resolve symlinks (macOS /tmp → /private/tmp).
      if (deps.sandboxDir) {
        try {
          const realFilePath = realpathSync(input.filePath);
          if (!realFilePath.startsWith(deps.sandboxDir)) {
            return "Error: filePath must be inside the sandbox directory.";
          }
        } catch {
          return "Error: filePath does not exist or is not accessible.";
        }
      }

      try {
        const fileStats = await stat(input.filePath);
        if (fileStats.size > MAX_FILE_SIZE) {
          return `Error: File too large (${fileStats.size} bytes). Maximum: ${MAX_FILE_SIZE} bytes.`;
        }

        const fileBuffer = await readFile(input.filePath);
        const ext = extname(input.filePath).toLowerCase();
        const mimeType = MIME_MAP[ext] ?? "application/octet-stream";
        const safeTitle = input.title
          ? input.title
              .replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, "_")
              .slice(0, 100)
          : null;
        const fileName = safeTitle
          ? `${safeTitle}${ext}`
          : basename(input.filePath);

        // 存储路径按工作区前缀（RLS 口径）；工作区未解析时回落 uploads/ 前缀
        const storagePath = execCtx.workspaceId
          ? `${execCtx.workspaceId}/generated/${Date.now()}-${fileName}`
          : `uploads/${Date.now()}-${fileName}`;
        const bucket = deps.blob.bucket("project-assets");
        await bucket.upload(storagePath, fileBuffer, {
          contentType: mimeType,
          upsert: false,
        });

        const signedUrl = await bucket.createSignedUrl(storagePath, 3600);

        return JSON.stringify({
          summary: `File uploaded successfully: ${fileName}`,
          url: signedUrl,
          path: storagePath,
          mimeType,
          size: fileBuffer.length,
        });
      } catch (err) {
        return `Error reading or uploading file: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
