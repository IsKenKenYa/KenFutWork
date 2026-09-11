import type { FastifyInstance } from "fastify";

import type { ServerEnv } from "../config/env.js";
import { registerFontsRoutes } from "./fonts.js";
import { registerHealthRoutes } from "./health.js";
import { registerImageProxyRoute } from "./image-proxy.js";

/** 基础设施路由（health/fonts/image-proxy），供 app.ts 一行挂载。 */
export function registerInfraRoutes(app: FastifyInstance, env: ServerEnv) {
  void registerHealthRoutes(app, env);
  void registerFontsRoutes(app, { env });
  void registerImageProxyRoute(app);
}
