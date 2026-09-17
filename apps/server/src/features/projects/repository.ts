import type { ProjectKind } from "@kenfutwork/shared";

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
  work_dir: string | null;
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
};

export type CreateProjectInput = {
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
  /**
   * 取得（必要时懒创建）工作区的 **Code 工作台**载体：保留 slug 的项目 + 主画布。
   *
   * 为什么 Code 模式也需要一个「画布」：`chat_sessions.canvas_id` 是 NOT NULL + FK →
   * `canvases`，而 Code 模式的会话此前用客户端自造的 id 冒充画布 —— 库里没有这张画布，
   * 于是会话行写不进去、线程解析与助手消息落库全部失败（消息「只活在内存里」）。
   * 该载体是产品意义上的内部容器（不是用户在 Design 里管理的内容），故用保留 slug
   * 并在 `listActive` 里排除，界面上不可见。
   *
   * 并发安全靠既有唯一约束：`projects_workspace_slug_key` 与
   * `canvases_one_primary_per_project_key`（`on conflict do nothing` + 回读）。
   */
  ensureCodeWorkbench(input: {
    userId: string;
    workspaceId: string;
  }): Promise<{ canvasId: string; projectId: string }>;
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
  "id, name, slug, kind, description, created_at, updated_at, workspace_id, thumbnail_path, work_dir";
const PROJECT_DETAIL_COLUMNS =
  "id, name, slug, kind, description, workspace_id, brand_kit_id, created_at, updated_at, work_dir";
const PROJECT_CREATED_COLUMNS =
  "id, name, slug, kind, description, created_at, updated_at, workspace_id, work_dir";

/**
 * Code 模式会话载体项目的保留 slug（`projects_workspace_slug_key` 唯一）。
 * 它在 `listActive` 里被排除——用户不该在项目列表里看到内部容器。
 */
export const CODE_WORKBENCH_SLUG = "code-workbench";
const CODE_WORKBENCH_NAME = "Code 工作台";

export function createProjectRepository(
  persistence: PersistenceService,
): ProjectRepository {
  return {
    async listActive(workspaceId, kind = "design") {
      return persistence.forWorkspace(workspaceId).query<ProjectListRow>(
        `select ${PROJECT_LIST_COLUMNS}
           from public.projects
          where workspace_id = :workspace
            and archived_at is null
            and kind = $1
            and slug <> $2
          order by updated_at desc`,
        [kind, CODE_WORKBENCH_SLUG],
      );
    },

    async ensureCodeWorkbench(input) {
      return persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(input.workspaceId);

        // 1) 项目：唯一约束 (workspace_id, slug) 兜住并发；冲突即回读既有行
        const insertedProject = await scoped.queryOne<{ id: string }>(
          `insert into public.projects (workspace_id, name, slug, kind, created_by)
           values (:workspace, $1, $2, 'code', $3)
           on conflict (workspace_id, slug) do nothing
           returning id`,
          [CODE_WORKBENCH_NAME, CODE_WORKBENCH_SLUG, input.userId],
        );
        const project =
          insertedProject ??
          (await scoped.queryOne<{ id: string }>(
            `select id
               from public.projects
              where workspace_id = :workspace
                and slug = $1`,
            [CODE_WORKBENCH_SLUG],
          ));
        if (!project) {
          throw new Error(
            "[projects] Code 工作台项目供给失败（未插入也未读到）。",
          );
        }

        // 2) 主画布：部分唯一索引 (project_id) WHERE is_primary 兜住并发
        const insertedCanvas = await scoped.queryOne<{ id: string }>(
          `insert into public.canvases (project_id, name, is_primary, created_by)
           select p.id, $1, true, $2
             from public.projects p
            where p.id = $3
              and p.workspace_id = :workspace
           on conflict (project_id) where is_primary do nothing
           returning id`,
          ["Code 会话", input.userId, project.id],
        );
        const canvas =
          insertedCanvas ??
          (await scoped.queryOne<{ id: string }>(
            `select c.id
               from public.canvases c
               join public.projects p on p.id = c.project_id
              where c.project_id = $1
                and c.is_primary = true
                and p.workspace_id = :workspace`,
            [project.id],
          ));
        if (!canvas) {
          throw new Error(
            "[projects] Code 工作台主画布供给失败（未插入也未读到）。",
          );
        }

        return { canvasId: canvas.id, projectId: project.id };
      });
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
                  (workspace_id, name, slug, kind, description, work_dir, created_by)
           values (:workspace, $1, $2, $3, $4, $5, $6)
           returning ${PROJECT_CREATED_COLUMNS}`,
          [
            input.name,
            input.slug,
            input.kind ?? "design",
            input.description,
            input.workDir ?? null,
            input.userId,
          ],
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

    async findWorkDirByCanvas(workspaceId, canvasId) {
      const row = await persistence.forWorkspace(workspaceId).queryOne<{
        work_dir: string | null;
      }>(
        `select p.work_dir
           from public.canvases c
           join public.projects p on p.id = c.project_id
          where p.workspace_id = :workspace
            and c.id = $1
            and p.archived_at is null`,
        [canvasId],
      );
      return row?.work_dir ?? null;
    },
  };
}
