import type { UsageSummaryResponse } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

/**
 * usage 缝（DEC-6）：token/成本计量，按 workspace/provider/model/run 落账。
 * 写入全部走服务角色（遥测追加，不经用户 RLS）；读取按用户客户端（RLS 隔离）。
 */

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

interface UsageRow {
  provider: string;
  model: string;
  capability: string;
  input_tokens: string | number;
  output_tokens: string | number;
  cost_usd: string | null;
}

export interface UsageService {
  record(entry: UsageEntry): Promise<void>;
  summarize(user: AuthenticatedUser): Promise<UsageSummaryResponse>;
  /** agent 链路结算：run 只有 userId，落账前解析个人工作区。 */
  resolveWorkspaceIdByUser(userId: string): Promise<string | undefined>;
}

// usage_records 未纳入 supabase 生成类型，走宽松访问（同 provider_instances）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untypedFrom = (client: unknown, table: string): any =>
  (client as any).from(table);

export function createUsageService(options: {
  getAdminClient: () => AdminSupabaseClient;
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): UsageService {
  const { getAdminClient, createUserClient } = options;

  async function resolveWorkspaceIdByUser(
    userId: string,
  ): Promise<string | undefined> {
    const admin = getAdminClient();
    const { data } = await admin
      .from("workspaces")
      .select("id")
      .eq("owner_user_id", userId)
      .eq("type", "personal")
      .limit(1)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? undefined;
  }

  return {
    resolveWorkspaceIdByUser,

    async record(entry) {
      const admin = getAdminClient();
      const { error } = await untypedFrom(admin, "usage_records").insert({
        workspace_id: entry.workspaceId,
        ...(entry.userId ? { user_id: entry.userId } : {}),
        provider: entry.provider,
        model: entry.model,
        capability: entry.capability,
        ...(entry.providerInstanceId
          ? { provider_instance_id: entry.providerInstanceId }
          : {}),
        ...(entry.runId ? { run_id: entry.runId } : {}),
        ...(entry.jobId ? { job_id: entry.jobId } : {}),
        input_tokens: entry.inputTokens ?? 0,
        output_tokens: entry.outputTokens ?? 0,
        ...(entry.totalTokens != null
          ? { total_tokens: entry.totalTokens }
          : {}),
        ...(entry.costUsd != null ? { cost_usd: entry.costUsd } : {}),
      });
      if (error) {
        // 计量失败不阻断主链路（「有剑不用」：usage 是旁路观测，不是主链路）
        console.warn("[usage] failed to record usage:", error.message);
      }
    },

    async summarize(user): Promise<UsageSummaryResponse> {
      const client = createUserClient(user.accessToken);
      const { data, error } = await untypedFrom(client, "usage_records")
        .select(
          "provider, model, capability, input_tokens, output_tokens, cost_usd",
        )
        .order("occurred_at", { ascending: false })
        .limit(10000);
      if (error) {
        throw new Error(`[usage] summary query failed: ${error.message}`);
      }
      const rows = (data ?? []) as UsageRow[];
      const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      const byModel = new Map<
        string,
        {
          provider: string;
          model: string;
          capability: "chat" | "image" | "video";
          inputTokens: number;
          outputTokens: number;
          costUsd: number;
        }
      >();
      for (const row of rows) {
        const inputTokens = Number(row.input_tokens) || 0;
        const outputTokens = Number(row.output_tokens) || 0;
        const costUsd = row.cost_usd != null ? Number(row.cost_usd) : 0;
        totals.inputTokens += inputTokens;
        totals.outputTokens += outputTokens;
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
        bucket.inputTokens += inputTokens;
        bucket.outputTokens += outputTokens;
        bucket.costUsd += costUsd;
        byModel.set(key, bucket);
      }
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
