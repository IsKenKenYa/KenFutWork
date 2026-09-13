import type {
  ProjectCreateRequest,
  ProjectSummary,
  ProjectUpdateRequest,
} from "@loomic/shared";

import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import { BootstrapError } from "../bootstrap/errors.js";
import { SQLSTATE_UNIQUE_VIOLATION } from "../persistence/errors.js";
import type { ProjectRepository, ProjectUpdatePatch } from "./repository.js";

const THUMBNAIL_BUCKET = "project-assets";
const PROJECT_QUERY_FAILED_MESSAGE = "Unable to load projects.";
const PROJECT_CREATE_FAILED_MESSAGE = "Unable to create project.";
const PROJECT_DELETE_FAILED_MESSAGE = "Unable to delete project.";
const PROJECT_NOT_FOUND_MESSAGE = "Project not found.";
const PROJECT_UPDATE_FAILED_MESSAGE = "Unable to update project.";
const PROJECT_SLUG_TAKEN_MESSAGE =
  "Project slug is already taken in this workspace.";

type ProjectErrorCode =
  | "project_create_failed"
  | "project_delete_failed"
  | "project_not_found"
  | "project_query_failed"
  | "project_slug_taken"
  | "project_update_failed";

export type ProjectService = {
  archiveProject(user: AuthenticatedUser, projectId: string): Promise<void>;
  createProject(
    user: AuthenticatedUser,
    input: ProjectCreateRequest,
  ): Promise<ProjectSummary>;
  getProject(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    workspace_id: string;
    brand_kit_id: string | null;
    created_at: string;
    updated_at: string;
  }>;
  listProjects(user: AuthenticatedUser): Promise<ProjectSummary[]>;
  saveThumbnail(
    user: AuthenticatedUser,
    projectId: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ thumbnailUrl: string }>;
  updateProject(
    user: AuthenticatedUser,
    projectId: string,
    input: ProjectUpdateRequest,
  ): Promise<void>;
};

export class ProjectServiceError extends Error {
  readonly statusCode: number;
  readonly code: ProjectErrorCode;

