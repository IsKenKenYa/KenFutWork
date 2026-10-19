import { randomUUID } from "node:crypto";

import type { BackgroundJob, BackgroundJobType } from "@kenfutwork/shared";
import type { ServerEnv } from "../../config/env.js";
import { type QueueClient, QueueClosedError } from "../queue/types.js";
import { executeJobCancellation } from "./job-cancellation.js";
import { type ExecutorContext, getExecutor } from "./job-executor.js";
import { classifyJobFailure } from "./job-failure.js";
import { createLeasedContext } from "./job-lease.js";
import { readJobCancellation, readJobExecution } from "./job-progress.js";
import { JobServiceError } from "./job-service.js";

/**
 * 生成类任务的消费循环（worker 与桌面单进程共用）。
 *
 * 抽出来的理由（M2.3）：桌面形态是**单进程**（server + 任务执行同进程），而进程内队列
 * 的生产者与消费者必须是**同一个实例**（M3.2：消息只在内存里，两个内核实例互相看不见）。
 * 故循环不能藏在 `worker.ts` 里，必须能被「已有内核」的调用方复用。
 *
 * 行为与抽出前一致：并发上限、可见性超时、长轮询、失败重试/死信、死信、优雅退出。
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
  "msgId" | "queueName" | "renewVt" | "retryBaseDelayMs"
> & { env: ServerEnv };

export type JobLoopHandle = {
  /** 停止轮询 → 等在建任务收尾 → 关闭队列（顺序与抽出前一致）。 */
  shutdown(): Promise<void>;
  /** 当前在建任务数（诊断用）。 */
  inFlightCount(): number;
};
export type JobLoopService = JobLoopHandle;

