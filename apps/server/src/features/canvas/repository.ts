import type { PersistenceService } from "../persistence/types.js";

export type CanvasRow = {
  id: string;
  name: string;
  project_id: string;
  content: unknown;
};

/**
 * canvas 聚合的数据访问（`canvases`）。
 * `canvases` 无 `workspace_id` 列，故一律 JOIN `projects` 后施加谓词
 * （`FORM-9` 单一隔离入口）——归属校验与查询是同一条语句。
 */
export interface CanvasRepository {
  /** 读画布（含内容）；不属本工作区或不存在均返回 null。 */
  findById(workspaceId: string, canvasId: string): Promise<CanvasRow | null>;
  /** 覆盖写画布内容；返回受影响行数（0 = 不存在或不属本工作区）。 */
  saveContent(
    workspaceId: string,
    canvasId: string,
    content: unknown,
  ): Promise<number>;
}

const CANVAS_COLUMNS = "c.id, c.name, c.project_id, c.content";

export function createCanvasRepository(
  persistence: PersistenceService,
): CanvasRepository {
  return {
    async findById(workspaceId, canvasId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<CanvasRow>(
          `select ${CANVAS_COLUMNS}
             from public.canvases c
             join public.projects p on p.id = c.project_id
            where c.id = $1
              and p.workspace_id = :workspace`,
          [canvasId],
        );
      return row ?? null;
    },

    async saveContent(workspaceId, canvasId, content) {
      // jsonb 写入：显式序列化后由 cast 落库，避免驱动对对象做隐式推断。
      return persistence.forWorkspace(workspaceId).execute(
        `update public.canvases c
            set content = $2::jsonb
           from public.projects p
          where p.id = c.project_id
            and c.id = $1
            and p.workspace_id = :workspace`,
        [canvasId, JSON.stringify(content)],
      );
    },
  };
}