  constructor(code: ProjectErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = "ProjectServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createProjectService(options: {
  /** 缩略图仍走 Supabase Storage（M3 blob 缝落地后移除）。 */
  createUserClient: (accessToken: string) => UserSupabaseClient;
  repository: ProjectRepository;
  viewerService: ViewerService;
}): ProjectService {
  const { repository, viewerService } = options;

  const resolveWorkspace = (
    user: AuthenticatedUser,
    errorCode: keyof typeof WORKSPACE_FAILURE_MESSAGES,
  ) =>
    viewerService.resolveWorkspace(user).catch((error: unknown) => {
      if (error instanceof BootstrapError) {
        throw new ProjectServiceError(
          errorCode,
          WORKSPACE_FAILURE_MESSAGES[errorCode],
          500,
        );
      }
      throw error;
    });

  return {
    async archiveProject(user, projectId) {
      const workspace = await resolveWorkspace(user, "project_query_failed");

      const archived = await repository
        .archive(workspace.id, projectId)
        .catch(() => {
          throw new ProjectServiceError(
            "project_delete_failed",
            PROJECT_DELETE_FAILED_MESSAGE,
            500,
          );
        });

      if (archived === 0) {
        throw new ProjectServiceError(
          "project_not_found",
          PROJECT_NOT_FOUND_MESSAGE,
          404,
        );
      }
    },

    async getProject(user, projectId) {
      const workspace = await resolveWorkspace(user, "project_query_failed");

      const project = await repository
        .findActiveById(workspace.id, projectId)
        .catch(() => {
          throw new ProjectServiceError(
            "project_query_failed",
            "Failed to load project.",
            500,
          );
        });

      if (!project) {
        throw new ProjectServiceError(
          "project_not_found",
          "Project not found.",
          404,
        );
      }

      return project;
    },

    async createProject(user, input) {
      await ensureFoundation(viewerService, user, "project_create_failed");
      const workspace = await resolveWorkspace(user, "project_create_failed");
      const normalizedName = input.name.trim();

      const created = await repository
        .createWithCanvas({
          canvasName: "Main Canvas",
          description: normalizeDescription(input.description),
          name: normalizedName,
          slug: slugify(normalizedName),
          userId: user.id,
          workspaceId: workspace.id,
        })
        .catch((error: unknown) => {
          throw mapProjectCreateError(error);
        });

      return mapProjectSummary({
        canvas: created.canvas,
        project: created.project,
        workspace,
      });
    },

    async listProjects(user) {
      // 只读路径不做引导：用户已认证，引导由 /api/viewer 在页面加载时完成。
      const workspace = await resolveWorkspace(user, "project_query_failed");

      const projects = await repository.listActive(workspace.id).catch(() => {
        throw new ProjectServiceError(
          "project_query_failed",
          PROJECT_QUERY_FAILED_MESSAGE,
          500,
        );
      });

      if (projects.length === 0) {
        return [];
      }

      const canvases = await repository
        .listPrimaryCanvases(
          workspace.id,
          projects.map((project) => project.id),
        )
        .catch(() => {
          throw new ProjectServiceError(
            "project_query_failed",
            PROJECT_QUERY_FAILED_MESSAGE,
            500,
          );
        });

      const primaryCanvasByProjectId = new Map(
        canvases.map((canvas) => [canvas.project_id, canvas]),
      );
      const projectIdsMissingCanvas = projects.filter(
        (project) => !primaryCanvasByProjectId.has(project.id),
      );

      if (projectIdsMissingCanvas.length > 0) {
        throw new ProjectServiceError(
          "project_query_failed",
          PROJECT_QUERY_FAILED_MESSAGE,
          500,
        );
      }

      // 缩略图 URL 仍由 Supabase Storage 生成（M3 blob 缝落地后移除）。
      const thumbnailUrls = generateThumbnailUrls(
        options.createUserClient(user.accessToken),
        projects.filter((project) => project.thumbnail_path),
      );

      return projects.map((project) =>
        mapProjectSummary({
          // 上面的缺失检查保证存在；此处断言避免在每个 map 里再抛一次。
          canvas: primaryCanvasByProjectId.get(project.id) as {
            id: string;
            is_primary: boolean;
            name: string;
          },
          project,
          thumbnailUrl: thumbnailUrls.get(project.id) ?? null,
          workspace,
        }),
      );
    },

    async saveThumbnail(user, projectId, buffer, mimeType) {
      const workspace = await resolveWorkspace(user, "project_create_failed");

      const project = await repository
        .findActiveById(workspace.id, projectId)
        .catch(() => null);

      if (!project) {
        throw new ProjectServiceError(
          "project_create_failed",
          "Project not found.",
          404,
        );
      }

      const client = options.createUserClient(user.accessToken);
      const ext = mimeType === "image/webp" ? "webp" : "png";
      const objectPath = `${workspace.id}/${projectId}/thumbnail.${ext}`;

      const { error: uploadError } = await client.storage
        .from(THUMBNAIL_BUCKET)
        .upload(objectPath, buffer, { contentType: mimeType, upsert: true });

      if (uploadError) {
        throw new ProjectServiceError(
          "project_create_failed",
          `Thumbnail upload failed: ${uploadError.message}`,
          500,
        );
      }

      await repository
        .setThumbnailPath(workspace.id, projectId, objectPath)
        .catch(() => {
          throw new ProjectServiceError(
            "project_create_failed",
            "Failed to save thumbnail reference.",
            500,
          );
        });

      const { data: urlData } = client.storage
        .from(THUMBNAIL_BUCKET)
        .getPublicUrl(objectPath);

      return { thumbnailUrl: urlData.publicUrl };
    },

    async updateProject(user, projectId, input) {
      const patch: ProjectUpdatePatch = {};
      if (input.brand_kit_id !== undefined) {
        patch.brandKitId = input.brand_kit_id;
      }
      if (input.name !== undefined) {
        patch.name = input.name;
      }

      if (patch.name === undefined && patch.brandKitId === undefined) {
        return;
      }

      const workspace = await resolveWorkspace(user, "project_update_failed");

      const updated = await repository
        .update(workspace.id, projectId, patch)
        .catch(() => {
          throw new ProjectServiceError(
            "project_update_failed",
            PROJECT_UPDATE_FAILED_MESSAGE,
            500,
          );
        });

      if (updated === 0) {
        throw new ProjectServiceError(
          "project_not_found",
          PROJECT_NOT_FOUND_MESSAGE,
          404,
        );
      }
    },
  };
}

