import type { PersistenceService } from "../persistence/types.js";

/**
 * 插件存储（能力 `storage`）：按「工作区 + 插件 + 键」存字符串值，**值加密落库**。
 *
 * 为什么放在内核侧：第三方 bundle 被门禁禁止直连文件系统、也拿不到 DB 面，
 * 需要跨重启存活状态（第三方集成的会话凭证等）的插件此前无路可走。这里把唯一入口
 * 收在内核，口径与 BYOK 凭证同一条红线——加密写入、不落日志、HTTP 面永不回显，
 * 只有插件在进程内运行时可读。
 *
 * 隔离与生命周期：
 * - 隔离走其它工作区数据同一条缝（`FORM-9`：应用层强制 `:workspace` 谓词，漏写即失败）；
 * - 插件「停用」保留数据，「卸载」由 registry 调 `purgePlugin` 清空（卸载要卸干净）。
 */

export interface PluginStorageCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export interface PluginStorage {
  /** 未存过返回 null（空串是合法值，两者不混）。 */
  get(
    workspaceId: string,
    pluginId: string,
    key: string,
  ): Promise<string | null>;
  set(
    workspaceId: string,
    pluginId: string,
    key: string,
    value: string,
  ): Promise<void>;
  remove(workspaceId: string, pluginId: string, key: string): Promise<boolean>;
  keys(workspaceId: string, pluginId: string): Promise<string[]>;
  /** 卸载清理：删除该插件的全部记录（跨工作区），返回删除行数。 */
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
  /** 加解密由调用方注入：插件存储复用凭证缝的 AES-256-GCM，避免第二套密钥口径。 */
  cipher: PluginStorageCipher;
}): PluginStorage {
  const { persistence, cipher } = options;

  return {
    async get(workspaceId, pluginId, key) {
      const row = await persistence
        .forWorkspace(require(workspaceId, "工作区"))
        .queryOne<{ value_ciphertext: string }>(
          `select value_ciphertext
             from public.plugin_storage
            where workspace_id = :workspace
              and plugin_id = $1
              and entry_key = $2`,
          [require(pluginId, "插件 id"), require(key, "键")],
        );
      return row ? cipher.decrypt(row.value_ciphertext) : null;
    },

    async set(workspaceId, pluginId, key, value) {
      await persistence.forWorkspace(require(workspaceId, "工作区")).execute(
        `insert into public.plugin_storage
             (workspace_id, plugin_id, entry_key, value_ciphertext)
           values (:workspace, $1, $2, $3)
           on conflict (workspace_id, plugin_id, entry_key)
           do update set value_ciphertext = excluded.value_ciphertext,
                         updated_at = now()`,
        [
          require(pluginId, "插件 id"),
          require(key, "键"),
          cipher.encrypt(requireValue(value)),
        ],
      );
    },

    async remove(workspaceId, pluginId, key) {
      const affected = await persistence
        .forWorkspace(require(workspaceId, "工作区"))
        .execute(
          `delete from public.plugin_storage
            where workspace_id = :workspace
              and plugin_id = $1
              and entry_key = $2`,
          [require(pluginId, "插件 id"), require(key, "键")],
        );
      return affected > 0;
    },

    async keys(workspaceId, pluginId) {
      const rows = await persistence
        .forWorkspace(require(workspaceId, "工作区"))
        .query<{ entry_key: string }>(
          `select entry_key
             from public.plugin_storage
            where workspace_id = :workspace
              and plugin_id = $1
            order by entry_key asc`,
          [require(pluginId, "插件 id")],
        );
      return rows.map((row) => row.entry_key);
    },

    async purgePlugin(pluginId) {
      // 卸载清理是跨工作区的实例级动作：卸载谁的插件就该清干净谁的键，
      // 因此走根客户端（无 `:workspace` 谓词）而不是某个工作区作用域。
      return persistence.execute(
        "delete from public.plugin_storage where plugin_id = $1",
        [require(pluginId, "插件 id")],
      );
    },
  };
}
