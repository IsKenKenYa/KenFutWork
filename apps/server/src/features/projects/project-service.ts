import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type {
  AdditionalDirectory,
  ProjectCreateRequest,
  ProjectKind,
  ProjectSummary,
  ProjectUpdateRequest,
} from "@kenfutwork/shared";
import type { BlobStore } from "../blob/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import { SQLSTATE_UNIQUE_VIOLATION } from "../persistence/errors.js";
import type {
  ProjectDetailRow,
  ProjectRepository,
  ProjectUpdatePatch,
} from "./repository.js";
import {
  normalizeAdditionalDirectories,
  resolveProjectWorkDirectory,
  validateWorkDir,
} from "./work-dir.js";

const THUMBNAIL_BUCKET = "project-assets";
const PROJECT_QUERY_FAILED_MESSAGE = "Unable to load projects.";
const PROJECT_CREATE_FAILED_MESSAGE = "Unable to create project.";
const PROJECT_DELETE_FAILED_MESSAGE = "Unable to delete project.";
const PROJECT_NOT_FOUND_MESSAGE = "Project not found.";
const PROJECT_UPDATE_FAILED_MESSAGE = "Unable to update project.";
const PROJECT_SLUG_TAKEN_MESSAGE = "当前实例内已存在同名项目。";

type ProjectErrorCode =
  | "invalid_work_dir"
  | "project_create_failed"
  | "project_delete_failed"
  | "project_not_found"
  | "project_query_failed"
  | "project_slug_taken"
  | "project_update_failed";

