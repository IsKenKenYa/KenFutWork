import type { PersistenceService } from "../persistence/types.js";

export type CanvasRow = {
  id: string;
  name: string;
  project_id: string;
  content: unknown;
};

/**
 * canvas 聚合的数据访问（`canvases`）。
 * `canvases` 无 `instance_id` 列，故一律 JOIN `projects` 后施加谓词
 * （`FORM-9` 单一隔离入口）——归属校验与查询是同一条语句。
 */
export interface CanvasRepository {
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
  saveContent(
    instanceId: string,
    canvasId: string,
    content: unknown,
  ): Promise<number>;
  /**
   * **原子追加**元素与文件（单条 SQL 内做 jsonb 合并）；返回受影响行数。
   *
   * 为什么必须原子：生成物落画布原先走「读 content → 追加 → 覆盖写」，两个任务并发
   * 落同一块画布时后写者会覆盖前者，**丢元素**（与《AGENTS.md》「持久副作用与幂等性」
   * 冲突）。把合并放进语句里，读-改-写之间就不存在窗口。
   *
   * 位置计算仍基于调用前的读取：并发插入**不会丢**元素，但可能算出相近落点（元素重叠，
   * 可拖动）。这是「不丢数据」与「不为落图加行锁」之间的取舍。
   */
  appendContent(
    instanceId: string,
    canvasId: string,
    input: {
      elements: readonly unknown[];
      files?: Record<string, unknown> | undefined;
    },
  ): Promise<number>;
}

const CANVAS_COLUMNS = "c.id, c.name, c.project_id, c.content";

export function createCanvasRepository(
  persistence: PersistenceService,
): CanvasRepository {
  return {
    async findProjectBrandKitId(instanceId, canvasId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ brand_kit_id: string | null }>(
          `select p.brand_kit_id
             from public.canvases c
             join public.projects p on p.id = c.project_id
            where c.id = $1
              and p.instance_id = :instance`,
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
              and p.instance_id = :instance`,
        [canvasId],
      );
      return row ?? null;
    },

    async saveContent(instanceId, canvasId, content) {
      // jsonb 写入：显式序列化后由 cast 落库，避免驱动对对象做隐式推断。
      return persistence.forInstance(instanceId).execute(
        `update public.canvases c
            set content = $2::jsonb
           from public.projects p
          where p.id = c.project_id
            and c.id = $1
            and p.instance_id = :instance`,
        [canvasId, JSON.stringify(content)],
      );
    },

    async appendContent(instanceId, canvasId, input) {
      // 合并全在语句内完成：elements 数组拼接、files 顶层键合并（缺失即建）。
      // 空 content（新建画布）与缺 elements/files 键都由 coalesce 兜住。
      return persistence.forInstance(instanceId).execute(
        `update public.canvases c
            set content = jsonb_set(
                  jsonb_set(
                    coalesce(c.content, '{}'::jsonb),
                    '{elements}',
                    coalesce(c.content -> 'elements', '[]'::jsonb) || $2::jsonb,
                    true
                  ),
                  '{files}',
                  coalesce(c.content -> 'files', '{}'::jsonb) || $3::jsonb,
                  true
                )
           from public.projects p
          where p.id = c.project_id
            and c.id = $1
            and p.instance_id = :instance`,
        [
          canvasId,
          JSON.stringify(input.elements),
          JSON.stringify(input.files ?? {}),
        ],
      );
    },
  };
}
