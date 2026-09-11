import type { PluginDefinition } from "../kernel/types.js";
import { createSupabaseRequestAuthenticator } from "./user.js";

/** auth 插件（P8 收编）：Supabase JWT 认证（目标 local-trust / 自管 auth，随《多端》D1+ 替换 Provider）。 */
export const authPlugin: PluginDefinition = {
  name: "auth",
  inject: [],
  apply(ctx) {
    ctx.register("auth", () => createSupabaseRequestAuthenticator(ctx.env));
  },
};
