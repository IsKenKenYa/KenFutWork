import type { FastifyInstance } from "fastify";
import { PLUGIN_CATALOG } from "../profiles/server.js";
import { registerPluginsRoutes } from "./plugins.js";

/** 插件市场路由（真实装配清单）。 */
export function registerPluginMarketRoutes(app: FastifyInstance) {
  void registerPluginsRoutes(app, { catalog: PLUGIN_CATALOG });
}
