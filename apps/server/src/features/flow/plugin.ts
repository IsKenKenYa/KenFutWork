import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FLOW_PLUGIN_BUNDLE_NAME } from "@kenfutwork/shared";
import {
  isPackagedRuntime,
  resolveEntryRoot,
} from "../../desktop/entry-root.js";
import { resolveDesktopDataDir } from "../../desktop/paths.js";
import { registerFlowHostRoutes } from "../../http/flow-host.js";
import { registerFlowProjectFileRoutes } from "../../http/flow-project-files.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { LocalActor } from "../local-instance/types.js";
import {
  PLUGIN_STATE_LIFECYCLE_CAPABILITY,
  type PluginStateChangedEvent,
} from "../plugins/state-lifecycle.js";
import { createProcessRunCommand } from "./engine/exec.js";
import {
  type EngineInstallOptions,
  type EngineLaunch,
  getEngineInstallSnapshot,
  planEngineAutoInstall,
  purgeEngineStack,
  readStackLogTail,
  readStackRuntime,
  startEngineInstall,
  stopEngineStack,
} from "./engine/install.js";
import { readEngineLogs } from "./engine/logs.js";
import { probeEnginePaths } from "./engine/probe.js";
import { listEngineStackContainers } from "./engine/stack.js";
import { createFlowIdentityTickets } from "./identity.js";
import { createFlowProjectControl } from "./project-control.js";
import {
  createFlowProjectFiles,
  type FlowProjectFiles,
} from "./project-files.js";
import {
  createFlowStackSupervisor,
  type FlowRuntimeState,
  type FlowStackSupervisor,
  loadOrCreateFlowManagedConfig,
} from "./runtime.js";
import { createFlowGatewayTools } from "./tools.js";

/**
 * 引擎资源目录（`docker/dify/`，内含 `docker-compose.dify.yml` 与 `ssrf_proxy/squid.conf`）。
 *
 * 两种形态一条规则：**源码态**本模块 = `<repo>/apps/server/src/features/flow/plugin.ts`，
 * 上溯 5 级到仓库根后进入 `docker/`；**打包态**资源与可执行体同级（Windows SEA = exe 目录、
 * mac CJS = `<app>`），由 `resolveEntryRoot` 解析（与 `runtime/`、`pg/` 同一口径）。
 */
export function resolveDifyDir(): string {
  if (isPackagedRuntime(import.meta.url)) {
    return join(
      resolveEntryRoot({
        entryFileUrl: import.meta.url,
        execPath: process.execPath,
      }),
      "dify",
    );
  }
  return join(
    fileURLToPath(new URL("../../../../..", import.meta.url)),
    "docker",
    "dify",
  );
}

/**
 * flow 子模块目录：源码态在仓库根，打包态与可执行体同级。
 *
 * 网关 env 的写入位置必须按 flow 自己的目录解析，不能再靠 `dify/../flow`：
 * 源码态 dify 已移入 `docker/`，两者不再是兄弟目录。
 */
export function resolveFlowDir(): string {
  if (isPackagedRuntime(import.meta.url)) {
    return join(
      resolveEntryRoot({
        entryFileUrl: import.meta.url,
        execPath: process.execPath,
      }),
      "flow",
    );
  }
  return join(
    fileURLToPath(new URL("../../../../..", import.meta.url)),
    "flow",
  );
}

/**
 * Flow 网关 env（开发态与打包态共用一条解析规则）：管理员凭据同源的落点。
 * 安装时宿主把自动生成的凭据补进这些文件；网关自动授权与 init/setup 用同一份。
 */
function gatewayEnvFiles(): string[] {
  const flowDir = resolveFlowDir();
  // 顺序必须与 flow/gateway/src/app.module.ts 的 envFilePath 一致：
  // `.futureflow.runtime.env` 优先于 `.env`。管理员凭据反向对齐以「网关实际
  // 读到的那份」为准，取错文件会让 bootstrap 建号口令与 loginConsole 不一致
  // （实测 onReady 补授权 503：Dify Console 授权无效）。
  return [join(flowDir, ".futureflow.runtime.env"), join(flowDir, ".env")];
}

