import type { PluginDefinition } from "../../kernel/types.js";
import { createInProcessQueue } from "./providers/in-process.js";
import { createPgmqQueue } from "./providers/pgmq.js";
import type { QueueClient } from "./types.js";

/**
 * queue 插件（M3.2）：队列 Provider 的选择。
 *
 * - **`pgmq`（默认）**：Postgres 扩展 PGMQ——服务端/自托管形态，跨进程、多 worker。
 * - **`in-process`（桌面）**：进程内队列（FORM-2）——桌面拿不到 PGMQ，且 server 与
 *   worker 同进程。
 *
 * 不做 enabled 门控：生成类任务依赖队列，`databaseUrl` 缺失时 jobs 插件本身已 fail loud
 * （内核的依赖校验会先报错），这里只负责选实现；未知名 fail loud。
 */
export function createQueuePlugin(): PluginDefinition {
  return {
    name: "queue",
    inject: [],
    apply(ctx) {
      const driver = ctx.env.queueDriver ?? "pgmq";

      ctx.register("queue", (): QueueClient => {
        if (driver === "in-process") {
          return createInProcessQueue();
        }
        if (driver !== "pgmq") {
          throw new Error(
            `[queue] 未知 KENFUTWORK_QUEUE_DRIVER：${driver}（可用：pgmq | in-process）`,
          );
        }
        if (!ctx.env.databaseUrl) {
          throw new Error("[queue] pgmq 形态需要 databaseUrl。");
        }
        return createPgmqQueue({ databaseUrl: ctx.env.databaseUrl });
      });
    },
  };
}
