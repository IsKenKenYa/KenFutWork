"use client";

import { useEffect, useState } from "react";
import {
  fetchPermissionSettings,
  fetchProviderInstances,
  fetchWorkspaceSettings,
  type PermissionSettingsView,
} from "@/lib/server-api";

/**
 * 设置 → 引导（R5-2 的条目之一，落成**真实状态检查**而不是静态说明书）。
 *
 * 四步都能用真数据判定「做了没有」：配模型（供应商实例）/ 绑定工作目录（kind=code 的项目）/
 * 权限档（服务端设置）/ 首次对话（会话数）。每步给「去处理」直接跳到对应设置页，
 * 或者说明为什么现在还没法判定。**不写死「已完成」**——状态来自接口。
 */

export interface OnboardingStep {
  id: string;
  title: string;
  hint: string;
  done: boolean;
  /** 未完成时跳去哪个设置页（null = 不在设置里）。 */
  tab: "providers" | "general" | "permissions" | null;
}

export function buildOnboardingSteps(input: {
  providerCount: number;
  hasWorkDir: boolean;
  permissionTier: string;
  conversationCount: number;
}): OnboardingStep[] {
  return [
    {
      id: "provider",
      title: "接入模型",
      hint: "在「供应商」里填自己的 API Key 和模型。",
      done: input.providerCount > 0,
      tab: "providers",
    },
    {
      id: "workdir",
      title: "绑定工作目录",
      hint: "在 Code 模式里选一个目录，Agent 就在那里读写文件和执行命令。",
      done: input.hasWorkDir,
      tab: null,
    },
    {
      id: "permission",
      title: "选权限档位",
      hint: "危险操作需要你确认；无人值守的任务先在「权限」里设好档位。",
      done: input.permissionTier !== "default",
      tab: "permissions",
    },
    {
      id: "first-run",
      title: "发第一条消息",
      hint: "在工作台里发一句试试。",
      done: input.conversationCount > 0,
      tab: null,
    },
  ];
}

export function OnboardingSection({
  accessToken,
  hasWorkDir,
  conversationCount,
  onGoToTab,
}: {
  accessToken: string;
  /** 是否已有 kind=code 的工作目录项目（由工作台按**真实项目列表**传入）。 */
  hasWorkDir: boolean;
  /** 侧栏里已可见的会话数。 */
  conversationCount: number;
  onGoToTab: (tab: "providers" | "general" | "permissions") => void;
}) {
  const [steps, setSteps] = useState<OnboardingStep[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchProviderInstances(accessToken).catch(() => null),
      fetchWorkspaceSettings(accessToken).catch(() => null),
      fetchPermissionSettings(accessToken).catch(() => null),
    ]).then(([providers, settings, permissions]) => {
      if (cancelled) return;
      if (!providers || !settings) {
        setMessage("读取状态失败，请稍后重试。");
        return;
      }
      const view = permissions as PermissionSettingsView | null;
      setSteps(
        buildOnboardingSteps({
          providerCount: providers.instances.length,
          hasWorkDir,
          permissionTier: view?.tier ?? "default",
          conversationCount,
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [accessToken, conversationCount, hasWorkDir]);

  return (
    <section aria-label="引导">
      <h3 className="mb-1 text-base font-medium">引导</h3>
      <p className="mb-3 text-sm text-muted-foreground">四步把工作台跑起来。</p>
      {message ? <p className="text-sm text-destructive">{message}</p> : null}
      {steps ? (
        <ol className="space-y-2">
          {steps.map((step, index) => (
            <li
              key={step.id}
              className="flex items-start gap-3 rounded-lg border px-3 py-2"
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                  step.done
                    ? "bg-emerald-500/15 text-emerald-600"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {step.done ? "✓" : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{step.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {step.hint}
                </span>
              </span>
              {step.done ? (
                <span className="shrink-0 text-[11px] text-emerald-600">
                  已完成
                </span>
              ) : step.tab ? (
                <button
                  type="button"
                  onClick={() =>
                    onGoToTab(
                      step.tab as "providers" | "general" | "permissions",
                    )
                  }
                  className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                >
                  去处理
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">读取中…</p>
      )}
    </section>
  );
}
