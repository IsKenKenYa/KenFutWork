import type { AdditionalDirectory, ProjectKind } from "@kenfutwork/shared";

import type {
  PersistenceService,
  SqlTransaction,
} from "../persistence/types.js";

export type ProjectListRow = {
  id: string;
  name: string;
  slug: string;
  kind: ProjectKind;
  enabled_modes: ProjectKind[];
  description: string | null;
  created_at: string;
  updated_at: string;
  instance_id: string;
  thumbnail_path: string | null;
  work_dir: string | null;
  additional_directories: AdditionalDirectory[];
};

export type ProjectDetailRow = {
  id: string;
  kind: ProjectKind;
  enabled_modes: ProjectKind[];
  name: string;
  slug: string;
  description: string | null;
  instance_id: string;
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
  enabled_modes: ProjectKind[];
  description: string | null;
  created_at: string;
  updated_at: string;
  instance_id: string;
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
  enabledModes?: ProjectKind[];
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
  directoryChoice?: "independent";
  createdByClientId: string | null;
  instanceId: string;
};

export class ProjectDirectoryConflictError extends Error {
  constructor() {
    super("此目录已关联项目，请选择复用或独立创建。");
  }
}

/** 创建与恢复关联必须争用同一把目录锁；目录已由服务层归一化。 */
export function projectDirectoryLockKey(instanceId: string, path: string) {
  return JSON.stringify([instanceId, path]);
}

/**
 * projects 聚合的数据访问（`projects`/`canvases`）。
 * 隔离口径：`projects` 直接带 `instance_id` 谓词；`canvases` 无该列，一律
 * JOIN `projects` 后施加谓词（`FORM-9` 单一隔离入口）。
 */
export interface ProjectRepository {
  findDirectoryProjects(
    instanceId: string,
    path: string,
  ): Promise<ProjectDetailRow[]>;
  beginCloseProject(instanceId: string, projectId: string): Promise<void>;
  failCloseProject(instanceId: string, projectId: string): Promise<void>;
  /** 归档（软删）活跃项目；返回受影响行数（0 = 不存在或已归档）。 */
  archive(instanceId: string, projectId: string): Promise<number>;
  /** 建项目 + 主画布，同一事务（原子性不依赖 DB 函数）。 */
  createProject(input: CreateProjectInput): Promise<{
    canvas: CreatedCanvasRow | null;
    project: CreatedProjectRow;
  }>;
  findActiveById(
    instanceId: string,
    projectId: string,
  ): Promise<ProjectDetailRow | null>;
  listActive(instanceId: string, kind?: ProjectKind): Promise<ProjectListRow[]>;
  /** 取这批项目的主画布（跨项目一次查询）。 */
  listPrimaryCanvases(
    instanceId: string,
    projectIds: readonly string[],
  ): Promise<PrimaryCanvasRow[]>;
  /** 缩略图对象路径——供 blob 存储路径拼装（同工作区校验）。 */
  setThumbnailPath(
    instanceId: string,
    projectId: string,
    thumbnailPath: string,
  ): Promise<number>;
  /**
   * 画布 → 所属项目绑定的工作目录（Code 模式绑定本机目录）。
   *
   * 谓词经 `projects.instance_id` 施加（canvases 无该列），因此「画布不属于本工作区」
   * 与「未绑定」都回 null，不泄露其它工作区的绑定情况。
   */
  findWorkDirByCanvas(
    instanceId: string,
    canvasId: string,
  ): Promise<string | null>;
  update(
    instanceId: string,
    projectId: string,
    patch: ProjectUpdatePatch,
  ): Promise<number>;
}

const PROJECT_LIST_COLUMNS =
  "id, name, slug, kind, description, created_at, updated_at, instance_id, thumbnail_path, work_dir, additional_directories, enabled_modes";
const PROJECT_DETAIL_COLUMNS =
  "id, name, slug, kind, description, instance_id, brand_kit_id, created_at, updated_at, work_dir, additional_directories, enabled_modes";
const PROJECT_CREATED_COLUMNS =
  "id, name, slug, kind, description, created_at, updated_at, instance_id, work_dir, additional_directories, enabled_modes";

