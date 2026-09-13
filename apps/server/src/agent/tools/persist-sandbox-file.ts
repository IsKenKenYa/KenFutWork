import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { BlobStore } from "../../features/blob/types.js";
import type { CanvasRepository } from "../../features/canvas/repository.js";

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
      "Absolute path to the file in the sandbox directory (e.g., /tmp/loomic-sandbox/<runId>/output.png)",
    ),
  title: z
    .string()
    .optional()
    .describe("Optional human-readable title for the file"),
});

export type PersistSandboxFileDeps = {
  /** 对象存储（blob 缝）：上传沙箱产物并按需签名。 */
  blob: BlobStore;
  /** 画布数据访问：由画布解析工作区（对象路径用）。 */
  canvasRepository?: CanvasRepository;
  sandboxDir?: string;
};

export function createPersistSandboxFileTool(deps: PersistSandboxFileDeps) {
  return tool(
    async (input, config) => {
      const canvasId = (config as any)?.configurable?.canvas_id as
        | string
        | undefined;

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

        // Resolve workspace ID from canvas for Storage RLS compliance.
        // RLS requires: storage.foldername(name)[1] = workspace_id
        let workspaceId: string | null = null;
        if (canvasId && deps.canvasRepository) {
          // 由画布反查工作区（单条 JOIN；画布 id 来自本次运行）
          workspaceId = await deps.canvasRepository
            .findWorkspaceIdByCanvas(canvasId)
            .catch(() => null);
        }

        const storagePath = workspaceId
          ? `${workspaceId}/generated/${Date.now()}-${fileName}`
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
      } catch (err: any) {
        return `Error reading or uploading file: ${err.message}`;
      }
    },
    {
      name: "persist_sandbox_file",
      description:
        "Upload a file generated in the sandbox (e.g., a PDF or PNG created by Python code execution) " +
        "to persistent storage. Returns a signed URL the user can access. " +
        "Use this after execute() produces an output file you want to share with the user.",
      schema: persistSandboxFileSchema,
    },
  );
}