export function startJobLoop(
  ctx: JobLoopContext,
  options: { queues?: readonly string[]; tag?: string } = {},
): JobLoopHandle {
  const queues: readonly string[] = options.queues ?? JOB_QUEUES;
  const tag =
    options.tag ?? `[worker:${ctx.env.workerId ?? randomUUID().slice(0, 8)}]`;
  const env = ctx.env;

  const concurrencyByQueue: Record<string, number> = {
    image_generation_jobs:
      env.workerImageConcurrency ?? Number.POSITIVE_INFINITY,
    video_generation_jobs:
      env.workerVideoConcurrency ?? Number.POSITIVE_INFINITY,
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

  let recoveryTask: Promise<void> | undefined;
  const recover = () => {
    recoveryTask ??= ctx.jobService
      .recoverPendingJobs(queues, pollTimeoutSeconds)
      .catch((error) => console.error(`${tag} Job recovery failed:`, error))
      .finally(() => {
        recoveryTask = undefined;
      });
    return recoveryTask;
  };
  void recover();
  const recoveryTimer = setInterval(() => {
    void recover();
  }, pollTimeoutSeconds * 1000);

  // 两种队列独立长轮询，空队列和显式限流不阻塞另一种媒体。
  const consumerPromise = Promise.all(
    queues.map(async (queueName) => {
      const inFlight = inFlightByQueue.get(queueName);
      if (!inFlight) return;
      const cap = concurrencyByQueue[queueName] ?? 1;
      while (running) {
        const available = Math.min(
          env.workerMaxBatchSize ?? 1,
          cap - inFlight.size,
        );
        if (available <= 0) {
          await Promise.race(inFlight);
          continue;
        }
        try {
          const messages = await ctx.queue.readWithPoll(
            queueName,
            VT_BY_QUEUE[queueName] ?? 120,
            available,
            pollTimeoutSeconds,
            500,
          );
          if (!running) break;
          for (const msg of messages) {
            const messageCtx: ExecutorContext = {
              ...ctx,
              queueName,
              msgId: msg.msg_id,
              retryBaseDelayMs: pollTimeoutSeconds * 1000,
              renewVt: async (vtSeconds) => {
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
            const task = processMessage(queueName, msg, messageCtx, tag)
              .catch((error) => {
                // 数据库暂不可用时保留消息，不能绕过认领执行供应商请求。
                console.error(`${tag} Message execution interrupted:`, error);
              })
              .finally(() => inFlight.delete(task));
            inFlight.add(task);
          }
        } catch (error) {
          if (error instanceof QueueClosedError) {
            running = false;
            break;
          }
          console.error(`${tag} Error polling ${queueName}:`, error);
        }
      }
    }),
  );

  let shutdownPromise: Promise<void> | undefined;
  return {
    inFlightCount: totalInFlight,
    shutdown() {
      shutdownPromise ??= (async () => {
        const count = totalInFlight();
        console.log(
          `${tag} Shutting down, waiting for ${count} in-flight jobs...`,
        );
        running = false;
        clearInterval(recoveryTimer);
        await recoveryTask;
        const tasks = [...inFlightByQueue.values()].flatMap((set) => [...set]);
        if (tasks.length > 0) {
          await Promise.allSettled(tasks);
        }
        await ctx.queue.shutdown();
        await consumerPromise;
        console.log(`${tag} Shutdown complete.`);
      })();
      return shutdownPromise;
    },
  };
}

async function processMessage(
  queue: string,
  msg: { message: Record<string, unknown>; msg_id: number },
  ctx: ExecutorContext,
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

  let current: BackgroundJob;
  try {
    current = await ctx.jobService.getJobForWorker(jobId);
  } catch (error) {
    if (error instanceof JobServiceError && error.code === "job_not_found")
      await ctx.queue.archive(queue, msg.msg_id);
    else console.error(`${tag} Unable to read job ${jobId}:`, error);
    return;
  }
  if (
    (current.error_code === "submission_unknown" &&
      !current.provider_job_id &&
      current.status !== "canceled") ||
    (current.status === "canceled" &&
      readJobCancellation(current)?.state !== "pending") ||
    current.status === "succeeded" ||
    current.status === "dead_letter"
  ) {
    await ctx.queue.archive(queue, msg.msg_id);
    return;
  }

  const token = randomUUID();
  const leaseSeconds = VT_BY_QUEUE[queue] ?? 120;
  const claimed = await ctx.jobService.claimJob(jobId, token, leaseSeconds);
  if (!claimed) {
    await ctx.queue.setVisibilityTimeout(queue, msg.msg_id, leaseSeconds);
    return;
  }
  const lease = createLeasedContext(ctx, jobId, token, leaseSeconds, {
    allowCanceled: claimed.status === "canceled",
  });

  try {
    if (claimed.status === "canceled") {
      await executeJobCancellation(claimed, lease.context, token);
      await ctx.queue.archive(queue, msg.msg_id);
      return;
    }
    if (!executor) {
      await ctx.jobService.markDeadLetter(
        jobId,
        "no_executor",
        `No executor registered for ${jobType}`,
        token,
      );
      await ctx.queue.archive(queue, msg.msg_id);
      return;
    }
    const result = await executor(
      jobId,
      msg.message as Record<string, unknown>,
      lease.context,
    );
    await ctx.jobService.markSucceeded(jobId, result, token);
    await ctx.queue.deleteMessage(queue, msg.msg_id);
    console.log(`${tag} Job ${jobId} succeeded +${Date.now() - startTime}ms`);
  } catch (err) {
    await handleExecutionFailure(err, jobId, ctx, token, tag, startTime);
  } finally {
    await lease.close();
  }
}

export type { QueueClient };

async function handleExecutionFailure(
  err: unknown,
  jobId: string,
  ctx: ExecutorContext,
  token: string,
  tag: string,
  startTime: number,
) {
  const errorCode = (err as { code?: string })?.code ?? "executor_error";

  if (errorCode === "job_lease_lost") return;

  // 异步任务面（S6）：executor 已投下一条延迟 poll 消息——本次消费到此为止，
  // job 行保持 running（轮询状态不在行上推进），当前消息直接归档。
  if (errorCode === "provider_poll_scheduled") {
    await ctx.queue.archive(ctx.queueName, ctx.msgId);
    console.log(
      `${tag} Job ${jobId} poll scheduled +${Date.now() - startTime}ms`,
    );
    return;
  }

  const current = await ctx.jobService.getJobForWorker(jobId);
  if (current.status === "canceled") {
    await ctx.queue.archive(ctx.queueName, ctx.msgId);
    return;
  }
  const policy = classifyJobFailure(
    current,
    err,
    current.attempt_count + 1,
    ctx.retryBaseDelayMs,
  );
  if (policy.kind === "uncertain") {
    await ctx.jobService.markUncertain(jobId, policy.message, token);
    await ctx.queue.archive(ctx.queueName, ctx.msgId);
    return;
  }
  const { attempt_count, max_attempts } = await ctx.jobService.incrementAttempt(
    jobId,
    token,
  );
  if (policy.kind === "terminal" || attempt_count >= max_attempts) {
    const completed =
      readJobExecution(current).outputs?.flatMap((output) =>
        output.stored ? [output.stored] : [],
      ) ?? [];
    const partialResult = completed.length
      ? { ...completed[0], outputs: completed }
      : undefined;
    await ctx.jobService.markDeadLetter(
      jobId,
      policy.code,
      policy.message,
      token,
      partialResult,
    );
  } else {
    await ctx.jobService.retryJob(
      jobId,
      {
        errorCode: policy.code,
        errorMessage: policy.message,
        delaySeconds: policy.delaySeconds,
        ...(policy.execution ? { execution: policy.execution } : {}),
      },
      token,
    );
  }
  await ctx.queue.archive(ctx.queueName, ctx.msgId);
}
