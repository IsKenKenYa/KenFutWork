import type { PersistenceService } from "../persistence/types.js";

/** 检查点种类：baseline 预留（目录首快照语义上也是 turn 的第一笔）/ turn 轮次 / restore 回滚。 */
export type CheckpointKind = "baseline" | "turn" | "restore";

/** 检查点行（领域形状，camelCase；表列是 snake_case，由 SQL 仓储映射）。 */
export interface CheckpointRow {
  /** 应用层 randomUUID 生成，不走 DB 默认值。 */
  id: string;
  workspaceId: string;
  canvasId: string;
  /** 产生该检查点的 run；restore 检查点无 run，为 null。 */
  runId: string | null;
  kind: CheckpointKind;
  label: string;
  /** 影子仓库里的提交 sha。 */
  shadowCommit: string;
  /** 相对上一检查点的变化文件数。 */
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** ISO 8601；getPrevious 的比较基准。 */
  createdAt: string;
}

/**
 * 检查点聚合的数据访问（`public.project_checkpoints`）。
 * 工作区隔离经持久化缝的 `forWorkspace` 谓词（`FORM-9`）：每条语句显式引用
 * `:workspace`，漏写即执行前报错——归属校验与查询是同一条语句。
 *
 * 表 DDL 在切片4 的迁移里落地；真实库行为见 `checkpoint-repository.integration.test.ts`。
 */
export interface CheckpointRepository {
  insert(row: CheckpointRow): Promise<void>;
  /** 某画布的全部检查点，createdAt 升序。 */
  listByCanvas(workspaceId: string, canvasId: string): Promise<CheckpointRow[]>;
  /** 按 id 读单行；不存在或不属本工作区返回 null。 */
  getById(workspaceId: string, id: string): Promise<CheckpointRow | null>;
  /** 严格早于该时刻的最近一行（diff/统计的基准）；没有则 null。 */
  getPrevious(
    workspaceId: string,
    canvasId: string,
    createdAt: string,
  ): Promise<CheckpointRow | null>;
}

const CHECKPOINT_COLUMNS =
  "id, workspace_id, canvas_id, run_id, kind, label, shadow_commit, files_changed, insertions, deletions, created_at";

// type alias（而非 interface）才能获得隐式索引签名，满足 SqlRow 的泛型约束
type CheckpointDbRow = {
  id: string;
  workspace_id: string;
  canvas_id: string;
  run_id: string | null;
  kind: string;
  label: string;
  shadow_commit: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  created_at: string | Date;
};

/** DB 行 → 领域行：snake_case 转 camelCase，timestamptz 读回的 Date 转 ISO。 */
function toDomain(row: CheckpointDbRow): CheckpointRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    canvasId: row.canvas_id,
    runId: row.run_id,
    // kind 的取值集合由本模块的写入方约束（CheckpointKind），DB 侧是 text
    kind: row.kind as CheckpointKind,
    label: row.label,
    shadowCommit: row.shadow_commit,
    filesChanged: row.files_changed,
    insertions: row.insertions,
    deletions: row.deletions,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  };
}

export function createCheckpointRepository(
  persistence: PersistenceService,
): CheckpointRepository {
  return {
    async insert(row) {
      // workspace_id 不进参数：由客户端绑定的 :workspace 决定，杜绝参数错位跨区写
      await persistence.forWorkspace(row.workspaceId).execute(
        `insert into public.project_checkpoints
           (id, workspace_id, canvas_id, run_id, kind, label, shadow_commit,
            files_changed, insertions, deletions, created_at)
         values ($1, :workspace, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id,
          row.canvasId,
          row.runId,
          row.kind,
          row.label,
          row.shadowCommit,
          row.filesChanged,
          row.insertions,
          row.deletions,
          row.createdAt,
        ],
      );
    },

    async listByCanvas(workspaceId, canvasId) {
      const rows = await persistence
        .forWorkspace(workspaceId)
        .query<CheckpointDbRow>(
          `select ${CHECKPOINT_COLUMNS}
             from public.project_checkpoints
            where canvas_id = $1
              and workspace_id = :workspace
            order by created_at asc`,
          [canvasId],
        );
      return rows.map(toDomain);
    },

    async getById(workspaceId, id) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<CheckpointDbRow>(
          `select ${CHECKPOINT_COLUMNS}
             from public.project_checkpoints
            where id = $1
              and workspace_id = :workspace`,
          [id],
        );
      return row ? toDomain(row) : null;
    },

    async getPrevious(workspaceId, canvasId, createdAt) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<CheckpointDbRow>(
          `select ${CHECKPOINT_COLUMNS}
             from public.project_checkpoints
            where canvas_id = $1
              and created_at < $2
              and workspace_id = :workspace
            order by created_at desc
            limit 1`,
          [canvasId, createdAt],
        );
      return row ? toDomain(row) : null;
    },
  };
}

/** 内存实现：测试与部分装配用；行为与 SQL 版同口径（升序、工作区隔离、严格早于）。 */
export function createInMemoryCheckpointRepository(): CheckpointRepository {
  const rows: CheckpointRow[] = [];
  const byTime = (a: CheckpointRow, b: CheckpointRow): number =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return {
    async insert(row) {
      rows.push({ ...row });
    },
    async listByCanvas(workspaceId, canvasId) {
      return rows
        .filter((r) => r.workspaceId === workspaceId && r.canvasId === canvasId)
        .sort(byTime)
        .map((r) => ({ ...r }));
    },
    async getById(workspaceId, id) {
      const found = rows.find(
        (r) => r.workspaceId === workspaceId && r.id === id,
      );
      return found ? { ...found } : null;
    },
    async getPrevious(workspaceId, canvasId, createdAt) {
      const time = Date.parse(createdAt);
      const previous = rows
        .filter(
          (r) =>
            r.workspaceId === workspaceId &&
            r.canvasId === canvasId &&
            Date.parse(r.createdAt) < time,
        )
        .sort(byTime)
        .at(-1);
      return previous ? { ...previous } : null;
    },
  };
}
