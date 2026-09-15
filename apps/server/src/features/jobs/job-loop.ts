import { randomUUID } from "node:crypto";

import type { BackgroundJobType } from "@kenfutwork/shared";

import type { ServerEnv } from "../../config/env.js";
import type { CreditService } from "../credits/credit-service.js";
import type { QueueClient } from "../queue/types.js";
import { type ExecutorContext, getExecutor } from "./job-executor.js";

// 副作用导入：executor 在模块加载时自注册（进程级注册表）
import "./executors/image-generation.js";
import "./executors/video-generation.js";

/**
 * 生成类任务的消费循环（worker 与桌面单进程共用）。
 *
 * 抽出来的理由（M2.3）：桌面形态是**单进程**（server + 任务执行同进程），而进程内队列
 * 的生产者与消费者必须是**同一个实例**（M3.2：消息只在内存里，两个内核实例互相看不见）。
 * 故循环不能藏在 `worker.ts` 里，必须能被「已有内核」的调用方复用。
 *
 * 行为与抽出前一致：并发上限、可见性超时、长轮询、失败重试/死信、死信退款、优雅退出。
 * `process.exit` 留给调用方（worker 退出进程，桌面只停循环）。
 */

export const JOB_QUEUES = [
  "image_generation_jobs",
  "video_generation_jobs",
] as const;

const QUEUE_TO_TYPE: Record<string, BackgroundJobType> = {
  image_generation_jobs: "image_generation",
  video_generation_jobs: "video_generation",
};

const VT_BY_QUEUE: Record<string, number> = {
  image_generation_jobs: 120,
  video_generation_jobs: 300,
};

/** 除逐消息字段（queueName/msgId/renewVt）外的执行上下文。 */
export type JobLoopContext = Omit<
  ExecutorContext,
  "msgId" | "queueName" | "renewVt"
> & { env: ServerEnv };

export type JobLoopHandle = {
  /** 停止轮询 → 等在建任务收尾 → 关闭队列（顺序与抽出前一致）。 */
  shutdown(): Promise<void>;
  /** 当前在建任务数（诊断用）。 */
  inFlightCount(): number;
};

export function startJobLoop(
  ctx: JobLoopContext,
  options: { queues?: readonly string[]; tag?: string } = {},
): JobLoopHandle {
  const queues: readonly string[] = options.queues ?? JOB_QUEUES;
  const tag =
    options.tag ?? `[worker:${ctx.env.workerId ?? randomUUID().slice(0, 8)}]`;
  const env = ctx.env;

  const concurrencyByQueue: Record<string, number> = {
    image_generation_jobs: env.workerImageConcurrency ?? 3,
    video_generation_jobs: env.workerVideoConcurrency ?? 2,
  };

  const inFlightByQueue = new Map<string, Set<Promise<void>>>(
    queues.map((queue) => [queue, new Set()]),
  );

  // 服务端长轮询：在 Postgres 内等待最多 N 秒，每 500ms 检查一次；
  // 取代旧的「客户端 sleep(2000) + read()」轮询（曾产生约 34 万次空查询）。
  const pollTimeoutSeconds = Math.max(
    1,
    Math.floor((env.workerPollIntervalMs ?? 5000) / 1000),
  );

  let running = true;
  const totalInFlight = () =>
    [...inFlightByQueue.values()].reduce((count, set) => count + set.size, 0);

  const concurrencyDesc = queues
    .map((queue) => `${queue}=${concurrencyByQueue[queue] ?? 1}`)
    .join(", ");
  console.log(
    `${tag} Started. concurrency={${concurrencyDesc}}, longPollTimeout=${pollTimeoutSeconds}s`,
  );

  void (async () => {
    while (running) {
      // `queueName` 是队列名，`queue` 是队列缝客户端——两者都用，故名字必须区分
      for (const queueName of queues) {
        try {
          const inFlight = inFlightByQueue.get(queueName)!;
          const cap = concurrencyByQueue[queueName] ?? 1;
          const available = cap - inFlight.size;
          if (available <= 0) continue;

          const vt = VT_BY_QUEUE[queueName] ?? 120;
          const messages = await ctx.queue.readWithPoll(
            queueName,
            vt,
            available,
            pollTimeoutSeconds,
            500,
          );

          for (const msg of messages) {
            const messageCtx: ExecutorContext = {
              ...ctx,
              queueName,
              msgId: msg.msg_id,
              renewVt: async (vtSeconds: number) => {
                try {
                  await ctx.queue.setVisibilityTimeout(
                    queueName,
                    msg.msg_id,
                    vtSeconds,
                  );
                } catch (error) {
                  console.warn(
                    `[renewVt] failed for msg ${msg.msg_id}:`,
                    error,
                  );
                }
              },
            };
            const task = processMessage(
              queueName,
              msg,
              messageCtx,
              ctx.creditService,
              tag,
            ).finally(() => inFlight.delete(task));
            inFlight.add(task);
          }
        } catch (error) {
          console.error(`${tag} Error polling ${queueName}:`, error);
        }
      }
    }
  })();

  return {
    inFlightCount: totalInFlight,
    async shutdown() {
      const count = totalInFlight();
      console.log(
        `${tag} Shutting down, waiting for ${count} in-flight jobs...`,
      );
      running = false;
      const tasks = [...inFlightByQueue.values()].flatMap((set) => [...set]);
      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }
      await ctx.queue.shutdown();
      console.log(`${tag} Shutdown complete.`);
    },
  };
}

