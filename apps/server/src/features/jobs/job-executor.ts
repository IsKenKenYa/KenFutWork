import type { BackgroundJobType } from "@kenfutwork/shared";
import type { ServerEnv } from "../../config/env.js";
import type { BlobStore } from "../blob/types.js";
import type { CreditService } from "../credits/credit-service.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";
import type { QueueClient } from "../queue/types.js";
import type { AssetWriter } from "../uploads/asset-writer.js";
import type { UsageService } from "../usage/usage-service.js";
import type { JobService } from "./job-service.js";

export type ExecutorContext = {
  jobService: JobService;
  /** 队列缝（M3.2）。 */
  queue: QueueClient;
  env: ServerEnv;
  /** BYOK：任务携带 provider_instance_id 时经此解析凭证（P4）。 */
  modelProviders?: ModelProviderService;
  /** 用量落账（DEC-6 直连生成链路采集点）。 */
  usageService?: UsageService;
  /** 套餐读取（水印判定）：executor 无用户身份，按任务记录的工作区取。 */
  creditService: CreditService;
  /** 生成物元数据写入：executor 无用户身份，按任务记录的工作区写。 */
  assetWriter: AssetWriter;
  /** 对象存储（blob 缝）：生成物上传与 URL，executor 不再直连 Supabase Storage。 */
  blob: BlobStore;
  /** 当前任务的队列名（worker 按消息设置）。 */
  queueName: string;
  /** PGMQ message id for the current job (set per-message by the worker). */
  msgId: number;
  /**
   * Best-effort VT renewal — extends visibility timeout so the message
   * stays invisible while the executor is still working.
   * Never throws; logs on failure.
   */
  renewVt: (vtSeconds: number) => Promise<void>;
};

export type JobExecutor = (
  jobId: string,
  payload: Record<string, unknown>,
  ctx: ExecutorContext,
) => Promise<Record<string, unknown>>;

const executors = new Map<BackgroundJobType, JobExecutor>();

export function registerExecutor(
  jobType: BackgroundJobType,
  executor: JobExecutor,
): void {
  executors.set(jobType, executor);
}

export function getExecutor(
  jobType: BackgroundJobType,
): JobExecutor | undefined {
  return executors.get(jobType);
}
