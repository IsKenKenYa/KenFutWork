import { createBlobPlugin } from "../features/blob/plugin.js";
import { createCanvasPlugin } from "../features/canvas/plugin.js";
import { createExecutionScopesPlugin } from "../features/execution/plugin.js";
import { createGenerationTargetsPlugin } from "../features/generation/file-targets-plugin.js";
import { createJobLoopPlugin } from "../features/jobs/job-loop-plugin.js";
import { createJobsPlugin } from "../features/jobs/plugin.js";
import { createLocalInstancePlugin } from "../features/local-instance/plugin.js";
import { createModelProvidersPlugin } from "../features/model-providers/plugin.js";
import { persistencePlugin } from "../features/persistence/plugin.js";
import { createProjectFilesPlugin } from "../features/project-files/plugin.js";
import { createProjectsPlugin } from "../features/projects/plugin.js";
import { createQueuePlugin } from "../features/queue/plugin.js";
import { createSettingsPlugin } from "../features/settings/plugin.js";
import { createUploadsPlugin } from "../features/uploads/plugin.js";
import { createUsagePlugin } from "../features/usage/plugin.js";
import type { PluginDefinition } from "../kernel/types.js";

/**
 * worker profile（§4.9）：队列 worker 进程的插件清单——唯一属主。
 * 与 server profile 同源演进，注册清单漂移在编译期消失（§8 风险对策）。
 * 生成 provider 的按 env 注册（register-all）为迁移期遗留，BYOK 切换后退役。
 */

export function workerProfile(): PluginDefinition[] {
  return [
    persistencePlugin,
    createLocalInstancePlugin({ withHttpLifecycle: false }),
    createQueuePlugin(),
    createBlobPlugin({ withRoutes: false }),
    // worker 无 HTTP 面：路由一律不挂（withRoutes: false），只取服务
    createJobsPlugin({ withRoutes: false }),
    createUsagePlugin({ withRoutes: false }),
    // 只取 assetWriter 缝（生成物元数据写入）；路由与上传服务不注册
    createUploadsPlugin({ withRoutes: false }),
    createModelProvidersPlugin(),
    createSettingsPlugin(),
    createProjectsPlugin({ withRoutes: false }),
    createCanvasPlugin({ withRoutes: false }),
    createExecutionScopesPlugin({ withRoutes: false }),
    createProjectFilesPlugin(),
    createGenerationTargetsPlugin(),
    createJobLoopPlugin({ enabled: () => true }),
  ];
}
