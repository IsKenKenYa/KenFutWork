import { bootstrap } from "global-agent";

// Enable HTTP proxy for all outbound requests if GLOBAL_AGENT_HTTP_PROXY is set
bootstrap();

// Native fetch() proxy — needed for @google/generative-ai SDK
async function setupProxy() {
  if (process.env.GLOBAL_AGENT_HTTP_PROXY) {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(process.env.GLOBAL_AGENT_HTTP_PROXY));
  }
}

import { isAbsolute, join, resolve } from "node:path";

import { buildApp } from "./app.js";
import { loadServerEnv } from "./config/env.js";
import { resolveEntryRoot } from "./desktop/entry-root.js";
import { isDesktopRuntime, prepareDesktopRuntime } from "./desktop/runtime.js";import { hasSystemGit, resolveRuntimes } from "./desktop/runtimes.js";
import { reconcileInterruptedRuns } from "./features/agent-runs/reconcile.js";
import { startJobLoop } from "./features/jobs/job-loop.js";
import { registerAllProviders } from "./generation/providers/register-all.js";

/**
 * HTTP 进程入口。
 *
 * 桌面形态（`LOOMIC_EMBEDDED_PG=1`，FORM-2）下：先就位本机 Postgres + 同源迁移，
 * 再起 HTTP，并在**同进程**跑任务消费循环——桌面用进程内队列，生产者与消费者必须
 * 是同一个队列实例（M3.2），故循环在 server 进程内起，而不是另开 worker。
 */
async function main() {
  await setupProxy();

  /** 进程启动时刻：孤儿对账只碰**早于它**创建的非终态 run（本进程不可能在跑那些）。 */
  const bootAt = new Date();

  const exeDir = resolveExeDir();
  // 随包运行时（Node/Python/JDK）：解析出 bin 目录注入 sandbox PATH，宿主机没装也能跑
  const runtimes = resolveRuntimes({ env: process.env, exeDir });
  // git 与其余运行时优先级相反：宿主自带优先，随包只兜底（runtimes 里出现 git 即表示
  // 宿主没有）。三者都没有时明确标记 unavailable，界面据此说明「为什么没有分支可切」。
  const bundledGit = runtimes.roots.find((root) => root.name === "git");
  const gitSource: "system" | "bundled" | "unavailable" = bundledGit
    ? "bundled"
    : hasSystemGit({ path: process.env.PATH })
      ? "system"
      : "unavailable";
  if (runtimes.bundled.length > 0) {
    console.log(
      `[runtime] 随包运行时：${runtimes.bundled.join(", ")}（PATH=${runtimes.pathAdditions.join(", ")}）`,
    );
  }
  const baseEnv = loadServerEnv({
    sandboxRoot: resolveSandboxRoot(exeDir),
    runtimePathAdditions: runtimes.pathAdditions,
    ...(runtimes.javaHome ? { javaHome: runtimes.javaHome } : {}),
    ...(bundledGit ? { gitBinDir: bundledGit.binDir } : {}),
    gitSource,
  });
  const desktop = await prepareDesktopRuntime({
    env: baseEnv,
    exeDir,
    // 仓库根必须从入口文件上溯解析：dev 态 cwd 是 apps/server，拿 cwd 当 repoRoot
    // 会找不到 <repoRoot>/supabase 迁移集与 docker/pg-dev-shim（entry-root 的注释里
    // 记录过这次修正——源码态上四级到仓库根，打包态回落 exe 目录）
    repoRoot: resolveEntryRoot({
      entryFileUrl: import.meta.url,
      execPath: process.execPath,
    }),
  });
  const env = desktop.env;

  registerAllProviders(env);

  const app = buildApp({ env });

  // 桌面单进程：HTTP 与生成任务同进程；服务端形态仍由独立 worker 进程消费
  const jobLoop = isDesktopRuntime(env)
    ? startJobLoop(
        {
          assetWriter: app.kernel.get("assetWriter"),
          blob: app.kernel.get("blob"),
          creditService: app.kernel.get("credits"),
          env,
          jobService: app.kernel.get("jobs"),
          modelProviders: app.kernel.get("modelProviders"),
          queue: app.kernel.get("queue"),
          usageService: app.kernel.get("usage"),
        },
        { tag: "[desktop-worker]" },
      )
    : undefined;

  const host = env.serverHost ?? "127.0.0.1";

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await jobLoop?.shutdown();
    await app.close();
    await desktop.shutdown();
  };
  process.on("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });

  try {
    await app.listen({
      host,
      port: env.port,
    });

    console.log(`@loomic/server listening on http://${host}:${env.port}`);

    /**
     * 孤儿 run 对账：**绑上端口之后**才做（见 reconcile.ts 的说明——抢不到端口的
     * 第二条 dev server 链也会走完装配，由它做对账会误杀正在服务的那条进程在飞的 run）。
     */
    void reconcileInterruptedRuns(app.kernel.get("persistence"), bootAt)
      .then((count) => {
        if (count > 0) {
          console.log(`[agent-runs] 启动对账：${count} 个遗留 run 已收敛为 failed`);
        }
      })
      .catch((error: unknown) => {
        console.warn(
          "[agent-runs] 启动对账失败（不阻断启动）：",
          error instanceof Error ? error.message : String(error),
        );
      });
  } catch (error) {
    app.log.error(error);
    await shutdown();
    process.exitCode = 1;
  }
}

/**
 * 资源根目录：打包（SEA）态是 exe 所在目录（pg/、supabase/、web/ 都在那），
 * 开发态是仓库根（判定与回归见 `desktop/entry-root.ts`）。
 */
function resolveExeDir(): string {
  return resolveEntryRoot({
    entryFileUrl: import.meta.url,
    execPath: process.execPath,
  });
}

/**
 * 沙箱根目录：`LOOMIC_SANDBOX_ROOT`（可为相对路径，按入口目录解析）优先；
 * 缺省 `<项目根（dev）/ exe 安装目录（打包）>/tmp/sandbox`。
 * 画布工作目录 = `<sandboxRoot>/<画布UUID>`（真实目录映射命中时走映射，见
 * `LOOMIC_CANVAS_WORK_DIRS` — 产品决策 2026-09-14）。
 */
function resolveSandboxRoot(exeDir: string): string {
  const explicit = process.env.LOOMIC_SANDBOX_ROOT?.trim();
  if (explicit) {
    return isAbsolute(explicit) ? explicit : resolve(exeDir, explicit);
  }
  return join(exeDir, "tmp", "sandbox");
}

void main();
