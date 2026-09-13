import type { UsageSummaryResponse } from "@loomic/shared";

import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerRepository } from "../bootstrap/repository.js";
import type { UsageRecordRow, UsageRepository } from "./repository.js";

/**
 * usage 缝（DEC-6）：token/成本计量，按 workspace/provider/model/run 落账。
 * 写入与读取都经 `persistence` 缝的工作区作用域（隔离口径与其它聚合一致）。
 */

const SUMMARY_ROW_LIMIT = 10000;

export interface UsageEntry {
  workspaceId: string;
  /** 归属用户：平台池计费与管理后台按用户聚合都需要。 */
  userId?: string;
  provider: string;
  model: string;
  capability: "chat" | "image" | "video";
  providerInstanceId?: string;
  runId?: string;
  jobId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface UsageService {
  record(entry: UsageEntry): Promise<void>;
  summarize(user: AuthenticatedUser): Promise<UsageSummaryResponse>;
  /** agent 链路结算：run 只有 userId，落账前解析个人工作区。 */
  resolveWorkspaceIdByUser(userId: string): Promise<string | undefined>;
}

type ModelBucket = {
  provider: string;
  model: string;
  capability: "chat" | "image" | "video";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export function createUsageService(options: {
  repository: UsageRepository;
  /** 复用 workspaces 域的数据访问（worker 进程无 auth，故不经 viewer 服务）。 */
  workspaces: ViewerRepository;
}): UsageService {
  const { repository, workspaces } = options;

  function aggregate(rows: UsageRecordRow[]) {
    const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const byModel = new Map<string, ModelBucket>();

    for (const row of rows) {
      const costUsd = row.cost_usd ?? 0;
      totals.inputTokens += row.input_tokens;
      totals.outputTokens += row.output_tokens;
      totals.costUsd += costUsd;

      const key = `${row.provider}:${row.model}`;
      const bucket = byModel.get(key) ?? {
        provider: row.provider,
        model: row.model,
        capability: row.capability as "chat" | "image" | "video",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      bucket.inputTokens += row.input_tokens;
      bucket.outputTokens += row.output_tokens;
      bucket.costUsd += costUsd;
      byModel.set(key, bucket);
    }

    return { byModel, totals };
  }

  async function resolveWorkspaceIdByUser(
    userId: string,
  ): Promise<string | undefined> {
    const workspace = await workspaces
      .findPersonalWorkspace(userId)
      .catch(() => null);
    return workspace?.id;
  }

  return {
    resolveWorkspaceIdByUser,

    async record(entry) {
      try {
        await repository.insert({
          workspaceId: entry.workspaceId,
          ...(entry.userId ? { userId: entry.userId } : {}),
          provider: entry.provider,
          model: entry.model,
          capability: entry.capability,
          ...(entry.providerInstanceId
            ? { providerInstanceId: entry.providerInstanceId }
            : {}),
          ...(entry.runId ? { runId: entry.runId } : {}),
          ...(entry.jobId ? { jobId: entry.jobId } : {}),
          inputTokens: entry.inputTokens ?? 0,
          outputTokens: entry.outputTokens ?? 0,
          ...(entry.totalTokens != null
            ? { totalTokens: entry.totalTokens }
            : {}),
          ...(entry.costUsd != null ? { costUsd: entry.costUsd } : {}),
        });
      } catch (error) {
        // 计量失败不阻断主链路（「有剑不用」：usage 是旁路观测，不是主链路）
        console.warn(
          "[usage] failed to record usage:",
          error instanceof Error ? error.message : error,
        );
      }
    },

    async summarize(user): Promise<UsageSummaryResponse> {
      const workspaceId = await resolveWorkspaceIdByUser(user.id);
      if (!workspaceId) {
        throw new Error("[usage] summary query failed: workspace not found");
      }

      const rows = await repository
        .listRecent(workspaceId, SUMMARY_ROW_LIMIT)
        .catch((error: unknown) => {
          throw new Error(
            `[usage] summary query failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });

      const { byModel, totals } = aggregate(rows);

      return {
        totals: {
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          ...(totals.costUsd > 0 ? { costUsd: totals.costUsd } : {}),
        },
        byModel: [...byModel.values()].map((bucket) => ({
          provider: bucket.provider,
          model: bucket.model,
          capability: bucket.capability,
          inputTokens: bucket.inputTokens,
          outputTokens: bucket.outputTokens,
          ...(bucket.costUsd > 0 ? { costUsd: bucket.costUsd } : {}),
        })),
      };
    },
  };
}
