"use client";

import type { PermissionTier } from "@kenfutwork/shared";
import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TIER_OPTIONS } from "@/components/workbench/composer-compact-select";
import {
  approveToolPermission,
  fetchPermissionSettings,
  type PermissionSettingsView,
  updatePermissionSettings,
} from "@/lib/server-api";
import { SETTINGS_SECTION_GAP, SETTINGS_TITLE } from "@/lib/settings-layout";

/**
 * 权限设置（DEC-4；R5-3 补第 4 档与分场景）。
 *
 * 四档：默认（危险操作 ask）/ 自动放行 / 完全访问 / **自定义配置**（按规则表判）。
 * 分场景：**常规任务**与**自动化任务**（目标/循环这类无人值守轮次）各设一档——
 * 自动化档通常设得更严（批一次就一路跑，不会每一步都等人）。
 */
/**
 * 四档的**档名与说明与编排器那份完全一致**（默认 / 自动审批 / 完全访问 / 自定义）：
 * 同一个东西在设置页叫「自动放行」、在编排器叫「自动审批」会让人以为是两回事。
 * 文案只有 `composer-compact-select.tsx` 的 `TIER_OPTIONS` 一处来源，这里取来用。
 */
const TIERS: Array<{ value: PermissionTier; label: string; hint: string }> =
  TIER_OPTIONS.map(({ value, label, hint }) => ({ value, label, hint }));

function tierLabel(value: PermissionTier): string {
  return TIERS.find((tier) => tier.value === value)?.label ?? value;
}

/**
 * 档位选择器：四个档**横排**（用户口径「能左右就别上下」），选中档的含义在下面给一行小字。
 * 常规任务与自动化任务共用这一份——此前是两段复制粘贴的四行列表，改一处忘一处。
 */
function TierPicker({
  label,
  name,
  current,
  saving,
  onPick,
}: {
  /** fieldset 的可访问名（两组各一个）。 */
  label: string;
  name: string;
  current: PermissionTier;
  saving: boolean;
  onPick: (value: PermissionTier) => void;
}) {
  const selected = TIERS.find((tier) => tier.value === current);
  return (
    <fieldset aria-label={label} className="min-w-0">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TIERS.map((tier) => (
          <label
            key={tier.value}
            data-active={current === tier.value}
            className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-muted/60 data-[active=true]:border-foreground/40 data-[active=true]:bg-muted"
          >
            <input
              type="radio"
              name={name}
              value={tier.value}
              checked={current === tier.value}
              onChange={() => onPick(tier.value)}
              disabled={saving}
              className="shrink-0"
            />
            {tier.label}
          </label>
        ))}
      </div>
      {selected ? (
        <p className="mt-1 text-xs text-muted-foreground">{selected.hint}</p>
      ) : null}
    </fieldset>
  );
}

const SCOPES = [
  { value: "once", label: "仅本次" },
  { value: "thread", label: "本会话" },
  { value: "forever", label: "永久" },
] as const;

/** 文本域 ↔ 规则数组：一行一条（空行忽略），存储形状的转换只有这一处。 */
export function rulesToLines(rules: readonly string[]): string {
  return rules.join("\n");
}

