import type { PersistenceService } from "../persistence/types.js";
import { claimCanvasRootInTransaction } from "./root-directory.js";

export type CanvasRow = {
  id: string;
  name: string;
  project_id: string;
  content: unknown;
  root_directory?: string | null;
  is_primary?: boolean;
  deleted_at?: string | null;
};

/**
 * canvas 聚合的数据访问（`canvases`）。
 * `canvases` 无 `instance_id` 列，故一律 JOIN `projects` 后施加谓词
 * （`FORM-9` 单一隔离入口）——归属校验与查询是同一条语句。
 */
export interface CanvasRepository {
  notificationTarget(canvasId: string): Promise<{
    instance_id: string;
    project_id: string;
    deleted_at: string | null;
  } | null>;
  notifyChanged(instanceId: string, canvasId: string): Promise<void>;
  withDocumentLock<T>(
    instanceId: string,
    canvasId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  list(
    instanceId: string,
    projectId: string,
    query?: string,
  ): Promise<CanvasRow[]>;
  create(input: {
    instanceId: string;
    projectId: string;
    canvasId: string;
    name: string;
  }): Promise<CanvasRow | null>;
  rename(
    instanceId: string,
    canvasId: string,
    expectedName: string,
    name: string,
  ): Promise<number>;
  remove(instanceId: string, canvasId: string): Promise<number>;
  claimRoot(
    instanceId: string,
    canvasId: string,
    resolveDefault: (workDir: string | null) => Promise<string>,
  ): Promise<string>;
  /** 读画布（含内容）；不属本工作区或不存在均返回 null。 */
  findById(
    instanceId: string,
    canvasId: string,
    options?: { includeDeleted: boolean },
  ): Promise<CanvasRow | null>;
  /**
   * 由画布反查工作区（画布 → 项目链）。
   * 无工作区谓词可言（查的就是「这块画布属于谁」），故走根客户端；
   * 调用方是已鉴权的 agent 运行（画布 id 来自本次运行），不是外部输入。
   */
  /** 画布 → 项目 → 品牌套件 id（run 启动时解析 brandKitId 用，单条 JOIN）。 */
  findProjectBrandKitId(
    instanceId: string,
    canvasId: string,
  ): Promise<string | null>;
  /** 覆盖写画布内容；返回受影响行数（0 = 不存在或不属本工作区）。 */
  recordFileIndex(instanceId: string, canvasId: string): Promise<number>;
}

const CANVAS_COLUMNS =
  "c.id, c.name, c.project_id, c.content, c.root_directory, c.is_primary, c.deleted_at";

export function createCanvasRepository(
  persistence: PersistenceService,
): CanvasRepository {
  return {
    notificationTarget: (canvasId) =>
      persistence.queryOne(
        `select p.instance_id,c.project_id,c.deleted_at from public.canvases c
       join public.projects p on p.id=c.project_id where c.id=$1 and p.archived_at is null`,
        [canvasId],
      ),
    async notifyChanged(instanceId, canvasId) {
      await persistence.forInstance(instanceId).execute(
        `select pg_notify('kenfutwork_canvas_changed',$1::text) where exists
         (select 1 from public.canvases c join public.projects p on p.id=c.project_id
          where c.id=$1::uuid and p.instance_id=:instance and p.archived_at is null)`,
        [canvasId],
      );
    },
    withDocumentLock: (instanceId, canvasId, operation) =>
      persistence.withSessionTransaction(async (tx, signal) => {
        await tx
          .forInstance(instanceId)
          .execute(
            `select pg_advisory_xact_lock(hashtextextended('canvas-document:' || :instance || ':' || $1,0))`,
            [canvasId],
          );
        return operation(signal);
      }),
    async list(instanceId, projectId, query) {
      return persistence.forInstance(instanceId).query<CanvasRow>(
        `select ${CANVAS_COLUMNS} from public.canvases c
         join public.projects p on p.id=c.project_id
         where p.id=$1 and p.instance_id=:instance and p.archived_at is null
           and c.deleted_at is null and ($2::text is null or strpos(lower(c.name), lower($2)) > 0)
         order by c.is_primary desc, c.updated_at desc, c.id`,
        [projectId, query || null],
      );
    },
    async create(input) {
      return persistence.transaction(async (tx) => {
        const sql = tx.forInstance(input.instanceId);
        const project = await sql.queryOne(
          `select p.id from public.projects p where p.id=$1 and p.instance_id=:instance
           and p.archived_at is null and ('design'=any(p.enabled_modes) or 'flow'=any(p.enabled_modes)) for update`,
          [input.projectId],
        );
        if (!project) return null;
        const previous = await sql.queryOne<CanvasRow>(
          `select ${CANVAS_COLUMNS} from public.canvases c join public.projects p on p.id=c.project_id
           where c.id=$1 and p.instance_id=:instance and p.archived_at is null and c.deleted_at is null`,
          [input.canvasId],
        );
        if (previous)
          return previous.project_id === input.projectId &&
            previous.name === input.name
            ? previous
            : null;
        return sql.queryOne<CanvasRow>(
          `insert into public.canvases(id,project_id,name,is_primary,content)
           select $1,$2,$3,not exists(select 1 from public.canvases where project_id=$2 and is_primary and deleted_at is null),$4::jsonb
           from public.projects p where p.id=$2 and p.instance_id=:instance and p.archived_at is null
             and ('design'=any(p.enabled_modes) or 'flow'=any(p.enabled_modes))
           on conflict(id) do nothing
           returning id,name,project_id,content,root_directory,is_primary`,
          [
            input.canvasId,
            input.projectId,
            input.name,
            JSON.stringify({ elements: [], appState: {}, files: {} }),
          ],
        );
      });
    },
    rename(instanceId, canvasId, expectedName, name) {
      return persistence.forInstance(instanceId).execute(
        `update public.canvases c set name=$3 from public.projects p
         where c.id=$1 and c.name=$2 and c.deleted_at is null and p.id=c.project_id
           and p.instance_id=:instance and p.archived_at is null`,
        [canvasId, expectedName, name],
      );
    },
    remove(instanceId, canvasId) {
      return persistence.forInstance(instanceId).execute(
        `update public.canvases c set deleted_at=now(),is_primary=false from public.projects p
         where c.id=$1 and c.deleted_at is null and p.id=c.project_id
           and p.instance_id=:instance and p.archived_at is null`,
        [canvasId],
      );
    },
    claimRoot: (instanceId, canvasId, resolveDefault) =>
      persistence.transaction((tx) =>
        claimCanvasRootInTransaction(
          tx.forInstance(instanceId),
          canvasId,
          resolveDefault,
        ),
      ),
    async findProjectBrandKitId(instanceId, canvasId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ brand_kit_id: string | null }>(
          `select p.brand_kit_id
             from public.canvases c
             join public.projects p on p.id = c.project_id
            where c.id = $1
              and p.instance_id = :instance and p.archived_at is null and c.deleted_at is null`,
          [canvasId],
        );
      return row?.brand_kit_id ?? null;
    },

    async findById(instanceId, canvasId, options) {
      const row = await persistence.forInstance(instanceId).queryOne<CanvasRow>(
        `select ${CANVAS_COLUMNS}
             from public.canvases c
             join public.projects p on p.id = c.project_id
            where c.id = $1
              and p.instance_id = :instance and p.archived_at is null ${options?.includeDeleted ? "" : "and c.deleted_at is null"}`,
        [canvasId],
      );
      return row ?? null;
    },

    async recordFileIndex(instanceId, canvasId) {
      // jsonb 写入：显式序列化后由 cast 落库，避免驱动对对象做隐式推断。
      return persistence.forInstance(instanceId).execute(
        `update public.canvases c
            set content = $2::jsonb
           from public.projects p
          where p.id = c.project_id
            and c.id = $1
            and p.instance_id = :instance and p.archived_at is null and c.deleted_at is null`,
        [
          canvasId,
          JSON.stringify({
            storage: "project-files",
            path: `.kenfutwork/canvases/${canvasId}.json`,
          }),
        ],
      );
    },
  };
}
