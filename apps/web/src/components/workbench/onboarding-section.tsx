"use client";

import { useEffect, useState } from "react";
import {
  fetchPermissionSettings,
  fetchProviderInstances,
  fetchWorkspaceSettings,
  type PermissionSettingsView,
} from "@/lib/server-api";
import { SETTINGS_ROW, SETTINGS_TITLE } from "@/lib/settings-layout";

/**
 * 设置 → 引导（R5-2 的条目之一，落成**真实状态检查**而不是静态说明书）。
 *
 * 四步都能用真数据判定「做了没有」：配模型（供应商实例）/ 绑定工作目录（kind=code 的项目）/
 * 权限档（服务端设置）/ 首次对话（会话数）。**不写死「已完成」**——状态来自接口。
 *
 * 每步**只有一个**右侧位：未完成是「去处理」按钮，已完成是绿色状态字。
 * 状态字刻意不画边框底纹——画成与按钮同形的胶囊就成了「按下去没反应」的假按钮。
 * 未完成步一律有去处理：目标是设置页就切页，不在设置里（绑目录 / 发消息）就关掉设置
 * 把用户送回工作台——曾经这两步右侧是空的，用户看到一张卡片却不知道该干什么。
 *
 * 每步**不写副标题**：标题就是动作（「接入模型」「绑定工作目录」…），再来一句
 * 「供应商里填 Key 与模型」是把标题换个说法说两遍（2026-09-27 用户口径「还是很啰嗦」）。
 */

export interface OnboardingStep {
  id: string;
  title: string;
  done: boolean;
  /** 未完成时「去处理」跳去哪个设置页；`null` = 目标不在设置里（关掉设置回工作台）。 */
  tab: "providers" | "permissions" | null;
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
      done: input.providerCount > 0,
      tab: "providers",
    },
    {
      id: "workdir",
      title: "绑定工作目录",
      done: input.hasWorkDir,
      tab: null,
    },
    {
      id: "permission",
      title: "选权限档位",
      done: input.permissionTier !== "default",
      tab: "permissions",
    },
    {
      id: "first-run",
      title: "发第一条消息",
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
  onLeaveSettings,
}: {
  accessToken: string;
  /** 是否已有 kind=code 的工作目录项目（由工作台按**真实项目列表**传入）。 */
  hasWorkDir: boolean;
  /** 侧栏里已可见的会话数。 */
  conversationCount: number;
  onGoToTab: (tab: "providers" | "permissions") => void;
  /** 「去处理」的目标不在设置里时（绑目录 / 发消息）：关掉设置，把用户送回工作台。 */
  onLeaveSettings: () => void;
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
      <h3 className={SETTINGS_TITLE}>引导</h3>
      {message ? <p className="text-sm text-destructive">{message}</p> : null}
      {steps ? (
        <ol className="space-y-2">
          {steps.map((step, index) => {
            const tab = step.tab;
            return (
              <li key={step.id} className={SETTINGS_ROW}>
                <span
                  aria-hidden
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                    step.done
                      ? "bg-emerald-500/15 text-emerald-600"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {step.done ? "✓" : index + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm">{step.title}</span>
                {step.done ? (
                  <span className="shrink-0 text-xs text-emerald-600">
                    已完成
                  </span>
                ) : (
                  /* h-5 = 序号圆点的高度：尾槽不超过它，已完成行与去处理行才是同一行高 */
                  <button
                    type="button"
                    onClick={() => (tab ? onGoToTab(tab) : onLeaveSettings())}
                    className="inline-flex h-5 shrink-0 items-center rounded-md border px-2 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                  >
                    去处理
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">读取中…</p>
      )}
    </section>
  );
}