export type ProjectService = {
  openCodeDirectory(actor: LocalActor, path: string): Promise<ProjectSummary>;
  archiveProject(actor: LocalActor, projectId: string): Promise<void>;
  createProject(
    actor: LocalActor,
    input: ProjectCreateRequest,
  ): Promise<ProjectSummary>;
  getProject(actor: LocalActor, projectId: string): Promise<ProjectDetailRow>;
  listProjects(
    actor: LocalActor,
    kind?: ProjectKind,
  ): Promise<ProjectSummary[]>;
  saveThumbnail(
    actor: LocalActor,
    projectId: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ thumbnailUrl: string }>;
  updateProject(
    actor: LocalActor,
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
  /** 对象存储（缩略图）：走 blob 缝，不再直连 Supabase Storage。 */
  blob: BlobStore;
  repository: ProjectRepository;
  localInstance: LocalInstanceService;
  sandboxRoot?: string | undefined;
  beforeArchiveCodeProject?: (
    actor: LocalActor,
    projectId: string,
  ) => Promise<void>;
}): ProjectService {
  const { repository, localInstance } = options;

  return {
    async openCodeDirectory(actor, path) {
      const context = await localInstance.resolve(actor);
      const workDir = await realpath(requireWorkDir(path)).catch((error) => {
        throw new ProjectServiceError(
          "invalid_work_dir",
          `工作目录不可用：${error instanceof Error ? error.message : String(error)}`,
          400,
        );
      });
      const existing = await repository.findActiveCodeDirectory(
        context.instanceId,
        workDir,
      );
      if (existing)
        return mapProjectSummary({
          ...existing,
          instanceId: context.instanceId,
        });
      try {
        const created = await repository.createProject({
          canvasName: "Main Canvas",
          description: null,
          kind: "code",
          name: basename(workDir) || workDir,
          slug: `code-directory-${createHash("sha256").update(workDir).digest("hex")}`,
          workDir,
          createdByClientId: actor.accessClientId,
          instanceId: context.instanceId,
        });
        return mapProjectSummary({
          canvas: created.canvas,
          project: created.project,
          instanceId: context.instanceId,
        });
      } catch (error) {
        if ((error as { code?: string })?.code === SQLSTATE_UNIQUE_VIOLATION) {
          const concurrent = await repository.findActiveCodeDirectory(
            context.instanceId,
            workDir,
          );
          if (concurrent)
            return mapProjectSummary({
              ...concurrent,
              instanceId: context.instanceId,
            });
          throw new ProjectServiceError(
            "project_slug_taken",
            "工作目录对应的项目已归档，无法重新打开。",
            409,
          );
        }
        throw mapProjectCreateError(error);
      }
    },
    async archiveProject(actor, projectId) {
      const context = await localInstance.resolve(actor);
      const project = await repository.findActiveById(
        context.instanceId,
        projectId,
      );
      if (!project)
        throw new ProjectServiceError(
          "project_not_found",
          PROJECT_NOT_FOUND_MESSAGE,
          404,
        );
      if (project.kind === "code") {
        if (!options.beforeArchiveCodeProject)
          throw new ProjectServiceError(
            "project_delete_failed",
            "Code 执行资源关闭器不可用，项目未归档。",
            503,
          );
        await repository.beginCloseProject(context.instanceId, projectId);
        try {
          await options.beforeArchiveCodeProject(actor, projectId);
        } catch (error) {
          await repository.failCloseProject(context.instanceId, projectId);
          throw new ProjectServiceError(
            "project_delete_failed",
            error instanceof Error
              ? error.message
              : "Code 执行资源尚未确认关闭。",
            503,
          );
        }
      }

      const archived = await repository
        .archive(context.instanceId, projectId)
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

    async getProject(actor, projectId) {
      const context = await localInstance.resolve(actor);

      const project = await repository
        .findActiveById(context.instanceId, projectId)
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

    async createProject(actor, input) {
      const context = await localInstance.resolve(actor);
      const normalizedName = input.name.trim();
      // 手填的本机工作目录先校验（绝对路径 + 存在 + 是目录）：不合格直接 400，
      // 不留到 run 时才发现「目录不存在」——那时用户已经等了一轮。
      const projectId = randomUUID();
      const kind = input.kind ?? "design";
      const workDir =
        kind === "code"
          ? await resolveProjectWorkDirectory({
              instanceId: context.instanceId,
              projectId,
              sandboxRoot:
                options.sandboxRoot ?? join(context.dataDir, "sandbox"),
              workDir: input.work_dir
                ? requireWorkDir(input.work_dir)
                : undefined,
            })
          : input.work_dir
            ? requireWorkDir(input.work_dir)
            : undefined;
      const additionalDirectories = requireAdditionalDirectories(
        input.additional_directories ?? [],
      );

      const created = await repository
        .createProject({
          id: projectId,
          additionalDirectories,
          canvasName: "Main Canvas",
          description: normalizeDescription(input.description),
          // 缺省 design：存量调用方（Design 建项目）语义不变
          kind,
          name: normalizedName,
          slug: slugify(normalizedName),
          createdByClientId: actor.accessClientId,
          instanceId: context.instanceId,
          ...(workDir ? { workDir } : {}),
        })
        .catch((error: unknown) => {
          throw mapProjectCreateError(error);
        });

      return mapProjectSummary({
        canvas: created.canvas,
        project: created.project,
        instanceId: context.instanceId,
      });
    },

    async listProjects(actor, kind) {
      // 归属只由稳定本地实例解析，接入客户端不改变项目列表。
      const context = await localInstance.resolve(actor);

      const projects = await repository
        .listActive(context.instanceId, kind ?? "design")
        .catch(() => {
          throw new ProjectServiceError(
            "project_query_failed",
            PROJECT_QUERY_FAILED_MESSAGE,
            500,
          );
        });

      if (projects.length === 0) {
        return [];
      }

      if (kind === "code") {
        return Promise.all(
          projects.map(async (project) =>
            mapProjectSummary({
              project: {
                ...project,
                work_dir:
                  project.work_dir ??
                  resolve(
                    options.sandboxRoot ?? join(context.dataDir, "sandbox"),
                    context.instanceId,
                    project.id,
                  ),
              },
              instanceId: context.instanceId,
            }),
          ),
        );
      }

      const canvases = await repository
        .listPrimaryCanvases(
          context.instanceId,
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

      const thumbnailUrls = await resolveThumbnailUrls(
        options.blob,
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
          instanceId: context.instanceId,
        }),
      );
    },

    async saveThumbnail(actor, projectId, buffer, mimeType) {
      const context = await localInstance.resolve(actor);

      const project = await repository
        .findActiveById(context.instanceId, projectId)
        .catch(() => null);

      if (!project) {
        throw new ProjectServiceError(
          "project_create_failed",
          "Project not found.",
          404,
        );
      }

      const ext = mimeType === "image/webp" ? "webp" : "png";
      const objectPath = `${context.instanceId}/${projectId}/thumbnail.${ext}`;

      try {
        await options.blob
          .bucket(THUMBNAIL_BUCKET)
          .upload(objectPath, buffer, { contentType: mimeType, upsert: true });
      } catch (error) {
        throw new ProjectServiceError(
          "project_create_failed",
          `Thumbnail upload failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          500,
        );
      }

      await repository
        .setThumbnailPath(context.instanceId, projectId, objectPath)
        .catch(() => {
          throw new ProjectServiceError(
            "project_create_failed",
            "Failed to save thumbnail reference.",
            500,
          );
        });

      return {
        thumbnailUrl: await options.blob
          .bucket(THUMBNAIL_BUCKET)
          .resolveUrl(objectPath),
      };
    },

    async updateProject(actor, projectId, input) {
      const context = await localInstance.resolve(actor);
      const patch: ProjectUpdatePatch = {};
      if (input.brand_kit_id !== undefined) {
        patch.brandKitId = input.brand_kit_id;
      }
      if (input.name !== undefined) {
        patch.name = input.name;
      }
      if (input.work_dir !== undefined) {
        // `null` = 解绑；字符串 = 重绑（同样先校验）。
        patch.workDir =
          input.work_dir === null ? null : requireWorkDir(input.work_dir);
      }
      if (input.additional_directories !== undefined) {
        patch.additionalDirectories = requireAdditionalDirectories(
          input.additional_directories,
        );
      }

      if (
        patch.name === undefined &&
        patch.brandKitId === undefined &&
        patch.workDir === undefined &&
        patch.additionalDirectories === undefined
      ) {
        return;
      }

      const updated = await repository
        .update(context.instanceId, projectId, patch)
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

/**
 * 用户填的工作目录：不合格抛 400（可读原因直接给界面）。
 * 校验口径集中在 `work-dir.ts`（与 agent/git/索引三处的消费点同一份判定）。
 */
function requireWorkDir(raw: string): string {
  const verdict = validateWorkDir(raw);
  if (!verdict.ok) {
    throw new ProjectServiceError("invalid_work_dir", verdict.reason, 400);
  }
  return verdict.path;
}

function requireAdditionalDirectories(
  directories: AdditionalDirectory[],
): AdditionalDirectory[] {
  try {
    return normalizeAdditionalDirectories(directories);
  } catch (error) {
    throw new ProjectServiceError(
      "invalid_work_dir",
      error instanceof Error ? error.message : "附加目录不可用。",
      400,
    );
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
  canvas?: {
    id: string;
    is_primary: boolean;
    name: string;
  } | null;
  project: {
    created_at: string;
    description: string | null;
    id: string;
    kind: ProjectKind;
    name: string;
    slug: string;
    updated_at: string;
    work_dir?: string | null;
    additional_directories?: AdditionalDirectory[];
  };
  thumbnailUrl?: string | null;
  instanceId: string;
}): ProjectSummary {
  const base = {
    createdAt: options.project.created_at,
    description: options.project.description,
    id: options.project.id,
    name: options.project.name,
    slug: options.project.slug,
    // 显式 null 也回传：界面要能区分「未绑定」与「字段缺省」（列表里显示绑定状态）
    workDir: options.project.work_dir ?? null,
    additionalDirectories: options.project.additional_directories ?? [],
    ...(options.thumbnailUrl ? { thumbnailUrl: options.thumbnailUrl } : {}),
    updatedAt: options.project.updated_at,
    instanceId: options.instanceId,
  };
  if (options.project.kind === "code") {
    if (!options.project.work_dir)
      throw new ProjectServiceError(
        "invalid_work_dir",
        "Code 项目缺少主工作目录。",
        500,
      );
    return { ...base, kind: "code", workDir: options.project.work_dir };
  }
  if (!options.canvas)
    throw new ProjectServiceError(
      "project_query_failed",
      "画布项目缺少主画布。",
      500,
    );
  return {
    ...base,
    kind: options.project.kind,
    primaryCanvas: {
      id: options.canvas.id,
      isPrimary: options.canvas.is_primary,
      name: options.canvas.name,
    },
  };
}

/**
 * 缩略图 URL（经 blob 缝的 `resolveUrl`：公开性由存储侧决定，不硬编码假设）。
 * 非公开桶会走签名 URL，故这里是异步。
 */
async function resolveThumbnailUrls(
  blob: BlobStore,
  projects: Array<{ id: string; thumbnail_path: string | null }>,
): Promise<Map<string, string>> {
  const bucket = blob.bucket(THUMBNAIL_BUCKET);
  const entries = await Promise.all(
    projects
      .filter((project) => project.thumbnail_path)
      .map(
        async (project) =>
          [
            project.id,
            await bucket.resolveUrl(project.thumbnail_path as string),
          ] as const,
      ),
  );
  return new Map(entries);
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
