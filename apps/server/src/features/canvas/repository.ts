import type { PersistenceService } from "../persistence/types.js";
import { claimCanvasRootInTransaction } from "./root-directory.js";

export type CanvasRow = {
  id: string;
  name: string;
  project_id: string;
  content: unknown;
  root_directory?: string | null;
};

/**
 * canvas 聚合的数据访问（`canvases`）。
 * `canvases` 无 `instance_id` 列，故一律 JOIN `projects` 后施加谓词
 * （`FORM-9` 单一隔离入口）——归属校验与查询是同一条语句。
 */
export interface CanvasRepository {
  claimRoot(
    instanceId: string,
    canvasId: string,
    resolveDefault: (workDir: string | null) => Promise<string>,
  ): Promise<string>;
  /** 读画布（含内容）；不属本工作区或不存在均返回 null。 */
  findById(instanceId: string, canvasId: string): Promise<CanvasRow | null>;
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
  "c.id, c.name, c.project_id, c.content, c.root_directory";

export function createCanvasRepository(
  persistence: PersistenceService,
): CanvasRepository {
  return {
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
              and p.instance_id = :instance and p.archived_at is null`,
          [canvasId],
        );
      return row?.brand_kit_id ?? null;
    },

    async findById(instanceId, canvasId) {
      const row = await persistence.forInstance(instanceId).queryOne<CanvasRow>(
        `select ${CANVAS_COLUMNS}
             from public.canvases c
             join public.projects p on p.id = c.project_id
            where c.id = $1
              and p.instance_id = :instance and p.archived_at is null`,
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
            and p.instance_id = :instance and p.archived_at is null`,
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
