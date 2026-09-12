import type { FastifyInstance } from "fastify";

/** 插件市场数据源：当前 profile 实际注册的插件清单（真实装配信息）。 */
export interface PluginCatalogEntry {
  name: string;
  title: string;
  description: string;
}

export async function registerPluginsRoutes(
  app: FastifyInstance,
  options: { catalog: PluginCatalogEntry[] },
) {
  app.get("/api/plugins", async () => ({ plugins: options.catalog }));
}
