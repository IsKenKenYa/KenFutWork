"use client";

import { Bot, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  type AgentSubagentListResponse,
  fetchSubagents,
} from "@/lib/server-api";

/**
 * 设置 → 子智能体（R5-2：参考图里的「子智能体」条目）。
 *
 * 内容来自 `GET /api/agent/subagents`，而那份清单**就是 agent 装配处用的那一份**
 * （`apps/server/src/agent/sub-agents.ts`）——所以这里列出的子代理真的会被派活，
 * 不是另写一遍的说明文字。
 *
 * 运行情况由原 Code 会话和子代理目录显示；此共享设置页只导航到真实工作台。
 */
/** 声明的子代理（带 tools）与内置分发工具（不带）合成一行行同形状的展示条目。 */
function subagentRows(data: AgentSubagentListResponse): Array<{
  name: string;
  label: string;
  description: string;
  tools?: string[];
}> {
  return [...data.subagents, ...data.builtin];
}

export function SubagentsSection({
  accessToken,
}: {
  accessToken: string | null;
}) {
  const [data, setData] = useState<AgentSubagentListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    fetchSubagents(accessToken)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "读取子智能体失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  return (
    <section aria-label="子智能体设置">
      <h3 className="mb-1 text-base font-medium">子智能体</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        主 Agent 可以把子任务交给下面这些子智能体执行，运行情况在 Code
        会话的子智能体目录里看。
      </p>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">正在读取…</p>
      ) : (
        <div className="space-y-3">
          <ul className="divide-y rounded-lg border">
            {subagentRows(data).map((entry) => (
              <li
                key={entry.name}
                className="flex items-start gap-3 px-3 py-2.5"
              >
                <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {entry.label}
                    <code className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {entry.name}
                    </code>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {entry.description}
                  </p>
                  {entry.tools && entry.tools.length > 0 ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      工具：{entry.tools.join("、")}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => router.push("/workbench")}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            前往 Code 查看子智能体
          </button>
        </div>
      )}
    </section>
  );
}
