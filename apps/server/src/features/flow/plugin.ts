import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerFlowHostRoutes } from "../../http/flow-host.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createViewerRepository } from "../bootstrap/repository.js";
import { createProcessRunCommand } from "./engine/exec.js";
import {
  type EngineInstallOptions,
  getEngineInstallSnapshot,
  startEngineInstall,
} from "./engine/install.js";
import { probeEnginePaths } from "./engine/probe.js";

/** 仓库根（探测 compose 文件与数据目录用；打包态由 KENFUTWORK_DATA_DIR 覆盖数据目录）。 */
function repoRoot(): string {
  // plugin.ts = apps/server/src/features/flow/ → 上溯 5 层到仓库根
  return fileURLToPath(new URL("../../../../..", import.meta.url));
}

/** 引擎栈托管选项（compose 文件 + env/日志的数据目录）。 */
function engineInstallOptions(): EngineInstallOptions {
  const dataRoot =
    process.env.KENFUTWORK_DATA_DIR?.trim() ||
    join(repoRoot(), ".kenfutwork-data");
  return {
    composeFile: join(repoRoot(), "docker-compose.dify.yml"),
    dataDir: dataRoot,
  };
}

/**
 * flow-host 插件：宿主适配层的宿主侧端点（`/api/flow/host/*`，`ff-embed/v1`）。
 *
 * 能力缝三元组：
 * - Service Definition：`ff-embed/v1` 契约（`packages/shared/src/flow-host.ts`）
 * - Service Provider：本插件注册的宿主侧路由（身份交换 + 凭证下发 + 计费三段事务 +
 *   引擎栈托管）
 * - Consumer：flow 网关的 embedded Provider（`flow/gateway/src/host/embedded-*.provider.ts`）
 *
 * 与 `plugins/flow` 的分工（FORM-11）：**这里**是基础设施（flow 网关回调宿主），
 * **插件**是产品入口（工作台 Flow 模式 + 引擎托管）。路由始终注册：status 是能力探针，
 * 未配齐也要如实回答 disabled 与缺失原因；身份/凭证/计费在未配密钥时按请求回 503
 * （不假装能用）。
 */
export function createFlowHostPlugin(deps: {
  /** `KENFUTWORK_FLOW_EMBED_SECRET`；缺省表示未启用。 */
  secret?: string | undefined;
  /** `KENFUTWORK_FLOW_FRONTEND_URL`；工作台 Flow 模式的 iframe src。 */
  frontendUrl?: string | undefined;
}): PluginDefinition {
  return {
    name: "flow-host",
    inject: [
      "auth",
      "viewer",
      "modelProviders",
      "credits",
      "persistence",
      "ws",
    ],
    apply(ctx) {
      if (!deps.secret?.trim() || !deps.frontendUrl?.trim()) {
        // 不视为错误：status 端点会如实回答 disabled + 缺什么，前端不摆空壳入口。
        console.log(
          "[flow] flow 宿主适配层未配齐（KENFUTWORK_FLOW_EMBED_SECRET / KENFUTWORK_FLOW_FRONTEND_URL）：" +
            "身份交换不可用，工作台不出现 Flow 模式入口（GET /api/flow/host/status 可查原因）。",
        );
      }
      ctx.effect(() => () => {
        // 路由由 Fastify 生命周期回收，这里只留一条可追溯日志（便于排查「明明配了却没生效」）。
        console.log("[flow] flow 宿主适配层路由已停用。");
      });
    },
    mounted(ctx) {
      // 宿主 subject（身份缝下发的宿主用户 id）→ 账号与个人工作区：
      // 身份缝的 subject 就是宿主 accounts.id，计费归属据此解析。
      const viewerRepository = createViewerRepository(ctx.get("persistence"));
      const accounts = {
        async findBySubject(subject: string) {
          const account = await ctx
            .get("persistence")
            .queryOne<{ id: string }>(
              "select id from public.accounts where id = $1",
              [subject],
            );
          if (!account) return null;
          const workspace =
            await viewerRepository.findPersonalWorkspace(subject);
          return { userId: subject, workspaceId: workspace?.id ?? null };
        },
      };

      void registerFlowHostRoutes(ctx.app, {
        auth: ctx.get("auth"),
        viewer: ctx.get("viewer"),
        providers: ctx.get("modelProviders"),
        credits: ctx.get("credits"),
        accounts,
        // 事件缝透出走内核声明的 ws 缝（app.ts 装配时注册 connectionManager/eventBuffer）。
        ws: { connectionManager: ctx.get("ws").connectionManager },
        // 引擎探测层 + 托管（FORM-11）：探测路径，确认后拉镜像起栈，状态可轮询。
        engine: {
          probe: () =>
            probeEnginePaths({
              platform: process.platform,
              release: os.release(),
              run: createProcessRunCommand(),
              listSystemInstances: () =>
                ctx.get("modelProviders").listSystemInstances(),
            }),
        },
        engineInstall: {
          start: () => startEngineInstall(engineInstallOptions()),
          status: () => getEngineInstallSnapshot(),
        },
        secret: deps.secret,
        frontendUrl: deps.frontendUrl,
      });
    },
  };
}