async function processMessage(
  queue: string,
  msg: { message: Record<string, unknown>; msg_id: number },
  ctx: ExecutorContext,
  creditService: CreditService,
  tag: string,
) {
  const jobId = msg.message.job_id as string;
  const jobType =
    (msg.message.job_type as BackgroundJobType) ?? QUEUE_TO_TYPE[queue];

  if (!jobId || !jobType) {
    console.error(`${tag} Invalid message in ${queue}:`, msg.message);
    await ctx.queue.archive(queue, msg.msg_id);
    return;
  }

  const sessionShort =
    typeof msg.message.session_id === "string"
      ? msg.message.session_id.slice(0, 8)
      : undefined;
  const startTime = Date.now();
  console.log(
    `${tag} Processing job ${jobId} (${jobType})${sessionShort ? ` session:${sessionShort}` : ""}`,
  );

  const executor = getExecutor(jobType);
  if (!executor) {
    console.error(`${tag} No executor for job type: ${jobType}`);
    await ctx.jobService.markFailed(
      jobId,
      "no_executor",
      `No executor registered for ${jobType}`,
    );
    await ctx.queue.archive(queue, msg.msg_id);
    return;
  }

  const { attempt_count, max_attempts } =
    await ctx.jobService.incrementAttempt(jobId);

  await ctx.jobService.markRunning(jobId);

  try {
    const result = await executor(
      jobId,
      msg.message as Record<string, unknown>,
      ctx,
    );
    await ctx.jobService.markSucceeded(jobId, result);
    await ctx.queue.deleteMessage(queue, msg.msg_id);
    console.log(`${tag} Job ${jobId} succeeded +${Date.now() - startTime}ms`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorCode = (err as { code?: string })?.code ?? "executor_error";

    // 不可重试的错误：同输入重试必然再失败，直接死信，让调用方快速拿到反馈
    const NON_RETRYABLE_CODES = new Set([
      "invalid_input",
      "model_not_found",
      "provider_not_found",
      "safety_filter",
    ]);
    const shouldDeadLetter =
      attempt_count >= max_attempts || NON_RETRYABLE_CODES.has(errorCode);

    if (shouldDeadLetter) {
      await ctx.jobService.markDeadLetter(jobId, errorCode, errorMessage);
      await ctx.queue.archive(queue, msg.msg_id);
      await refundDeadLetteredJob(jobId, ctx, creditService, tag);

      console.error(
        `${tag} Job ${jobId} dead-lettered after ${attempt_count} attempts +${Date.now() - startTime}ms: ${errorMessage}`,
      );
    } else {
      await ctx.jobService.markFailed(jobId, errorCode, errorMessage);
      // 消息在可见性超时后重新可见，走重试
      console.warn(
        `${tag} Job ${jobId} failed (attempt ${attempt_count}/${max_attempts}) +${Date.now() - startTime}ms: ${errorMessage}`,
      );
    }
  }
}

/**
 * 死信任务退款（仅永久失败的任务；取消的任务不退）。
 */
async function refundDeadLetteredJob(
  jobId: string,
  ctx: ExecutorContext,
  creditService: CreditService,
  tag: string,
) {
  try {
    const creditsInfo = await ctx.jobService.getCreditsInfo(jobId);
    if (!creditsInfo) return;

    const { creditsCost, workspaceId, createdBy } = creditsInfo;
    if (creditsCost <= 0 || !workspaceId || !createdBy) return;

    const txId = await creditService.refundCredits(
      workspaceId,
      createdBy,
      creditsCost,
      jobId,
      "Auto-refund: job failed",
    );
    console.log(
      `${tag} Refunded ${creditsCost} credits for job ${jobId} (tx: ${txId})`,
    );
  } catch (refundError) {
    // 只记日志：任务已死信，退款失败不该拖垮 worker
    console.error(
      `${tag} Failed to refund credits for job ${jobId}:`,
      refundError,
    );
  }
}

export type { QueueClient };
