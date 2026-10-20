import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isPackagedRuntime,
  resolveEntryRoot,
} from "../../desktop/entry-root.js";
import { resolveDesktopDataDir } from "../../desktop/paths.js";
import { registerOpenDesignHostRoutes } from "../../http/open-design-host.js";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  type ComposeRun,
  createOpenDesignCompanionController,
  resolveOpenDesignCarrierMode,
} from "./companion.js";
import { resolveOpenDesignCredentialEntries } from "./credentials.js";
import { provisionOpenDesign } from "./provision.js";
import {
  readOpenDesignLastProject,
  writeOpenDesignLastProject,
} from "./last-project.js";
import { createOpenDesignTools } from "./tools.js";

/**
 * 伴随容器 compose 资源（`open-design/`）：与 dify 同一条规则——**源码态**上溯 5 级到
 * 仓库根；**打包态**与可执行体同级（`resolveEntryRoot`）。
 */
function resolveOpenDesignComposeFile(): string {
  if (isPackagedRuntime(import.meta.url)) {
    return join(
      resolveEntryRoot({
        entryFileUrl: import.meta.url,
        execPath: process.execPath,
      }),
      "open-design",
      "docker-compose.open-design.yml",
    );
  }
  return fileURLToPath(
    new URL(
      "../../../../../open-design/docker-compose.open-design.yml",
      import.meta.url,
    ),
  );
}

/**
 * OpenDesign 宿主适配层插件。
 *
 * 与 `plugins/open-design` 的分工（同 flow 的 FORM-11 口径）：
 * - **这里**是基础设施：把 `/api/open-design/host/*` 挂到宿主，回答「面板该不该出现」，
 *   并把本仓 BYOK 凭证下发给 OpenDesign daemon（O3 / `OD-4`）；
 * - **插件**是产品入口：安装态决定 Code 模式右侧栏是否出现 OpenDesign 面板。
 *
 * 路由**始终注册**：status 是能力探针，未配齐也要如实回答 disabled 与缺失原因
 * （不假装能用）；credentials 是网关门——未配共享密钥时 503（这条缝没开），
 * 前端据此不摆空壳、不放假开关。
 *
 * 承载（§9-3，2026-10-15 拍板）：前端地址指向伴随 origin 时，本插件持有伴随容器
 * 的生命周期——装配即 `up -d`、kernel dispose 即 `down`（保留数据卷）。
 */
