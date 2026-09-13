import { createCreditsPlugin } from "../features/credits/plugin.js";
import { createJobsPlugin } from "../features/jobs/plugin.js";
import { createModelProvidersPlugin } from "../features/model-providers/plugin.js";
import { persistencePlugin } from "../features/persistence/plugin.js";
import { createUsagePlugin } from "../features/usage/plugin.js";
import type { PluginDefinition } from "../kernel/types.js";
import type { AdminSupabaseClient } from "../supabase/admin.js";
import type { UserSupabaseClient } from "../supabase/user.js";

/**
 * worker profile（§4.9）：队列 worker 进程的插件清单——唯一属主。
 * 与 server profile 同源演进，注册清单漂移在编译期消失（§8 风险对策）。
 * 生成 provider 的按 env 注册（register-all）为迁移期遗留，BYOK 切换后退役。
 */

export interface WorkerProfileDeps {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  credentialEnv: { credentialSecret?: string };
}

export function workerProfile(deps: WorkerProfileDeps): PluginDefinition[] {
  return [
    persistencePlugin,
    // worker 无 HTTP 面：路由一律不挂（withRoutes: false），只取服务
    createCreditsPlugin({ withRoutes: false }),
    createJobsPlugin({ withRoutes: false }),
    createUsagePlugin({ withRoutes: false }),
    createModelProvidersPlugin({
      credentialEnv: deps.credentialEnv,
      withRoutes: false,
    }),
  ];
}