export function linesToRules(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function PermissionSection({ accessToken }: { accessToken: string }) {
  const [settings, setSettings] = useState<PermissionSettingsView | null>(null);
  const [denyText, setDenyText] = useState("");
  const [allowText, setAllowText] = useState("");
  const [toolName, setToolName] = useState("");
  const [scope, setScope] = useState<(typeof SCOPES)[number]["value"]>("once");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const applyView = useCallback((next: PermissionSettingsView) => {
    setSettings(next);
    setDenyText(rulesToLines(next.rules.deny));
    setAllowText(rulesToLines(next.rules.allow));
  }, []);

  const load = useCallback(async () => {
    try {
      applyView(await fetchPermissionSettings(accessToken));
    } catch {
      setMessage("无法加载权限设置");
    }
  }, [accessToken, applyView]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (
      next: Parameters<typeof updatePermissionSettings>[1],
      okMessage: string,
    ) => {
      setSaving(true);
      setMessage(null);
      try {
        const view = await updatePermissionSettings(accessToken, next);
        // 与旧视图合并：服务端少给哪个键也不至于把界面打崩（approvedForever 曾经缺过）
        applyView({
          ...(settings ?? view),
          ...view,
          approvedForever:
            view.approvedForever ?? settings?.approvedForever ?? [],
        });
        setMessage(okMessage);
      } catch (err) {
        setMessage(err instanceof Error ? err.message : "更新失败");
      } finally {
        setSaving(false);
      }
    },
    [accessToken, applyView, settings],
  );

  const handleApprove = async () => {
    if (!toolName.trim()) {
      setMessage("请填写工具名");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await approveToolPermission(accessToken, {
        toolName: toolName.trim(),
        scope,
      });
      setMessage(
        `已批准 ${toolName.trim()}（${
          SCOPES.find((item) => item.value === scope)?.label ?? scope
        }）`,
      );
      setToolName("");
      void load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "批准失败");
    } finally {
      setSaving(false);
    }
  };

  const current = settings?.tier ?? "default";

  return (
    <section aria-label="权限设置" className={SETTINGS_SECTION_GAP}>
      <div>
        <h3 className={SETTINGS_TITLE}>常规任务</h3>
        <TierPicker
          label="常规任务档位"
          name="permission-tier"
          current={current}
          saving={saving}
          onPick={(value) =>
            void patch(
              { tier: value },
              `常规任务档位已更新：${tierLabel(value)}`,
            )
          }
        />

        {current === "custom" ? (
          <fieldset
            aria-label="自定义配置规则"
            className="mt-2 min-w-0 space-y-3 rounded-lg border border-dashed p-3"
          >
            <p className="text-xs text-muted-foreground">
              一行一条 · * 通配 · 拒绝优先
            </p>
            <label className="block text-sm">
              拒绝这些工具
              <textarea
                aria-label="拒绝规则"
                value={denyText}
                onChange={(event) => setDenyText(event.target.value)}
                rows={3}
                placeholder={"mcp__dangerous__delete\nshell_*"}
                className="mt-1 w-full rounded-md border px-2 py-1 font-mono text-xs"
              />
            </label>
            <label className="block text-sm">
              放行这些工具
              <textarea
                aria-label="放行规则"
                value={allowText}
                onChange={(event) => setAllowText(event.target.value)}
                rows={3}
                placeholder={"write_file\nmcp__py-helper__echo"}
                className="mt-1 w-full rounded-md border px-2 py-1 font-mono text-xs"
              />
            </label>
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                void patch(
                  {
                    rules: {
                      deny: linesToRules(denyText),
                      allow: linesToRules(allowText),
                    },
                  },
                  "自定义规则已保存",
                )
              }
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            >
              保存规则
            </button>
          </fieldset>
        ) : null}
      </div>

      <div>
        <h3 className={SETTINGS_TITLE}>自动化任务</h3>
        <TierPicker
          label="自动化任务档位"
          name="automation-permission-tier"
          current={settings?.automationTier ?? "default"}
          saving={saving}
          onPick={(value) =>
            void patch(
              { automationTier: value },
              `自动化任务档位已更新：${tierLabel(value)}`,
            )
          }
        />
      </div>

      <div>
        <h3 className={SETTINGS_TITLE}>工具审批</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="工具名"
            placeholder="如 mcp__fs__write"
            value={toolName}
            onChange={(e) => setToolName(e.target.value)}
            className="min-w-0 flex-1 rounded-md border px-3 py-1.5 text-sm"
          />
          <Select
            value={scope}
            onValueChange={(next) => {
              if (typeof next === "string") setScope(next as typeof scope);
            }}
            items={SCOPES.map((s) => ({ value: s.value, label: s.label }))}
          >
            <SelectTrigger
              aria-label="记忆粒度"
              className="w-28 shrink-0 py-1.5"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => void handleApprove()}
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            批准
          </button>
        </div>
        {settings && settings.approvedForever.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            已永久批准：{settings.approvedForever.join("、")}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