export function createOpenDesignHostPlugin(deps: {
  /** `KENFUTWORK_OPEN_DESIGN_FRONTEND_URL`；缺省表示未启用。 */
  frontendUrl?: string | undefined;
  /** 探活用 fetch（测试注入，避免真发网络请求）。 */
  fetchImpl?: typeof fetch | undefined;
  /**
   * `KENFUTWORK_OPEN_DESIGN_EMBED_SECRET`；缺省 = 凭证缝未开（daemon 调
   * `/credentials` 会拿到 503 与可读原因，而不是 silently 空响应）。
   */
  secret?: string | undefined;
  /** 伴随容器 compose 文件（缺省按源码态/打包态解析；测试注入）。 */
  composeFile?: string | undefined;
  /** `docker compose` 执行器（测试注入，避免真起容器）。 */
  composeRun?: ComposeRun | undefined;
}): PluginDefinition {
  return {
    name: "open-design-host",
    inject: ["localAccess", "localInstance", "modelProviders", "tools", "systemPrompt"],
    apply() {
      if (!deps.frontendUrl?.trim()) {
        // 不视为错误：status 端点会如实回答 disabled + 缺什么，前端不摆空壳入口。
        console.log(
          "[open-design] 未配置 OpenDesign 前端地址（KENFUTWORK_OPEN_DESIGN_FRONTEND_URL）：" +
            "Code 模式右侧栏不出现 OpenDesign 面板（GET /api/open-design/host/status 可查原因）。",
        );
      }
      if (!deps.secret?.trim()) {
        console.log(
          "[open-design] 未配置 OpenDesign 网关共享密钥（KENFUTWORK_OPEN_DESIGN_EMBED_SECRET）：" +
            "BYOK 凭证下发不可用（POST /api/open-design/host/credentials 返回 503 与原因）。",
        );
      }
    },
    mounted(ctx) {
      const dataDir = resolveDesktopDataDir({
        env: { KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir },
      });
      // 对话能力：只读面 + 建项目。地址来自宿主配置，故由 feature 注册而不是插件 bundle。
      for (const tool of createOpenDesignTools({
        frontendUrl: deps.frontendUrl,
        fetchImpl: deps.fetchImpl,
        // 建成的项目记到单槽位，右侧面板据此打开对应画布，而不是停在上游首页。
        onProjectCreated: (project) =>
          writeOpenDesignLastProject({ dataDir, project }),
      })) {
        ctx.get("tools").register(tool);
      }
      /**
       * 反向联动：右侧画布打开（存在当前 OpenDesign 项目）时，让对话知道这块
       * 画布是什么、能用哪些工具——这就是「打开画布 → 会话自动启用 OpenDesign
       * 能力」。没有项目或未配置地址时不出现该段（不摆空能力）。
       */
      ctx.get("systemPrompt").register({
        name: "open-design-canvas",
        order: 300,
        scope: "code",
        resolve: () => {
          if (!deps.frontendUrl?.trim()) return null;
          const project = readOpenDesignLastProject({ dataDir });
          if (!project) return null;
          return [
            "## OpenDesign 画布",
            `右侧面板当前打开的是 OpenDesign 项目「${project.name}」（${project.projectId}）。`,
            "改这块画布前先用 open_design_project_files 看现有文件；要另起项目用 open_design_create_project。",
          ].join("\n");
        },
      });
      const companion = createOpenDesignCompanionController({
        composeFile: deps.composeFile ?? resolveOpenDesignComposeFile(),
        ...(deps.secret?.trim() ? { apiToken: deps.secret.trim() } : {}),
        ...(deps.composeRun ? { run: deps.composeRun } : {}),
      });
      void registerOpenDesignHostRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        frontendUrl: deps.frontendUrl,
        fetchImpl: deps.fetchImpl,
        ...(deps.secret ? { secret: deps.secret } : {}),
        providers: ctx.get("modelProviders"),
        localInstance: ctx.get("localInstance"),
        companion: () => companion.snapshot(),
        // 桌面承载配置读写（设置页写入口，§205）：数据目录口径同 flow 引擎记录
        dataDir,
      });
      const mode = resolveOpenDesignCarrierMode(deps.frontendUrl);
      if (mode === "managed") {
        // 伴随容器（§9-3 拍板）：随主程序起停。up -d 非阻塞——首次拉镜像分钟级，
        // 不能让装配挂住；失败不自动重试，原因经 status 透给界面。
        ctx.effect(() => {
          void companion
            .start()
            .then(async () => {
              const snapshot = companion.snapshot();
              if (snapshot.state === "error") {
                console.warn(
                  `[open-design] 伴随容器未起或启动失败：${snapshot.error ?? "原因未知"}（GET /api/open-design/host/status 可查）`,
                );
                return;
              }
              // 起好了就替用户把上游引导做完：不弹登录·注册，能配的 BYOK 一并写进去。
              const credentials = await resolveOpenDesignCredentialEntries({
                providers: ctx.get("modelProviders"),
                serviceActor: () => ctx.get("localInstance").serviceActor(),
              });
              const result = await provisionOpenDesign({
                baseUrl: deps.frontendUrl ?? "",
                fetchImpl: deps.fetchImpl ?? fetch,
                entries: credentials.ok ? credentials.entries : [],
                log: (message) => console.log(message),
              });
              if (!result.done && result.reason) {
                console.warn(`[open-design] ${result.reason}`);
              }
            })
            .catch((error: unknown) => {
              // start 内部全捕获，这里只兜住接线本身的意外，不起副作用重试
              console.warn(
                "[open-design] 伴随容器启动接线异常：",
                error instanceof Error ? error.message : String(error),
              );
            });
          return () => companion.stop();
        });
      } else if (mode === "external") {
        console.log(
          "[open-design] 前端地址不是伴随 origin：按用户自管实例承载，不起伴随容器。",
        );
      }
    },
  };
}