export function createProjectRepository(
  persistence: PersistenceService,
): ProjectRepository {
  return {
    async findDirectoryProjects(instanceId, path) {
      return persistence.forInstance(instanceId).query<ProjectDetailRow>(
        `select ${PROJECT_DETAIL_COLUMNS} from public.projects
          where instance_id=:instance and work_dir=$1 and archived_at is null
          order by created_at,id`,
        [path],
      );
    },
    async beginCloseProject(instanceId, projectId) {
      await persistence.forInstance(instanceId).execute(
        `update public.code_ui_sessions set execution_state = 'revoking',
                scope_generation = scope_generation + 1, branch_generation = branch_generation + 1
          where instance_id = :instance and project_id = $1 and deleted_at is null`,
        [projectId],
      );
    },
    async failCloseProject(instanceId, projectId) {
      await persistence.forInstance(instanceId).execute(
        `update public.code_ui_sessions set execution_state = 'failed'
          where instance_id = :instance and project_id = $1 and execution_state = 'revoking'`,
        [projectId],
      );
    },
    async listActive(instanceId, kind = "design") {
      return persistence.forInstance(instanceId).query<ProjectListRow>(
        `select ${PROJECT_LIST_COLUMNS}
           from public.projects
          where instance_id = :instance
            and archived_at is null
            and $1 = any(enabled_modes)
          order by updated_at desc`,
        [kind],
      );
    },

    async listPrimaryCanvases(instanceId, projectIds) {
      if (projectIds.length === 0) {
        return [];
      }

      return persistence.forInstance(instanceId).query<PrimaryCanvasRow>(
        `select c.id, c.name, c.is_primary, c.project_id
           from public.canvases c
           join public.projects p on p.id = c.project_id
          where p.instance_id = :instance
            and c.is_primary = true and c.deleted_at is null
            and c.project_id = any($1::uuid[])`,
        [projectIds],
      );
    },

    async findActiveById(instanceId, projectId) {
      return persistence.forInstance(instanceId).queryOne<ProjectDetailRow>(
        `select ${PROJECT_DETAIL_COLUMNS}
           from public.projects
          where instance_id = :instance
            and id = $1
            and archived_at is null`,
        [projectId],
      );
    },

    async archive(instanceId, projectId) {
      return persistence.forInstance(instanceId).execute(
        `update public.projects
            set archived_at = now()
          where instance_id = :instance
            and id = $1
            and archived_at is null`,
        [projectId],
      );
    },

    async update(instanceId, projectId, patch) {
      const assignments: string[] = [];
      // $1 固定是 project_id；SET 的占位符从 $2 起编号。
      const values: unknown[] = [projectId];
      let brandKitFilter = "";
      let fixedRootFilter = "";

      if (patch.name !== undefined) {
        values.push(patch.name);
        assignments.push(`name = $${values.length}`);
      }
      if (patch.brandKitId !== undefined) {
        values.push(patch.brandKitId);
        assignments.push(`brand_kit_id = $${values.length}`);
        brandKitFilter = `and ($${values.length}::uuid is null or exists (select 1 from public.brand_kits k where k.id = $${values.length}::uuid and k.instance_id = :instance))`;
      }
      if (patch.workDir !== undefined) {
        values.push(patch.workDir);
        assignments.push(`work_dir = $${values.length}`);
        fixedRootFilter = `and work_dir is not distinct from $${values.length}::text`;
      }

      if (patch.additionalDirectories !== undefined) {
        values.push(JSON.stringify(patch.additionalDirectories));
        assignments.push(`additional_directories = $${values.length}::jsonb`);
      }

      if (patch.enabledModes !== undefined) {
        values.push(patch.enabledModes);
        assignments.push(`enabled_modes = $${values.length}::text[]`);
      }

      if (assignments.length === 0) {
        return 0;
      }

      return persistence.forInstance(instanceId).execute(
        `update public.projects
            set ${assignments.join(", ")}
          where instance_id = :instance
            and id = $1
            ${brandKitFilter} ${fixedRootFilter}`,
        values,
      );
    },

    async createProject(input) {
      const create = async (tx: SqlTransaction) => {
        const scoped = tx.forInstance(input.instanceId);

        if (input.workDir && input.kind !== "flow") {
          await tx.query(
            "select pg_advisory_xact_lock(hashtextextended($1,0))",
            [projectDirectoryLockKey(input.instanceId, input.workDir)],
          );
          const existing = await scoped.queryOne<{ id: string }>(
            "select id from public.projects where instance_id=:instance and work_dir=$1 and archived_at is null limit 1",
            [input.workDir],
          );
          if (existing && input.directoryChoice !== "independent")
            throw new ProjectDirectoryConflictError();
        }

        const project = await scoped.queryOne<CreatedProjectRow>(
          `insert into public.projects
                  (id, instance_id, name, slug, kind, description, work_dir, created_by_client_id, additional_directories, enabled_modes)
           values (coalesce($7::uuid, gen_random_uuid()), :instance, $1, $2, $3, $4, $5, $6, $8::jsonb, $9::text[])
           returning ${PROJECT_CREATED_COLUMNS}`,
          [
            input.name,
            input.slug,
            input.kind ?? "design",
            input.description,
            input.workDir ?? null,
            input.createdByClientId,
            input.id ?? null,
            JSON.stringify(input.additionalDirectories ?? []),
            [input.kind ?? "design"],
          ],
        );

        if (!project) {
          throw new Error("[projects] 建项目未返回行。");
        }

        if (project.kind !== "flow") return { canvas: null, project };

        const canvas = await scoped.queryOne<CreatedCanvasRow>(
          // canvases 无 instance_id 列：经 projects 父链施加谓词，
          // 守卫因此同时是「该项目确属本工作区」的归属校验。
          `insert into public.canvases (project_id, name, is_primary, created_by_client_id, root_directory)
           select p.id, $1, true, $2, $4
             from public.projects p
            where p.id = $3
              and p.instance_id = :instance
           returning id, name, is_primary`,
          [
            input.canvasName,
            input.createdByClientId,
            project.id,
            input.workDir ?? null,
          ],
        );

        if (!canvas) {
          throw new Error("[projects] 建主画布未返回行。");
        }

        return { canvas, project };
      };
      // 等待目录锁不得占普通查询池；恢复关联需要该池关闭已有 Task 资源。
      return input.workDir && input.kind !== "flow"
        ? persistence.withSessionTransaction((tx, signal) => {
            signal.throwIfAborted();
            return create(tx);
          })
        : persistence.transaction(create);
    },

    async setThumbnailPath(instanceId, projectId, thumbnailPath) {
      return persistence.forInstance(instanceId).execute(
        `update public.projects
            set thumbnail_path = $1
          where instance_id = :instance
            and id = $2`,
        [thumbnailPath, projectId],
      );
    },

    async findWorkDirByCanvas(instanceId, canvasId) {
      const row = await persistence.forInstance(instanceId).queryOne<{
        work_dir: string | null;
        additional_directories: AdditionalDirectory[];
      }>(
        `select p.work_dir
           from public.canvases c
           join public.projects p on p.id = c.project_id
          where p.instance_id = :instance
            and c.id = $1
            and p.archived_at is null and ('design' = any(p.enabled_modes) or p.kind = 'flow')`,
        [canvasId],
      );
      return row?.work_dir ?? null;
    },
  };
}
