import type { CanvasContent, CanvasDetail, Json } from "@loomic/shared";

import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import {
  type CanvasContentStore,
  insertImageElement,
  insertVideoElement,
} from "./canvas-element-writer.js";
import type { CanvasRepository } from "./repository.js";

export class CanvasServiceError extends Error {
  readonly statusCode: number;
  readonly code: "canvas_not_found" | "canvas_save_failed";

  constructor(
    code: "canvas_not_found" | "canvas_save_failed",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "CanvasServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type ImageInsertRequest = {
  canvasId: string;
  objectPath: string;
  width: number;
  height: number;
  mimeType: string;
  title?: string;
  placement?: { x: number; y: number; width: number; height: number };
};

export type VideoInsertRequest = {
  canvasId: string;
  signedUrl: string;
  width: number;
  height: number;
  mimeType: string;
  durationSeconds?: number;
  title?: string;
  prompt?: string;
  placement?: { x: number; y: number; width: number; height: number };
};

/**
 * 画布写入者：agent 运行时侧只有 userId + 令牌，故只要求这两项
 * （工作区经身份 id 解析，对象存储访问用令牌）。
 */
export type CanvasActor = {
  accessToken: string;
  id: string;
};

export type CanvasService = {
  getCanvas(user: AuthenticatedUser, canvasId: string): Promise<CanvasDetail>;
  saveCanvasContent(
    user: AuthenticatedUser,
    canvasId: string,
    content: CanvasContent,
  ): Promise<void>;
  /** 生成物落画布：读-改-写内容并追加元素（工作区作用域由服务解析）。 */
  insertImageElement(
    actor: CanvasActor,
    request: ImageInsertRequest,
  ): Promise<{ elementId: string }>;
  insertVideoElement(
    actor: CanvasActor,
    request: VideoInsertRequest,
  ): Promise<{ elementId: string }>;
};

/**
 * Marker prefix for files that have been extracted to object storage.
 * Format: `oss://bucket/objectPath`
 */
const OSS_MARKER_PREFIX = "oss://";
const CANVAS_FILES_BUCKET = "project-assets";

export function createCanvasService(options: {
  /** 画布文件对象存储仍走 Supabase Storage（M3 blob 缝收口后移除）。 */
  createUserClient: (accessToken: string) => UserSupabaseClient;
  repository: CanvasRepository;
  viewerService: ViewerService;
}): CanvasService {
  const { repository, viewerService } = options;

  /** 工作区 id 一律由服务端从鉴权用户解析，不接受调用方传入（FORM-9）。 */
  const resolveWorkspaceId = async (user: Pick<AuthenticatedUser, "id">) => {
    const workspace = await viewerService
      .resolveWorkspace(user)
      .catch(() => null);

    if (!workspace) {
      throw new CanvasServiceError(
        "canvas_not_found",
        "Canvas not found.",
        404,
      );
    }

    return workspace.id;
  };

  /** 绑定工作区的画布内容读写缝（元素写入器据此访问）。 */
  const createContentStore = (
    actor: CanvasActor,
    workspaceId: string,
  ): CanvasContentStore => {
    const client = options.createUserClient(actor.accessToken);

    return {
      async readContent(canvasId) {
        const row = await repository
          .findById(workspaceId, canvasId)
          .catch(() => null);
        return row ? toCanvasContent(row.content) : null;
      },

      async writeContent(canvasId, content) {
        const affected = await repository
          .saveContent(workspaceId, canvasId, content)
          .catch(() => 0);
        if (affected === 0) {
          throw new Error(`Failed to write canvas: ${canvasId} not found`);
        }
      },

      async downloadObject(objectPath) {
        const { data: blob, error } = await client.storage
          .from(CANVAS_FILES_BUCKET)
          .download(objectPath);

        if (error || !blob) {
          throw new Error(error?.message ?? "no data");
        }

        return Buffer.from(await blob.arrayBuffer());
      },
    };
  };

  return {
    async getCanvas(user, canvasId) {
      const workspaceId = await resolveWorkspaceId(user);
      const row = await repository
        .findById(workspaceId, canvasId)
        .catch(() => null);

      if (!row) {
        throw new CanvasServiceError(
          "canvas_not_found",
          "Canvas not found.",
          404,
        );
      }

      const content = toCanvasContent(row.content);

      // Resolve OSS-stored files back to base64 dataURLs for the frontend
      const resolvedContent = resolveFilesFromStorage(
        options.createUserClient(user.accessToken),
        content,
      );

      return {
        id: row.id,
        name: row.name,
        projectId: row.project_id,
        content: resolvedContent,
      };
    },

    async saveCanvasContent(user, canvasId, content) {
      const workspaceId = await resolveWorkspaceId(user);
      const client = options.createUserClient(user.accessToken);

      // Extract base64 files to Storage, replacing dataURLs with oss:// markers
      const leanContent = await extractFilesToStorage(
        client,
        canvasId,
        content,
      );

      const affected = await repository
        .saveContent(workspaceId, canvasId, leanContent as unknown as Json)
        .catch(() => {
          throw new CanvasServiceError(
            "canvas_save_failed",
            "Unable to save canvas.",
            500,
          );
        });

      // 0 行 = 画布不存在或不属本工作区：旧实现经 RLS 静默成功，此处显式 404。
      if (affected === 0) {
        throw new CanvasServiceError(
          "canvas_not_found",
          "Canvas not found.",
          404,
        );
      }
    },

    async insertImageElement(actor, request) {
      const workspaceId = await resolveWorkspaceId(actor);

      return insertImageElement(
        createContentStore(actor, workspaceId),
        {
          canvasId: request.canvasId,
          mimeType: request.mimeType,
          objectPath: request.objectPath,
          ...(request.title ? { title: request.title } : {}),
          height: request.height,
          width: request.width,
        },
        request.placement,
      );
    },

    async insertVideoElement(actor, request) {
      const workspaceId = await resolveWorkspaceId(actor);

      return insertVideoElement(
        createContentStore(actor, workspaceId),
        {
          canvasId: request.canvasId,
          mimeType: request.mimeType,
          signedUrl: request.signedUrl,
          ...(request.durationSeconds != null
            ? { durationSeconds: request.durationSeconds }
            : {}),
          ...(request.title ? { title: request.title } : {}),
          ...(request.prompt ? { prompt: request.prompt } : {}),
          height: request.height,
          width: request.width,
        },
        request.placement,
      );
    },
  };
}

function toCanvasContent(value: unknown): CanvasContent {
  return (value as CanvasContent) ?? { elements: [], appState: {} };
}

// ---------------------------------------------------------------------------
// File extraction (save path): base64 dataURL → object storage + oss:// marker
// ---------------------------------------------------------------------------

type CanvasFileRecord = Record<string, Record<string, unknown>>;

async function extractFilesToStorage(
  client: UserSupabaseClient,
  canvasId: string,
  content: CanvasContent,
): Promise<CanvasContent> {
  const files = (content as { files?: CanvasFileRecord }).files;
  if (!files || Object.keys(files).length === 0) {
    return content;
  }

  const updatedFiles: CanvasFileRecord = {};

  await Promise.all(
    Object.entries(files).map(async ([fileId, fileData]) => {
      const dataURL = fileData.dataURL as string | undefined;

      // Already extracted to storage — keep marker
      if (dataURL?.startsWith(OSS_MARKER_PREFIX)) {
        updatedFiles[fileId] = fileData;
        return;
      }

      // Only process base64 data URLs
      if (!dataURL?.startsWith("data:")) {
        updatedFiles[fileId] = fileData;
        return;
      }

      try {
        const { buffer, mimeType } = parseDataURL(dataURL);
        const ext = mimeToExt(mimeType);
        const objectPath = `canvas-files/${canvasId}/${fileId}.${ext}`;

        // Upsert: the same file ID may be re-saved
        const { error: uploadError } = await client.storage
          .from(CANVAS_FILES_BUCKET)
          .upload(objectPath, buffer, { contentType: mimeType, upsert: true });

        if (uploadError) {
          // On upload failure, keep the original base64 (graceful degradation)
          updatedFiles[fileId] = fileData;
          return;
        }

        updatedFiles[fileId] = {
          ...fileData,
          dataURL: `${OSS_MARKER_PREFIX}${CANVAS_FILES_BUCKET}/${objectPath}`,
        };
      } catch {
        // Unparseable dataURL — keep as-is
        updatedFiles[fileId] = fileData;
      }
    }),
  );

  return {
    ...content,
    files: updatedFiles,
  } as CanvasContent;
}

// ---------------------------------------------------------------------------
// File resolution (load path): oss:// marker → public URL
// ---------------------------------------------------------------------------

function resolveFilesFromStorage(
  client: UserSupabaseClient,
  content: CanvasContent,
): CanvasContent {
  const files = (content as { files?: CanvasFileRecord }).files;
  if (!files || Object.keys(files).length === 0) {
    return content;
  }

  // Separate OSS files from inline files
  const updatedFiles: CanvasFileRecord = {};

  for (const [fileId, fileData] of Object.entries(files)) {
    const dataURL = fileData.dataURL as string | undefined;
    if (!dataURL?.startsWith(OSS_MARKER_PREFIX)) {
      updatedFiles[fileId] = fileData;
      continue;
    }

    const ref = dataURL.slice(OSS_MARKER_PREFIX.length);
    const slashIdx = ref.indexOf("/");
    if (slashIdx === -1) {
      updatedFiles[fileId] = fileData;
      continue;
    }

    // Resolve public URL instead of downloading each file
    const bucket = ref.slice(0, slashIdx);
    const objectPath = ref.slice(slashIdx + 1);
    const { data } = client.storage.from(bucket).getPublicUrl(objectPath);

    updatedFiles[fileId] = {
      ...fileData,
      dataURL: undefined,
      storageUrl: data.publicUrl,
    };
  }

  return {
    ...content,
    files: updatedFiles,
  } as CanvasContent;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseDataURL(dataURL: string): { buffer: Buffer; mimeType: string } {
  // Format: data:[<mediatype>][;base64],<data>
  const match = dataURL.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) {
    throw new Error("Invalid data URL");
  }
  return {
    mimeType: match[1]!,
    buffer: Buffer.from(match[2]!, "base64"),
  };
}

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}
