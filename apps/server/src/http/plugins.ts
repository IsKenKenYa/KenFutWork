import type { FastifyInstance } from "fastify";

/** 插件市场数据源：当前 profile 实际注册的插件清单（真实装配信息）。 */
export interface PluginCatalogEntry {
  name: string;
  title: string;
  description: string;
}

export interface PluginMarketEntry extends PluginCatalogEntry {
  /** 系统插件：内核必需，不可卸载。 */
  system: boolean;
  /** 当前安装状态（用户可对非系统插件卸载/重装）。 */
  installed: boolean;
}

/**
 * 插件安装态（进程内，按插件名）：
 * catalog 即装配清单，卸载=标记为未安装（能力入口停用），重装恢复。
 * 系统插件拒绝卸载（路由层 403 表达）。
 */
const SYSTEM_PLUGINS = new Set([
  "model-providers",
  "agent-runs",
  "permissions",
  "agent-modes",
  "canvas",
]);

const installOverrides = new Map<string, boolean>();

function resolveEntry(entry: PluginCatalogEntry): PluginMarketEntry {
  const system = SYSTEM_PLUGINS.has(entry.name);
  const installed = installOverrides.get(entry.name) ?? true;
  return { ...entry, system, installed };
}

export async function registerPluginsRoutes(
  app: FastifyInstance,
  options: { catalog: PluginCatalogEntry[] },
) {
  app.get("/api/plugins", async () => ({
    plugins: options.catalog.map(resolveEntry),
  }));

  app.post("/api/plugins/:name/install", async (request, reply) => {
    const { name } = request.params as { name: string };
    const entry = options.catalog.find((p) => p.name === name);
    if (!entry) {
      return reply.code(404).send({
        error: { code: "plugin_not_found", message: "插件不存在。" },
      });
    }
    installOverrides.set(name, true);
    return reply.code(200).send({ name, installed: true });
  });

  app.post("/api/plugins/:name/uninstall", async (request, reply) => {
    const { name } = request.params as { name: string };
    const entry = options.catalog.find((p) => p.name === name);
    if (!entry) {
      return reply.code(404).send({
        error: { code: "plugin_not_found", message: "插件不存在。" },
      });
    }
    if (SYSTEM_PLUGINS.has(name)) {
      return reply.code(403).send({
        error: { code: "plugin_not_removable", message: "系统插件不可卸载。" },
      });
    }
    installOverrides.set(name, false);
    return reply.code(200).send({ name, installed: false });
  });
}
