import type { PersistenceService } from "../persistence/types.js";

export type ProjectListRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  workspace_id: string;
  thumbnail_path: string | null;
};

export type ProjectDetailRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  workspace_id: string;
  brand_kit_id: string | null;
  created_at: string;
  updated_at: string;
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
  description: string | null;
  created_at: string;
  updated_at: string;
  workspace_id: string;
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
};

export type CreateProjectInput = {
  canvasName: string;
  description: string | null;
  name: string;
  slug: string;
  userId: string;
  workspaceId: string;
};

/**
 * projects 聚合的数据访问（`projects`/`canvases`）。
 * 隔离口径：`projects` 直接带 `workspace_id` 谓词；`canvases` 无该列，一律
 * JOIN `projects` 后施加谓词（`FORM-9` 单一隔离入口）。
 */
export interface ProjectRepository {
  /** 归档（软删）活跃项目；返回受影响行数（0 = 不存在或已归档）。 */
  archive(workspaceId: string, projectId: string): Promise<number>;
  /** 建项目 + 主画布，同一事务（原子性不依赖 DB 函数）。 */
  createWithCanvas(input: CreateProjectInput): Promise<{
    canvas: CreatedCanvasRow;
    project: CreatedProjectRow;
  }>;
  findActiveById(
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectDetailRow | null>;
  listActive(workspaceId: string): Promise<ProjectListRow[]>;
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
  update(
    workspaceId: string,
    projectId: string,
    patch: ProjectUpdatePatch,
  ): Promise<number>;
}

const PROJECT_LIST_COLUMNS =
  "id, name, slug, description, created_at, updated_at, workspace_id, thumbnail_path";
const PROJECT_DETAIL_COLUMNS =
  "id, name, slug, description, workspace_id, brand_kit_id, created_at, updated_at";
const PROJECT_CREATED_COLUMNS =
  "id, name, slug, description, created_at, updated_at, workspace_id";

export function createProjectRepository(
  persistence: PersistenceService,
): ProjectRepository {
  return {
    async listActive(workspaceId) {
      return persistence.forWorkspace(workspaceId).query<ProjectListRow>(
        `select ${PROJECT_LIST_COLUMNS}
           from public.projects
          where workspace_id = :workspace
            and archived_at is null
          order by updated_at desc`,
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

    async createWithCanvas(input) {
      return persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(input.workspaceId);

        const project = await scoped.queryOne<CreatedProjectRow>(
          `insert into public.projects
                  (workspace_id, name, slug, description, created_by)
           values (:workspace, $1, $2, $3, $4)
           returning ${PROJECT_CREATED_COLUMNS}`,
          [input.name, input.slug, input.description, input.userId],
        );

        if (!project) {
          throw new Error("[projects] 建项目未返回行。");
        }

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
  };
}
