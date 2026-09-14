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

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadServerEnv } from "./config/env.js";
import { isDesktopRuntime, prepareDesktopRuntime } from "./desktop/runtime.js";
import { resolveRuntimes } from "./desktop/runtimes.js";
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

  const exeDir = resolveExeDir();
  // 随包运行时（Node/Python/JDK）：解析出 bin 目录注入 sandbox PATH，宿主机没装也能跑
  const runtimes = resolveRuntimes({ env: process.env, exeDir });
  if (runtimes.bundled.length > 0) {
    console.log(
      `[runtime] 随包运行时：${runtimes.bundled.join(", ")}（PATH=${runtimes.pathAdditions.join(", ")}）`,
    );
  }
  const baseEnv = loadServerEnv({
    runtimePathAdditions: runtimes.pathAdditions,
    ...(runtimes.javaHome ? { javaHome: runtimes.javaHome } : {}),
  });
  const desktop = await prepareDesktopRuntime({
    env: baseEnv,
    exeDir,
    repoRoot: process.cwd(),
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
  } catch (error) {
    app.log.error(error);
    await shutdown();
    process.exitCode = 1;
  }
}

/**
 * 资源根目录：打包（SEA）态是 exe 所在目录（pg/、supabase/、web/ 都在那），
 * 开发态是仓库根。SEA 下 import.meta.url 为空，故回退到 process.execPath。
 */
function resolveExeDir(): string {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    return dirname(dirname(dirname(thisFile)));
  } catch {
    return dirname(process.execPath);
  }
}

void main();
