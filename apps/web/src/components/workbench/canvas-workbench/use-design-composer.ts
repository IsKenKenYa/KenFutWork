"use client";
import type { ExecutionMode } from "@kenfutwork/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { contextUsageModelMeta } from "@/lib/context-usage";
import { getServerBaseUrl } from "@/lib/env";
import { fetchProjects, fetchWorkspaceSettings } from "@/lib/server-api";
import type { WorkspaceCommand } from "@/lib/slash-commands";
export type WorkbenchModelOption = {
  id: string;
  name: string;
  providerName?: string | undefined;
  vision?: boolean | undefined;
  contextWindow?: number | undefined;
  /** 单次最大输出（供应商实例声明）；上下文条「预留输出」段的来源。 */
  maxOutputTokens?: number | undefined;
};

export function useDesignComposer() {
  const { session } = useAuth();
  const [tier, setTier] = useState("default");
  /** 「完全访问」的风险确认弹窗（确认后才写库与生效）。 */
  const [pendingFullAccess, setPendingFullAccess] = useState(false);
  const [thinking, setThinking] = useState("default");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("agent");
  const [executionModes, setExecutionModes] = useState<
    Array<{
      id: ExecutionMode;
      label: string;
      description: string;
      inputDirective?: string | undefined;
    }>
  >([]);
  const [models, setModels] = useState<WorkbenchModelOption[]>([]);
  const [model, setModel] = useState("");
  const [commands, setCommands] = useState<WorkspaceCommand[]>([]);
  const [hasWorkDir, setHasWorkDir] = useState(false);
  const modelMeta = useMemo(
    () => contextUsageModelMeta(models, model),
    [models, model],
  );
  useEffect(() => {
    try {
      setThinking(localStorage.getItem("workbench:thinking") ?? "default");
      setModel(localStorage.getItem("workbench:model") ?? "");
    } catch {}
  }, []);
  const handleThinkingChange = useCallback((next: string) => {
    setThinking(next);
    try {
      window.localStorage.setItem("workbench:thinking", next);
    } catch {
      // 存储失败不阻塞
    }
  }, []);
  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    fetchWorkspaceSettings(token)
      .then((data) => {
        setCommands(data.settings.commands);
      })
      .catch(() => {});
  }, [session]);
  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    fetch(`${getServerBaseUrl()}/api/execution-modes`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : { modes: [] }))
      .then(
        (data: {
          modes: Array<{
            id: ExecutionMode;
            label: string;
            description: string;
            inputDirective?: string | undefined;
          }>;
        }) => setExecutionModes(data.modes),
      )
      .catch(() => {});
  }, [session]);
  useEffect(() => {
    if (!session?.access_token) return;
    fetch(`${getServerBaseUrl()}/api/permissions/tier`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.tier) setTier(data.tier);
      })
      .catch(() => {});
    // 模型目录（带凭证并入 BYOK 实例）
    fetch(`${getServerBaseUrl()}/api/models`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((data: { models: WorkbenchModelOption[] }) => {
        setModels(data.models);
        /**
         * 默认取「上次选的」（`workbench:model`），失效才回落目录第一条。
         *
         * 只取第一条会踩到：目录顺序取决于实例创建序，工作区里常同时挂着多个实例
         * （自带的、替身、平台池），刷新后默认模型可能变成用户没要的那个实例——
         * 实测因此拿着一个失效实例的 Key 每轮 401。
         */
        setModel((current) =>
          current && data.models.some((m) => m.id === current)
            ? current
            : (data.models[0]?.id ?? ""),
        );
      })
      .catch(() => {});
  }, [session]);

  /** 模型选择：记住到 localStorage（与 thinking 同一口径）。 */
  const handleModelChange = useCallback((next: string) => {
    setModel(next);
    try {
      window.localStorage.setItem("workbench:model", next);
    } catch {
      // 存储失败不阻塞
    }
  }, []);
  const applyTier = useCallback(
    async (next: string) => {
      setTier(next);
      if (!session?.access_token) return;
      try {
        await fetch(`${getServerBaseUrl()}/api/permissions/tier`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ tier: next }),
        });
      } catch {
        // 权限档位失败不阻塞任务
      }
    },
    [session],
  );

  /**
   * 切档：**「完全访问」先过一道风险确认**（用户口径：不要用括号交代风险，改成弹窗提示并确认）。
   * 其余三档直接生效。
   */
  const handleTierChange = useCallback(
    async (next: string) => {
      if (next === "full-access" && tier !== "full-access") {
        setPendingFullAccess(true);
        return;
      }
      await applyTier(next);
    },
    [applyTier, tier],
  );
  useEffect(() => {
    if (!session?.access_token) return;
    fetchProjects(session.access_token, "code")
      .then((data) => setHasWorkDir(data.projects.length > 0))
      .catch(() => {});
  }, [session]);
  return {
    tier,
    thinking,
    executionMode,
    setExecutionMode,
    executionModes,
    models,
    model,
    modelMeta,
    commands,
    hasWorkDir,
    pendingFullAccess,
    setPendingFullAccess,
    applyTier,
    handleTierChange,
    handleModelChange,
    handleThinkingChange,
  };
}
