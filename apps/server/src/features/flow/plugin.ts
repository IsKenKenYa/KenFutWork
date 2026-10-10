import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FLOW_PLUGIN_BUNDLE_NAME } from "@kenfutwork/shared";
import { isPackagedRuntime, resolveEntryRoot } from "../../desktop/entry-root.js";
import { resolveDesktopDataDir } from "../../desktop/paths.js";
import { registerFlowHostRoutes } from "../../http/flow-host.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createProcessRunCommand } from "./engine/exec.js";
import {
  type EngineInstallOptions,
  getEngineInstallSnapshot,
  purgeEngineStack,
  readStackRuntime,
  startEngineInstall,
  stopEngineStack,
} from "./engine/install.js";
import { probeEnginePaths } from "./engine/probe.js";
import { listEngineStackContainers } from "./engine/stack.js";
import { createFlowIdentityTickets } from "./identity.js";

/**
 * 引擎资源目录（`dify/`，内含 `docker-compose.dify.yml` 与 `ssrf_proxy/squid.conf`）。
 *
 * 两种形态一条规则：**源码态**本模块 = `<repo>/apps/server/src/features/flow/plugin.ts`，
 * 上溯 5 级到仓库根；**打包态**资源与可执行体同级（Windows SEA = exe 目录、mac CJS =
 * `<app>`），由 `resolveEntryRoot` 解析（与 `runtime/`、`pg/` 同一口径）。
 */
function resolveDifyDir(): string {
  if (isPackagedRuntime(import.meta.url)) {
    return join(
      resolveEntryRoot({
        entryFileUrl: import.meta.url,
        execPath: process.execPath,
      }),
      "dify",
    );
  }
  return join(fileURLToPath(new URL("../../../../..", import.meta.url)), "dify");
}

/** 安装生成的密钥 env（存在才用于 compose 查询；信息页是只读路径，不创建）。 */
function stackEnvFile(options: EngineInstallOptions): string {
  return existsSync(join(options.dataDir, "dify-stack.env"))
    ? join(options.dataDir, "dify-stack.env")
    : "";
}

/** 引擎栈托管选项（compose 文件 + env/日志的数据目录；承载目标由调用方给或读落盘记录）。 */
function engineInstallOptions(
  dataRoot: string,
  launch?: EngineInstallOptions["launch"],
): EngineInstallOptions {
  return {
    composeFile: join(resolveDifyDir(), "docker-compose.dify.yml"),
    dataDir: dataRoot,
    ...(launch ? { launch } : {}),
  };
}

/** 本机数据目录（引擎 env/日志/承载记录都在这里）。 */
function dataRootFor(ctx: {
  env: { desktopDataDir?: string | undefined };
}): string {
  return resolveDesktopDataDir({
    env: { KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir },
  });
}