/** 工作区解析失败时的错误码 → 用户可见消息（按调用场景选择错误码）。 */
const WORKSPACE_FAILURE_MESSAGES = {
  project_create_failed: PROJECT_CREATE_FAILED_MESSAGE,
  project_query_failed: PROJECT_QUERY_FAILED_MESSAGE,
  project_update_failed: PROJECT_UPDATE_FAILED_MESSAGE,
} as const;

async function ensureFoundation(
  viewerService: ViewerService,
  user: AuthenticatedUser,
  errorCode: keyof typeof WORKSPACE_FAILURE_MESSAGES,
) {
  try {
    await viewerService.ensureViewer(user);
  } catch (error) {
    if (error instanceof BootstrapError) {
      throw new ProjectServiceError(
        errorCode,
        WORKSPACE_FAILURE_MESSAGES[errorCode],
        500,
      );
    }
    throw error;
  }
}

function mapProjectCreateError(error: unknown) {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === SQLSTATE_UNIQUE_VIOLATION
  ) {
    return new ProjectServiceError(
      "project_slug_taken",
      PROJECT_SLUG_TAKEN_MESSAGE,
      409,
    );
  }

  return new ProjectServiceError(
    "project_create_failed",
    PROJECT_CREATE_FAILED_MESSAGE,
    500,
  );
}

function mapProjectSummary(options: {
  canvas: {
    id: string;
    is_primary: boolean;
    name: string;
  };
  project: {
    created_at: string;
    description: string | null;
    id: string;
    name: string;
    slug: string;
    updated_at: string;
  };
  thumbnailUrl?: string | null;
  workspace: {
    id: string;
    name: string;
    ownerUserId: string;
    type: "personal" | "team";
  };
}): ProjectSummary {
  return {
    createdAt: options.project.created_at,
    description: options.project.description,
    id: options.project.id,
    name: options.project.name,
    primaryCanvas: {
      id: options.canvas.id,
      isPrimary: options.canvas.is_primary,
      name: options.canvas.name,
    },
    slug: options.project.slug,
    ...(options.thumbnailUrl ? { thumbnailUrl: options.thumbnailUrl } : {}),
    updatedAt: options.project.updated_at,
    workspace: {
      id: options.workspace.id,
      name: options.workspace.name,
      ownerUserId: options.workspace.ownerUserId,
      type: options.workspace.type,
    },
  };
}

/** 缩略图公开 URL（Supabase Storage 期间实现；M3 换 BlobStore）。 */
function generateThumbnailUrls(
  client: UserSupabaseClient,
  projects: Array<{ id: string; thumbnail_path: string | null }>,
): Map<string, string> {
  const urlMap = new Map<string, string>();

  for (const project of projects) {
    if (!project.thumbnail_path) continue;
    const { data } = client.storage
      .from(THUMBNAIL_BUCKET)
      .getPublicUrl(project.thumbnail_path);
    urlMap.set(project.id, data.publicUrl);
  }

  return urlMap;
}

function normalizeDescription(description: string | undefined) {
  const normalized = description?.trim();
  return normalized || null;
}

function slugify(value: string) {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const suffix = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${suffix}` : `project-${suffix}`;
}
