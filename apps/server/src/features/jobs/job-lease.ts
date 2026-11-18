import type { ExecutorContext } from "./job-executor.js";

/** 一次消费的执行权；所有后续副作用边界重新确认数据库租约。 */
export function createLeasedContext(
  ctx: ExecutorContext,
  jobId: string,
  token: string,
  seconds: number,
  options: { allowCanceled?: boolean } = {},
) {
  const controller = new AbortController();
  const lost = () =>
    Object.assign(new Error("任务执行租约已失效"), { code: "job_lease_lost" });
  async function renew() {
    controller.signal.throwIfAborted();
    try {
      if (!(await ctx.jobService.renewLease(jobId, token, seconds)))
        throw lost();
      await ctx.renewVt(seconds);
    } catch {
      controller.abort(lost());
      controller.signal.throwIfAborted();
    }
  }
  async function assertActive() {
    await renew();
    if (!options.allowCanceled) {
      const current = await ctx.jobService.getJobForWorker(jobId);
      if (current.status === "canceled") throw lost();
    }
  }
  // 与队列可见性共用租期，续租间隔由租期推导，无第二份执行时限。
  const heartbeat = setInterval(
    () => {
      void renew().catch(() => {});
    },
    (seconds * 1000) / 3,
  );
  const context: ExecutorContext = {
    ...ctx,
    signal: controller.signal,
    assertExecution: assertActive,
    jobService: {
      ...ctx.jobService,
      beginSubmission: (id, revision) =>
        ctx.jobService.beginSubmission(id, revision, token),
      getJobForWorker: async (id) => {
        await assertActive();
        return ctx.jobService.getJobForWorker(id);
      },
      saveExecution: (id, execution, options) =>
        ctx.jobService.saveExecution(id, execution, {
          ...options,
          leaseToken: token,
        }),
      scheduleJob: (id, seconds) =>
        ctx.jobService.scheduleJob(id, seconds, token),
      setProviderJobId: (id, handle) =>
        ctx.jobService.setProviderJobId(id, handle, token),
      appendJobPayload: (id, fields) =>
        ctx.jobService.appendJobPayload(id, fields, token),
    },
    generationTargets: {
      ...ctx.generationTargets,
      resolve: async (job) => {
        await assertActive();
        return ctx.generationTargets.resolve(job);
      },
    },
    ...(ctx.usageService
      ? {
          usageService: {
            ...ctx.usageService,
            record: async (entry) => {
              await assertActive();
              await ctx.usageService?.record(entry);
            },
          },
        }
      : {}),
  };
  return {
    context,
    async close() {
      clearInterval(heartbeat);
      controller.abort(lost());
      await ctx.jobService.releaseLease(jobId, token);
    },
  };
}
