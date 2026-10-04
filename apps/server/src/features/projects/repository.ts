import type { AdditionalDirectory, ProjectKind } from "@kenfutwork/shared";

import type { PersistenceService } from "../persistence/types.js";

export type ProjectListRow = {
  id: string;
  name: string;
  slug: string;
  kind: ProjectKind;
  description: string | null;
  created_at: string;
  updated_at: string;
  workspace_id: string;
  thumbnail_path: string | null;
  work_dir: string | null;
  additional_directories: AdditionalDirectory[];
};

export type ProjectDetailRow = {
  id: string;
  kind: ProjectKind;
  name: string;
  slug: string;
  description: string | null;
  workspace_id: string;
  brand_kit_id: string | null;
  created_at: string;
  updated_at: string;
  work_dir: string | null;
  additional_directories: AdditionalDirectory[];
};

export type PrimaryCanvasRow = {
  id: string;
  name: string;
  is_primary: boolean;
  project_id: string;
};

export type CreatedProjectRow = {
  id: string;
  name: string;
  slug: string;
  kind: ProjectKind;
  description: string | null;
  created_at: string;
  updated_at: string;
  workspace_id: string;
  work_dir: string | null;
  additional_directories: AdditionalDirectory[];
};

export type CreatedCanvasRow = {
  id: string;
  name: string;
  is_primary: boolean;
};

/** 更新补丁：`undefined` = 不改；显式 `null` = 清空（如解绑品牌套件）。 */
export type ProjectUpdatePatch = {
  name?: string | undefined;
  brandKitId?: string | null | undefined;
  /** 绑定的本机工作目录；`null` = 解绑（回落沙箱目录）。 */
  workDir?: string | null | undefined;
  additionalDirectories?: AdditionalDirectory[] | undefined;
};

export type CreateProjectInput = {
  id?: string;
  additionalDirectories?: AdditionalDirectory[];
  canvasName: string;
  description: string | null;
  name: string;
  slug: string;
  /** 缺省 design（画布项目）；Code 模式传 code（工作目录项目）。 */
  kind?: ProjectKind;
  /** 已校验的本机工作目录绝对路径（缺省不绑定）。 */
  workDir?: string | undefined;
  userId: string;
  workspaceId: string;
};

/**
 * projects 聚合的数据访问（`projects`/`canvases`）。
 * 隔离口径：`projects` 直接带 `workspace_id` 谓词；`canvases` 无该列，一律
 * JOIN `projects` 后施加谓词（`FORM-9` 单一隔离入口）。
 */