/** 安装生成的密钥 env（存在才用于 compose 查询；信息页是只读路径，不创建）。 */
function stackEnvFile(options: EngineInstallOptions): string {
  return existsSync(join(options.dataDir, "dify-stack.env"))
    ? join(options.dataDir, "dify-stack.env")
    : "";
}

function readManagedEngineStack(
  options: EngineInstallOptions,
  launch: EngineLaunch,
): ReturnType<typeof listEngineStackContainers> {
  const envFile = stackEnvFile(options);
  // 首次安装前还没有托管凭据，查询不会创建它们。
  return envFile
    ? listEngineStackContainers(options.composeFile, { envFile, launch })
    : Promise.resolve({ containers: [] });
}

/**
 * flow 宿主适配层是否配齐：三件套缺任何一件，Flow 模式都不会出现在工作台里
 * （status 端点如实回答 disabled）。既是入口判据，也是「要不要为引擎栈自动下载」的闸门
 * ——用不到的模式不该拉 8GB。
 */
type FlowAdapterRuntimeView = {
  state: FlowRuntimeState | "external";
  detail?: string;
  frontendUrl?: string;
  gatewayUrl?: string;
};

type FlowAdapter = {
  mode: "external" | "managed" | "disabled";
  readonly secret: string | undefined;
  readonly frontendUrl: string | undefined;
  readonly gatewayUrl: string | undefined;
  reasons: string[];
  supervisor?: FlowStackSupervisor;
  runtime(): FlowAdapterRuntimeView;
};

function flowAdapterConfigured(adapter: FlowAdapter): boolean {
  return adapter.mode !== "disabled";
}

/**
 * 适配层来源决策：
 * - 三项 env 都配了 → 外部实例（自托管/反代），宿主不接管进程；
 * - 一项都没配 → 本机托管：配置落数据目录，插件按安装态自动启停网关与前端；
 * - 只配了一部分 → 显式报错，不猜也不悄悄覆盖用户的半套配置。
 */
function resolveFlowAdapter(
  deps: {
    secret?: string | undefined;
    frontendUrl?: string | undefined;
    gatewayUrl?: string | undefined;
  },
  env: {
    desktopDataDir?: string | undefined;
    databaseUrl?: string | undefined;
    port: number;
    webOrigin: string;
  },
): FlowAdapter {
  const secret = deps.secret?.trim();
  const frontendUrl = deps.frontendUrl?.trim();
  const gatewayUrl = deps.gatewayUrl?.trim();
  const provided = [secret, frontendUrl, gatewayUrl].filter(Boolean).length;
  if (provided === 3) {
    return {
      mode: "external",
      secret,
      frontendUrl,
      gatewayUrl,
      reasons: [],
      runtime: () => ({ state: "external" }),
    };
  }
  if (provided > 0) {
    return {
      mode: "disabled",
      secret: undefined,
      frontendUrl: undefined,
      gatewayUrl: undefined,
      reasons: [
        "Flow 地址或密钥只配置了一部分，请三项同时配置或全部留空由宿主托管。",
      ],
      runtime: () => ({ state: "stopped" }),
    };
  }
  if (!env.databaseUrl) {
    return {
      mode: "disabled",
      secret: undefined,
      frontendUrl: undefined,
      gatewayUrl: undefined,
      reasons: ["当前实例没有应用数据库，无法托管 Flow 运行时。"],
      runtime: () => ({ state: "stopped" }),
    };
  }
  const dataDir = resolveDesktopDataDir({
    env: { KENFUTWORK_DATA_DIR: env.desktopDataDir },
  });
  const config = loadOrCreateFlowManagedConfig({ dataDir });
  const supervisor = createFlowStackSupervisor({
    flowDir: resolveFlowDir(),
    dataDir,
    databaseUrl: env.databaseUrl,
    serverPort: env.port,
    webOrigin: env.webOrigin,
  });
  return {
    mode: "managed",
    get secret() {
      return config.sharedSecret;
    },
    get frontendUrl() {
      return supervisor.snapshot().frontendUrl;
    },
    get gatewayUrl() {
      return supervisor.snapshot().gatewayUrl;
    },
    reasons: [],
    supervisor,
    runtime() {
      const snapshot = supervisor.snapshot();
      // 插件刚装/应用刚启动、首次 ensure 尚未调用：按「正在启动」回答，
      // 前端会持续重试，不把等待期当成坏配置。
      const state =
        snapshot.state === "stopped" ? ("starting" as const) : snapshot.state;
      const detail =
        snapshot.detail ??
        (state === "starting" ? "Flow 运行时正在启动。" : undefined);
      return {
        state,
        ...(detail ? { detail } : {}),
        frontendUrl: snapshot.frontendUrl,
        gatewayUrl: snapshot.gatewayUrl,
      };
    },
  };
}

