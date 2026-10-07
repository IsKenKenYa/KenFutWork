// 后台生成任务消费进程；BYOK记录usage，不检查账户或余额。
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

import { loadServerEnv } from "./config/env.js";
import { resolveLocalRuntimeEnv } from "./desktop/runtime.js";
import { startJobLoop } from "./features/jobs/job-loop.js";
// Register all image/video providers via shared helper (keeps parity with app.ts)
import { composePlugins } from "./kernel/compose.js";
import { workerProfile } from "./profiles/worker.js";

/**
 * 独立 worker 进程入口：装配 worker profile（无 HTTP 面）→ 起消费循环。
 * 循环实现在 `features/jobs/job-loop.ts`——桌面单进程形态复用同一份实现
 * （进程内队列的生产者/消费者必须是同一个实例，故循环不能写死在入口里）。
 */
async function main() {
  await setupProxy();

  const env = resolveLocalRuntimeEnv(loadServerEnv());

  if (!env.databaseUrl) {
    console.error(
      "KENFUTWORK_DATABASE_URL（或 DATABASE_URL）是 worker 进程的必需项。",
    );
    process.exit(1);
  }

  // P7：worker 走内核装配（profiles/worker.ts 唯一插件清单）
  const kernel = composePlugins(env, workerProfile());
  await kernel.get("localInstance").getContext();

  const loop = startJobLoop({
    assetWriter: kernel.get("assetWriter"),
    blob: kernel.get("blob"),
    env,
    jobService: kernel.get("jobs"),
    modelProviders: kernel.get("modelProviders"),
    queue: kernel.get("queue"),
    usageService: kernel.get("usage"),
  });

  // Graceful shutdown — wait for in-flight jobs then exit
  const shutdown = async () => {
    await loop.shutdown();
    await kernel.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[worker] Fatal error:", err);
  process.exit(1);
});