/**
 * flow-host 插件：宿主适配层的宿主侧端点（`/api/flow/host/*`，`ff-embed/v1`）。
 *
 * 能力缝三元组：
 * - Service Definition：`ff-embed/v1` 契约（`packages/shared/src/flow-host.ts`）
 * - Service Provider：本插件注册的宿主侧路由（本地能力探针 + 凭证下发；
 *   事件随 P5 接上）
 * - Consumer：flow 网关的 embedded Provider（`flow/gateway/src/host/embedded-*.provider.ts`）
 *
 * 与 `plugins/flow` 的分工（FORM-11）：**这里**是基础设施（flow 网关回调宿主），
 * **插件**是产品入口（工作台 Flow 模式 + 引擎托管）。路由始终注册：status 是能力探针，
 * 未配齐也要如实回答 disabled 与缺失原因；凭证回调在未配密钥时按请求回 503
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
      "localAccess",
      "localInstance",
      "modelProviders",
      "settings",
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
      /**
       * 引擎托管缝（ctx key `flowEngine`）：只暴露一个卸载钩子。
       * 用户口径（2026-10-09）：卸载 flow 插件 = 把引擎（容器/卷/镜像 + 本地 env/日志/记录）
       * 删掉，下次安装重新下载；**插件代码与 compose 资源保留**，否则无法二次安装。
       */
      ctx.register("flowEngine", () => ({
        purgeForPlugin: async (pluginId: string) => {
          if (!pluginId.endsWith(FLOW_PLUGIN_BUNDLE_NAME)) return { ok: true };
          const dataRoot = dataRootFor(ctx);
          return purgeEngineStack({
            ...engineInstallOptions(dataRoot),
            launch: readStackRuntime(dataRoot),
          });
        },
      }));
      ctx.effect(() => () => {
        // 路由由 Fastify 生命周期回收，这里只留一条可追溯日志（便于排查「明明配了却没生效」）。
        console.log("[flow] flow 宿主适配层路由已停用。");
      });
    },
    mounted(ctx) {
      // 本地实例身份缝（DEC-20）：一次性短时票据在内存里存哈希（同本机接入 connect 票据）。
      const identityTickets = createFlowIdentityTickets();
      void registerFlowHostRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        localInstance: ctx.get("localInstance"),
        providers: ctx.get("modelProviders"),
        // 事件缝透出走内核声明的 ws 缝（app.ts 装配时注册 connectionManager/eventBuffer）。
        ws: {
          connectionManager: ctx.get("ws").connectionManager,
          // P5：flowRun 事件入缓冲，断线走 `flow.resume` 补发
          eventBuffer: ctx.get("ws").eventBuffer,
        },
        // 身份缝：宿主前端换票（本机接入）→ flow 网关回验（共享密钥）→ 稳定 subject。
        identity: {
          issue: async (actor) => {
            const settings = await ctx
              .get("settings")
              .getInstanceSettings(actor, actor.instanceId);
            return identityTickets.issue({
              instanceId: actor.instanceId,
              accessClientId: actor.accessClientId,
              ttlMs: settings.localAccessTicketTtlMs,
            });
          },
          verify: async (token) => {
            const entry = identityTickets.consume(token);
            if (!entry) return null;
            // 票据只在本实例签发：归属必须与当前实例一致（防跨实例拼装）。
            const context = await ctx.get("localInstance").getContext();
            if (entry.instanceId !== context.instanceId) return null;
            return { subject: context.instanceId, displayName: "本机" };
          },
        },
        // 引擎探测层 + 托管（FORM-11）：探测路径，确认后拉镜像起栈，状态可轮询。
        engine: {
          probe: () =>
            probeEnginePaths({
              platform: process.platform,
              release: os.release(),
              run: createProcessRunCommand(),
              listInstances: async () => ctx.get("modelProviders").listInstances(await ctx.get("localInstance").serviceActor()),
            }),
        },
        engineInstall: {
          start: (launch) =>
            startEngineInstall(engineInstallOptions(dataRootFor(ctx), launch)),
          status: () => getEngineInstallSnapshot(),
        },
        engineStop: {
          stop: ({ deleteData }) => {
            const dataRoot = dataRootFor(ctx);
            return stopEngineStack({
              ...engineInstallOptions(dataRoot),
              // 停止必须用**安装时落盘的承载目标**：另一侧的 docker 找不到这套容器
              launch: readStackRuntime(dataRoot),
              deleteData,
            });
          },
        },
        // 引擎信息页数据面：一次取全（状态 + 承载探测 + 栈容器事实 + 地址/路径）。
        engineInfo: {
          info: async () => {
            const dataRoot = dataRootFor(ctx);
            const launch = readStackRuntime(dataRoot);
            const options = engineInstallOptions(dataRoot);
            // 密钥 env 不存在 = 从未安装过：没有可查的栈，空清单即可（不拿 compose 的
            // 插值报错当答案）；存在则与安装同一口径查询运行期事实。
            const envFile = stackEnvFile(options);
            const [probe, stack] = await Promise.all([
              probeEnginePaths({
                platform: process.platform,
                release: os.release(),
                run: createProcessRunCommand(),
                listInstances: async () =>
                  ctx
                    .get("modelProviders")
                    .listInstances(
                      await ctx.get("localInstance").serviceActor(),
                    ),
              }),
              envFile
                ? listEngineStackContainers(options.composeFile, {
                    envFile,
                    launch,
                  })
                : Promise.resolve({ containers: [] }),
            ]);
            return {
              install: getEngineInstallSnapshot(),
              probe,
              stack,
              runtime: launch,
              addresses: {
                composeFile: options.composeFile,
                dataDir: options.dataDir,
              },
            };
          },
        },
        secret: deps.secret,
        frontendUrl: deps.frontendUrl,
      });
    },
  };
}
