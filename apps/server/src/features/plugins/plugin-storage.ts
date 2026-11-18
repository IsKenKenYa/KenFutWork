import type { PersistenceService } from "../persistence/types.js";

/**
 * 插件存储（能力 `storage`）：按「工作区 + 插件 + 键」存字符串值，值在本地数据库中明文保存。
 *
 * 为什么放在内核侧：第三方 bundle 被门禁禁止直连文件系统、也拿不到 DB 面，
 * 需要跨重启存活状态（第三方集成的会话凭证等）的插件此前无路可走。这里把唯一入口
 * 收在内核，不落日志，HTTP 面不直接暴露插件私有状态，
 * 只有插件在进程内运行时可读。
 *
 * 隔离与生命周期：
 * - 隔离走其它工作区数据同一条缝（`FORM-9`：应用层强制 `:instance` 谓词，漏写即失败）；
 * - 插件「停用」保留数据，「卸载」由 registry 调 `purgePlugin` 清空（卸载要卸干净）。
 */

export interface PluginStorage {
  /** 未存过返回 null（空串是合法值，两者不混）。 */
  get(
    instanceId: string,
    pluginId: string,
    key: string,
  ): Promise<string | null>;
  set(
    instanceId: string,
    pluginId: string,
    key: string,
    value: string,
  ): Promise<void>;
  remove(instanceId: string, pluginId: string, key: string): Promise<boolean>;
  keys(instanceId: string, pluginId: string): Promise<string[]>;
  /** 卸载清理：删除该插件的全部记录（跨实例），返回删除行数。 */
  purgePlugin(pluginId: string): Promise<number>;
}

/**
 * 入参校验 fail loud：缺工作区是最危险的错法（会把数据写到「不该有的作用域」），
 * 而静默兜底（例如用默认工作区）会让插件以为自己写对了。
 */
function require(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `[plugin-storage] 缺少${field}，拒绝访问插件存储（fail loud）。`,
    );
  }
  return value;
}

function requireValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(
      "[plugin-storage] 值必须是字符串（结构化数据请自行 JSON 序列化；fail loud）。",
    );
  }
  return value;
}

export function createPluginStorage(options: {
  persistence: PersistenceService;
}): PluginStorage {
  const { persistence } = options;

  return {
    async get(instanceId, pluginId, key) {
      const row = await persistence
        .forInstance(require(instanceId, "实例"))
        .queryOne<{ value_text: string }>(
          `select value_text
             from public.plugin_storage
            where instance_id = :instance
              and plugin_id = $1
              and entry_key = $2`,
          [require(pluginId, "插件 id"), require(key, "键")],
        );
      return row ? row.value_text : null;
    },

    async set(instanceId, pluginId, key, value) {
      await persistence.forInstance(require(instanceId, "实例")).execute(
        `insert into public.plugin_storage
             (instance_id, plugin_id, entry_key, value_text)
           values (:instance, $1, $2, $3)
           on conflict (instance_id, plugin_id, entry_key)
           do update set value_text = excluded.value_text,
                         updated_at = now()`,
        [require(pluginId, "插件 id"), require(key, "键"), requireValue(value)],
      );
    },

    async remove(instanceId, pluginId, key) {
      const affected = await persistence
        .forInstance(require(instanceId, "实例"))
        .execute(
          `delete from public.plugin_storage
            where instance_id = :instance
              and plugin_id = $1
              and entry_key = $2`,
          [require(pluginId, "插件 id"), require(key, "键")],
        );
      return affected > 0;
    },

    async keys(instanceId, pluginId) {
      const rows = await persistence
        .forInstance(require(instanceId, "实例"))
        .query<{ entry_key: string }>(
          `select entry_key
             from public.plugin_storage
            where instance_id = :instance
              and plugin_id = $1
            order by entry_key asc`,
          [require(pluginId, "插件 id")],
        );
      return rows.map((row) => row.entry_key);
    },

    async purgePlugin(pluginId) {
      // 卸载清理是跨实例的实例级动作：卸载谁的插件就该清干净谁的键，
      // 因此走根客户端（无 `:instance` 谓词）而不是某个工作区作用域。
      return persistence.execute(
        "delete from public.plugin_storage where plugin_id = $1",
        [require(pluginId, "插件 id")],
      );
    },
  };
}