/** 引擎栈托管选项（compose 文件 + env/日志的数据目录；承载目标由调用方给或读落盘记录）。 */
function engineInstallOptions(
  dataRoot: string,
  launch?: EngineInstallOptions["launch"],
  envFiles: string[] = gatewayEnvFiles(),
): EngineInstallOptions {
  return {
    composeFile: join(resolveDifyDir(), "docker-compose.dify.yml"),
    dataDir: dataRoot,
    gatewayEnvFiles: envFiles,
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
  gatewayUrl?: string | undefined;
}): PluginDefinition {
  let flowFiles: FlowProjectFiles | undefined;
  let flowAdapter: FlowAdapter | undefined;
  /** 引擎安装/卸载时管理员凭据同源的落点：托管形态写运行时 env，外部形态沿用 flow/.env。 */
  const engineEnvFiles = () =>
    flowAdapter?.supervisor?.gatewayEnvFiles() ?? gatewayEnvFiles();
  const identityTickets = createFlowIdentityTickets();
  let issueIdentity:
    | ((
        actor: LocalActor,
        projectId?: string,
      ) => Promise<{ token: string; expiresAt: string }>)
    | undefined;
  return {
    name: "flow-host",
    inject: [
      "localAccess",
      "localInstance",
      "modelProviders",
      "settings",
      "ws",
      "projects",
      "projectFiles",
      "blob",
      "tools",
      "plugins",
      "capabilities",
    ],
    apply(ctx) {
      flowAdapter = resolveFlowAdapter(deps, ctx.env);
      const adapter = flowAdapter;
      issueIdentity = async (actor, projectId) => {
        if (projectId) {
          // 任意工作方式的项目都可绑定 Flow：绑定后该项目会话共享工作流上下文。
          await ctx.get("projects").getProject(actor, projectId);
        }
        const settings = await ctx
          .get("settings")
          .getInstanceSettings(actor, actor.instanceId);
        return identityTickets.issue({
          instanceId: actor.instanceId,
          accessClientId: actor.accessClientId,
          ttlMs: settings.localAccessTicketTtlMs,
          ...(projectId ? { projectId } : {}),
        });
      };
      if (adapter.gatewayUrl && adapter.secret) {
        for (const tool of createFlowGatewayTools({
          gatewayUrl: adapter.gatewayUrl,
          issueHostToken: async (actor) => {
            if (!issueIdentity) throw new Error("Flow 身份缝尚未初始化。");
            return (await issueIdentity(actor)).token;
          },
          resolveLimits: async (actor) => {
            const settings = await ctx
              .get("settings")
              .getInstanceSettings(actor, actor.instanceId);
            return {
              controlTimeoutMs: settings.flowGatewayControlTimeoutMs,
              runTimeoutMs: settings.executeTimeoutMs,
              maxResponseBytes: settings.processMaxOutputBytes,
            };
          },
        })) {
          ctx.effect(() => ctx.get("tools").register(tool));
        }
      }
      ctx.register("flowProjectControl", () => {
        if (adapter.gatewayUrl && adapter.secret)
          return createFlowProjectControl({
            gatewayUrl: adapter.gatewayUrl,
            sharedSecret: adapter.secret,
            // 等待预算走治理表（库值 ?? env ?? 默认），不在这里写字面量。
            timeoutMs: async () => {
              const actor = await ctx.get("localInstance").serviceActor();
              const settings = await ctx
                .get("settings")
                .getInstanceSettings(actor, actor.instanceId);
              return settings.flowGatewayControlTimeoutMs;
            },
          });
        const unavailable = async (): Promise<never> => {
          throw Object.assign(
            new Error("Flow 网关控制地址或共享密钥未配置。"),
            { statusCode: 503 },
          );
        };
        return {
          snapshot: unavailable,
          quiesce: unavailable,
          completeRelink: unavailable,
        };
      });
      if (!flowAdapterConfigured(adapter)) {
        // 不视为错误：status 端点会如实回答 disabled + 缺什么，前端不摆空壳入口。
        console.log(
          `[flow] Flow 运行时未就绪：${adapter.reasons.join(" ")}（GET /api/flow/host/status 可查原因）。`,
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
            ...engineInstallOptions(dataRoot, undefined, engineEnvFiles()),
            launch: readStackRuntime(dataRoot),
          });
        },
      }));
      ctx.effect(() => () => {
        flowFiles?.dispose();
        // 路由由 Fastify 生命周期回收，这里只留一条可追溯日志（便于排查「明明配了却没生效」）。
        console.log("[flow] flow 宿主适配层路由已停用。");
      });
    },
    mounted(ctx) {
      const files = createFlowProjectFiles({
        projectControl: ctx.get("flowProjectControl"),
        localInstance: ctx.get("localInstance"),
        localAccess: ctx.get("localAccess"),
        projects: ctx.get("projects"),
        projectFiles: ctx.get("projectFiles"),
        blob: ctx.get("blob"),
      });
      flowFiles = files;
      /** flow 产品插件是否已安装并启用：运行时与引擎下载都只在该状态下发生。 */
      const bundleActive = async (): Promise<boolean> => {
        try {
          return (await ctx.get("plugins").list()).some(
            (entry) =>
              entry.name === FLOW_PLUGIN_BUNDLE_NAME &&
              entry.installed &&
              entry.enabled !== false,
          );
        } catch {
          return false;
        }
      };
      /**
       * 本机托管运行时：插件安装/启用即拉起网关与前端，禁用/卸载即停止；
       * 应用启动时若插件已安装，也在装配完成后自动拉起（重启应用/电脑无需手工配置）。
       */
      const supervisor = flowAdapter?.supervisor;
      if (supervisor) {
        const ensureFlowStack = (reason: string): void => {
          void supervisor.ensure().catch((error: unknown) => {
            console.warn(
              `[flow] 运行时启动失败（${reason}）：`,
              error instanceof Error ? error.message : String(error),
            );
          });
        };
        const requestEngineAutoInstall = (reason: string): void => {
          void autoInstallEngineStack().catch((error: unknown) => {
            // 自动安装没跑起来不能静默：状态机与引擎页日志是用户唯一的可见面。
            console.warn(
              `[flow] 引擎栈自动安装未启动（${reason}）：`,
              error instanceof Error ? error.message : String(error),
            );
          });
        };
        ctx.effect(() =>
          ctx.get("capabilities").register(PLUGIN_STATE_LIFECYCLE_CAPABILITY, {
            id: "flow-runtime",
            value: {
              afterStateChanged(event: PluginStateChangedEvent) {
                const touches =
                  event.current?.name === FLOW_PLUGIN_BUNDLE_NAME ||
                  event.previous?.name === FLOW_PLUGIN_BUNDLE_NAME;
                if (!touches) return;
                // 事件里的 current 只承载已安装记录（非空即已安装）。
                const active =
                  event.current?.name === FLOW_PLUGIN_BUNDLE_NAME &&
                  event.current.enabled !== false;
                if (active) {
                  ensureFlowStack(`插件状态 ${event.reason}`);
                  // 挂载期的库存查询可能早于注册表装载（应用启动恢复），
                  // 引擎安装必须跟着生命周期再跑一次，否则只能到引擎页手动装。
                  requestEngineAutoInstall(`插件状态 ${event.reason}`);
                } else void supervisor.stop();
              },
            },
          }),
        );
        ctx.effect(() => () => {
          void supervisor.stop();
        });
        void bundleActive().then((active) => {
          if (!active) return;
          ensureFlowStack("应用启动");
          requestEngineAutoInstall("应用启动");
        });
      }
      /** 承载探测：引擎信息页与「装上即用」的自动安装共用同一份判据。 */
      const probeCarrier = (skipWsl = false) =>
        probeEnginePaths({
          platform: process.platform,
          release: os.release(),
          skipWsl,
          run: createProcessRunCommand(),
          listInstances: async () =>
            ctx
              .get("modelProviders")
              .listInstances(await ctx.get("localInstance").serviceActor()),
        });
      /**
       * 一次引擎安装的输入。点按钮装的与自动装的必须走同一份 bootstrap/onReady：
       * bootstrap 读治理表里的重试预算，onReady 补网关控制面授权。
       */
      const engineInstallInput = (launch?: EngineLaunch) => ({
        ...engineInstallOptions(dataRootFor(ctx), launch, engineEnvFiles()),
        bootstrap: async () => {
          const actor = await ctx.get("localInstance").serviceActor();
          const settings = await ctx
            .get("settings")
            .getInstanceSettings(actor, actor.instanceId);
          return {
            // 与 compose 默认 DIFY_PORT=15001 同源；extraEnv 改端口时由安装调用方一并覆盖。
            consoleBase: "http://127.0.0.1:15001/console/api",
            attempts: settings.flowEngineBootstrapAttempts,
            retryDelayMs: settings.flowEngineBootstrapRetryMs,
            requestTimeoutMs: settings.flowEngineBootstrapRequestTimeoutMs,
            credentialEnvFiles: engineEnvFiles(),
          };
        },
        // 装完补一次网关控制面授权：网关只在启动期窗口自动授权，晚装的窗口早过。
        // 走宿主共享密钥端点（与项目控制同一 Guard），不直连带 AdminGuard 的 /admin/*。
        onReady: async () => {
          // 本机托管：先按新凭据重启网关（自动授权保持关闭，避免授权失败拖垮启动），
          // 再走共享密钥端点补授权；外部实例只有后一步。
          if (flowAdapter?.mode === "managed" && flowAdapter.supervisor) {
            await flowAdapter.supervisor.refreshGateway();
          }
          const gatewayUrl = flowAdapter?.gatewayUrl;
          const secret = flowAdapter?.secret;
          if (!gatewayUrl || !secret) {
            throw new Error(
              "Flow 网关地址或宿主控制密钥未配置，无法补控制面授权。",
            );
          }
          // 一次性局部常量：就绪通知的等待预算，不进治理表。
          let response: Response;
          try {
            response = await fetch(
              new URL("/host/ff-embed/v1/dify/reauthorize", gatewayUrl),
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${secret}`,
                  "x-ff-embed-protocol": "v1",
                },
                signal: AbortSignal.timeout(15_000),
              },
            );
          } catch (error) {
            // 裸 fetch failed 不指路；网关没起来是这段失败最常见的原因。
            throw new Error(
              `网关不可达（${gatewayUrl}）：${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error },
            );
          }
          if (!response.ok) {
            throw new Error(
              `HTTP ${response.status}（网关地址 ${gatewayUrl}）。`,
            );
          }
        },
      });
      /**
       * 装上即用：Flow 模式真的会出现在工作台里（适配层配齐）时，引擎栈自己装上，
       * 不要用户去「引擎」页点安装按钮。判据见 `planEngineAutoInstall`。
       * 函数声明而非表达式：生命周期回调在挂载期注册，提升后可安全调用。
       */
      async function autoInstallEngineStack(): Promise<void> {
        const dataRoot = dataRootFor(ctx);
        const options = engineInstallOptions(
          dataRoot,
          undefined,
          engineEnvFiles(),
        );
        const runtime = readStackRuntime(dataRoot);
        if (runtime.stoppedByUser) return;
        const [carrier, stack] = await Promise.all([
          probeCarrier(),
          readManagedEngineStack(options, runtime),
        ]);
        const plan = planEngineAutoInstall({
          installState: getEngineInstallSnapshot().state,
          stackContainerCount: stack.containers.length,
          recommended: carrier.recommended,
          stoppedByUser: runtime.stoppedByUser,
        });
        if (plan.action === "skip") return;
        console.log(
          "[flow] 引擎栈不在且本机承载可用：自动开始安装（装上即用）。",
        );
        startEngineInstall(engineInstallInput());
      }
      void registerFlowProjectFileRoutes(ctx.app, {
        files,
        secret: flowAdapter?.secret,
      });
      void registerFlowHostRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        localInstance: ctx.get("localInstance"),
        providers: ctx.get("modelProviders"),
        projectControl: ctx.get("flowProjectControl"),
        // 事件缝透出走内核声明的 ws 缝（app.ts 装配时注册 connectionManager/eventBuffer）。
        ws: {
          connectionManager: ctx.get("ws").connectionManager,
          // P5：flowRun 事件入缓冲，断线走 `flow.resume` 补发
          eventBuffer: ctx.get("ws").eventBuffer,
        },
        // 身份缝：宿主前端换票（本机接入）→ flow 网关回验（共享密钥）→ 稳定 subject。
        identity: {
          issue: async (actor, projectId) => {
            if (!issueIdentity) throw new Error("Flow 身份缝尚未初始化。");
            return issueIdentity(actor, projectId);
          },
          verify: async (token) => {
            const entry = identityTickets.consume(token);
            if (!entry) return null;
            // 票据只在本实例签发：归属必须与当前实例一致（防跨实例拼装）。
            const context = await ctx.get("localInstance").getContext();
            if (entry.instanceId !== context.instanceId) return null;
            const projectFiles = entry.projectId
              ? await files.issue(
                  {
                    instanceId: entry.instanceId,
                    accessClientId: entry.accessClientId,
                  },
                  entry.projectId,
                )
              : undefined;
            return {
              subject: context.instanceId,
              displayName: "本机",
              ...(projectFiles ? { projectFiles } : {}),
            };
          },
        },
        // 引擎探测层 + 托管（FORM-11）：探测路径，确认后拉镜像起栈，状态可轮询。
        engine: { probe: probeCarrier },
        engineInstall: {
          start: (launch) => startEngineInstall(engineInstallInput(launch)),
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
        engineLogs: {
          read: async (input) => {
            const dataRoot = dataRootFor(ctx);
            const options = engineInstallOptions(dataRoot);
            const envFile = stackEnvFile(options);
            return readEngineLogs({
              source: input.source,
              ...(input.container ? { container: input.container } : {}),
              ...(input.tail !== undefined ? { tail: input.tail } : {}),
              composeFile: options.composeFile,
              dataDir: options.dataDir,
              ...(envFile ? { envFile } : {}),
              launch: readStackRuntime(dataRoot),
            });
          },
        },
        engineInfo: {
          info: async () => {
            const dataRoot = dataRootFor(ctx);
            const launch = readStackRuntime(dataRoot);
            const options = engineInstallOptions(dataRoot);
            const [probe, stack] = await Promise.all([
              probeCarrier(launch.stoppedByUser),
              launch.kind === "wsl2" && launch.stoppedByUser
                ? Promise.resolve({ containers: [] })
                : readManagedEngineStack(options, launch),
            ]);
            const install = getEngineInstallSnapshot();
            // 进程重启后 current.logFile 为空：按数据目录里的标准日志名补读，
            // 让「上次为什么失败」在引擎页仍然可见。
            if (install.logTail.length === 0)
              install.logTail = readStackLogTail(options.dataDir);
            return {
              install,
              probe,
              stack: {
                ...stack,
                ...(launch.stoppedByUser
                  ? { stoppedByUser: true as const }
                  : {}),
              },
              runtime: launch,
              addresses: {
                composeFile: options.composeFile,
                dataDir: options.dataDir,
              },
            };
          },
        },
        secret: flowAdapter?.secret,
        frontendUrl: flowAdapter?.frontendUrl,
        gatewayUrl: flowAdapter?.gatewayUrl,
        runtime: () => flowAdapter?.runtime() ?? { state: "stopped" },
      });
    },
  };
}