export interface ProjectRepository {
  beginCloseProject(workspaceId: string, projectId: string): Promise<void>;
  failCloseProject(workspaceId: string, projectId: string): Promise<void>;
  findActiveCodeDirectory(
    workspaceId: string,
    path: string,
  ): Promise<{ project: CreatedProjectRow; canvas: null } | null>;
  /** 归档（软删）活跃项目；返回受影响行数（0 = 不存在或已归档）。 */
  archive(workspaceId: string, projectId: string): Promise<number>;
  /** 建项目 + 主画布，同一事务（原子性不依赖 DB 函数）。 */
  createProject(input: CreateProjectInput): Promise<{
    canvas: CreatedCanvasRow | null;
    project: CreatedProjectRow;
  }>;
  findActiveById(
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectDetailRow | null>;
  listActive(
    workspaceId: string,
    kind?: ProjectKind,
  ): Promise<ProjectListRow[]>;
  /** 取这批项目的主画布（跨项目一次查询）。 */
  listPrimaryCanvases(
    workspaceId: string,
    projectIds: readonly string[],
  ): Promise<PrimaryCanvasRow[]>;
  /** 缩略图对象路径——供 blob 存储路径拼装（同工作区校验）。 */
  setThumbnailPath(
    workspaceId: string,
    projectId: string,
    thumbnailPath: string,
  ): Promise<number>;
  /**
   * 画布 → 所属项目绑定的工作目录（Code 模式绑定本机目录）。
   *
   * 谓词经 `projects.workspace_id` 施加（canvases 无该列），因此「画布不属于本工作区」
   * 与「未绑定」都回 null，不泄露其它工作区的绑定情况。
   */
  findWorkDirByCanvas(
    workspaceId: string,
    canvasId: string,
  ): Promise<string | null>;
  update(
    workspaceId: string,
    projectId: string,
    patch: ProjectUpdatePatch,
  ): Promise<number>;
}

const PROJECT_LIST_COLUMNS =
  "id, name, slug, kind, description, created_at, updated_at, workspace_id, thumbnail_path, work_dir, additional_directories";
const PROJECT_DETAIL_COLUMNS =
  "id, name, slug, kind, description, workspace_id, brand_kit_id, created_at, updated_at, work_dir, additional_directories";
const PROJECT_CREATED_COLUMNS =
  "id, name, slug, kind, description, created_at, updated_at, workspace_id, work_dir, additional_directories";

export function createProjectRepository(
  persistence: PersistenceService,
): ProjectRepository {
  return {
    async beginCloseProject(workspaceId, projectId) {
      await persistence.forWorkspace(workspaceId).execute(
        `update public.code_ui_sessions set execution_state = 'revoking',
                scope_generation = scope_generation + 1, branch_generation = branch_generation + 1
          where workspace_id = :workspace and project_id = $1 and deleted_at is null`,
        [projectId],
      );
    },
    async failCloseProject(workspaceId, projectId) {
      await persistence.forWorkspace(workspaceId).execute(
        `update public.code_ui_sessions set execution_state = 'failed'
          where workspace_id = :workspace and project_id = $1 and execution_state = 'revoking'`,
        [projectId],
      );
    },
    async findActiveCodeDirectory(workspaceId, path) {
      return persistence
        .forWorkspace(workspaceId)
        .queryOne<{ project: CreatedProjectRow; canvas: null }>(
          `select to_jsonb(p) as project, null::jsonb as canvas
         from public.projects p
         where p.workspace_id=:workspace and p.archived_at is null and p.kind='code' and p.work_dir=$1
         order by p.created_at asc limit 1`,
          [path],
        );
    },
    async listActive(workspaceId, kind = "design") {
      return persistence.forWorkspace(workspaceId).query<ProjectListRow>(
        `select ${PROJECT_LIST_COLUMNS}
           from public.projects
          where workspace_id = :workspace
            and archived_at is null
            and kind = $1
          order by updated_at desc`,
        [kind],
      );
    },

    async listPrimaryCanvases(workspaceId, projectIds) {
      if (projectIds.length === 0) {
        return [];
      }

      return persistence.forWorkspace(workspaceId).query<PrimaryCanvasRow>(
        `select c.id, c.name, c.is_primary, c.project_id
           from public.canvases c
           join public.projects p on p.id = c.project_id
          where p.workspace_id = :workspace
            and c.is_primary = true
            and c.project_id = any($1::uuid[])`,
        [projectIds],
      );
    },

    async findActiveById(workspaceId, projectId) {
      return persistence.forWorkspace(workspaceId).queryOne<ProjectDetailRow>(
        `select ${PROJECT_DETAIL_COLUMNS}
           from public.projects
          where workspace_id = :workspace
            and id = $1
            and archived_at is null`,
        [projectId],
      );
    },

    async archive(workspaceId, projectId) {
      return persistence.forWorkspace(workspaceId).execute(
        `update public.projects
            set archived_at = now()
          where workspace_id = :workspace
            and id = $1
            and archived_at is null`,
        [projectId],
      );
    },

    async update(workspaceId, projectId, patch) {
      const assignments: string[] = [];
      // $1 固定是 project_id；SET 的占位符从 $2 起编号。
      const values: unknown[] = [projectId];

      if (patch.name !== undefined) {
        values.push(patch.name);
        assignments.push(`name = $${values.length}`);
      }
      if (patch.brandKitId !== undefined) {
        values.push(patch.brandKitId);
        assignments.push(`brand_kit_id = $${values.length}`);
      }
      if (patch.workDir !== undefined) {
        values.push(patch.workDir);
        assignments.push(`work_dir = $${values.length}`);
      }

      if (patch.additionalDirectories !== undefined) {
        values.push(JSON.stringify(patch.additionalDirectories));
        assignments.push(`additional_directories = $${values.length}::jsonb`);
      }

      if (assignments.length === 0) {
        return 0;
      }

      return persistence.forWorkspace(workspaceId).execute(
        `update public.projects
            set ${assignments.join(", ")}
          where workspace_id = :workspace
            and id = $1`,
        values,
      );
    },

    async createProject(input) {
      return persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(input.workspaceId);

        const project = await scoped.queryOne<CreatedProjectRow>(
          `insert into public.projects
                  (id, workspace_id, name, slug, kind, description, work_dir, created_by, additional_directories)
           values (coalesce($7::uuid, gen_random_uuid()), :workspace, $1, $2, $3, $4, $5, $6, $8::jsonb)
           returning ${PROJECT_CREATED_COLUMNS}`,
          [
            input.name,
            input.slug,
            input.kind ?? "design",
            input.description,
            input.workDir ?? null,
            input.userId,
            input.id ?? null,
            JSON.stringify(input.additionalDirectories ?? []),
          ],
        );

        if (!project) {
          throw new Error("[projects] 建项目未返回行。");
        }

        if (project.kind === "code") return { canvas: null, project };

        const canvas = await scoped.queryOne<CreatedCanvasRow>(
          // canvases 无 workspace_id 列：经 projects 父链施加谓词，
          // 守卫因此同时是「该项目确属本工作区」的归属校验。
          `insert into public.canvases (project_id, name, is_primary, created_by)
           select p.id, $1, true, $2
             from public.projects p
            where p.id = $3
              and p.workspace_id = :workspace
           returning id, name, is_primary`,
          [input.canvasName, input.userId, project.id],
        );

        if (!canvas) {
          throw new Error("[projects] 建主画布未返回行。");
        }

        return { canvas, project };
      });
    },

    async setThumbnailPath(workspaceId, projectId, thumbnailPath) {
      return persistence.forWorkspace(workspaceId).execute(
        `update public.projects
            set thumbnail_path = $1
          where workspace_id = :workspace
            and id = $2`,
        [thumbnailPath, projectId],
      );
    },

    async findWorkDirByCanvas(workspaceId, canvasId) {
      const row = await persistence.forWorkspace(workspaceId).queryOne<{
        work_dir: string | null;
        additional_directories: AdditionalDirectory[];
      }>(
        `select p.work_dir
           from public.canvases c
           join public.projects p on p.id = c.project_id
          where p.workspace_id = :workspace
            and c.id = $1
            and p.archived_at is null and p.kind <> 'code'`,
        [canvasId],
      );
      return row?.work_dir ?? null;
    },
  };
}
