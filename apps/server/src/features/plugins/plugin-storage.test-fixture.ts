import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * 插件存储测试夹具（仅测试用，不进产品运行路径）。
 *
 * 真实实现是 `plugin-storage.ts`（按「实例 + 插件 + 键」存字符串、值明文落本机库）。
 * 这里给一个**文件持久**的同形实现：把 storage 换成新实例、只保留文件，就能复现
 * 「服务端重启后（进程内存为空）仍能读回配置」这条插件生命周期口径。
 */

export interface PersistentPluginStorage {
  /** 卸载时被 purge 的插件 id 记录（断言「卸载清干净」）。 */
  purged: string[];
  /** 行视图（键=`[实例, 插件, 键]` 的 JSON）：断言「存进去的到底是什么」。 */
  rows: Map<string, string>;
  /** 交给 `createPluginRegistryService` 的 storage 依赖。 */
  storage: {
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
    purgePlugin(pluginId: string): Promise<number>;
  };
}

class FileRows extends Map<string, string> {
  constructor(private readonly file: string) {
    super();
    if (!existsSync(file)) return;
    const entries: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(entries)) throw new Error("持久插件夹具格式无效。");
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "string"
      ) {
        throw new Error("持久插件夹具条目无效。");
      }
      super.set(entry[0], entry[1]);
    }
  }

  private persist() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this]), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  override set(key: string, value: string): this {
    super.set(key, value);
    this.persist();
    return this;
  }

  override delete(key: string): boolean {
    const removed = super.delete(key);
    if (removed) this.persist();
    return removed;
  }
}

/** 行键 = `[实例, 插件, 键]`（与真实实现的复合主键同形）。 */
const rowKey = (instanceId: string, pluginId: string, key: string) =>
  JSON.stringify([instanceId, pluginId, key]);

export function createPersistentPluginStorage(
  file: string,
): PersistentPluginStorage {
  const rows = new FileRows(file);
  const purged: string[] = [];
  return {
    purged,
    rows,
    storage: {
      async get(instanceId, pluginId, key) {
        return rows.get(rowKey(instanceId, pluginId, key)) ?? null;
      },
      async set(instanceId, pluginId, key, value) {
        rows.set(rowKey(instanceId, pluginId, key), value);
      },
      async remove(instanceId, pluginId, key) {
        return rows.delete(rowKey(instanceId, pluginId, key));
      },
      async keys(instanceId, pluginId) {
        return [...rows.keys()]
          .map((raw) => JSON.parse(raw) as [string, string, string])
          .filter(([id, plugin]) => id === instanceId && plugin === pluginId)
          .map(([, , key]) => key)
          .sort();
      },
      async purgePlugin(pluginId) {
        purged.push(pluginId);
        let removed = 0;
        for (const raw of [...rows.keys()]) {
          const [, plugin] = JSON.parse(raw) as [string, string, string];
          if (plugin === pluginId && rows.delete(raw)) removed += 1;
        }
        return removed;
      },
    },
  };
}
