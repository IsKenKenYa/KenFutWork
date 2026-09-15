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
import {
  approveToolPermission,
  fetchPermissionTier,
  updatePermissionTier,
} from "@/lib/server-api";

const TIERS: Array<{ value: PermissionTier; label: string; hint: string }> = [
  {
    value: "default",
    label: "默认（推荐）",
    hint: "危险/不可逆操作需人工审批",
  },
  {
    value: "auto-approve",
    label: "自动放行",
    hint: "命中已批准策略的调用自动通过",
  },
  {
    value: "full-access",
    label: "完全访问",
    hint: "不限制（明示开启，风险自担）",
  },
];

const SCOPES = [
  { value: "once", label: "仅本次" },
  { value: "thread", label: "本会话" },
  { value: "forever", label: "永久" },
] as const;

/** 权限设置（DEC-4）：三档策略 + 工具审批（记忆粒度：本次/会话/永久）。 */
export function PermissionSection({ accessToken }: { accessToken: string }) {
  const [tier, setTier] = useState<PermissionTier>("default");
  const [toolName, setToolName] = useState("");
  const [scope, setScope] = useState<(typeof SCOPES)[number]["value"]>("once");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const { tier: current } = await fetchPermissionTier(accessToken);
      setTier(current);
    } catch {
      setMessage("无法加载权限档位");
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleTierChange = async (next: PermissionTier) => {
    setSaving(true);
    setMessage(null);
    try {
      await updatePermissionTier(accessToken, next);
      setTier(next);
      setMessage("权限档位已更新");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "更新失败");
    } finally {
      setSaving(false);
    }
  };

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
      setMessage(`已批准 ${toolName.trim()}（${scope}）`);
      setToolName("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "批准失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="权限设置">
      <h3 className="mb-1 text-base font-medium">权限档位</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        危险工具（shell/MCP/写类）在默认档下必须审批；审批只能由你发起。
      </p>
      <div className="mb-4 space-y-2">
        {TIERS.map((t) => (
          <label
            key={t.value}
            className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <input
              type="radio"
              name="permission-tier"
              value={t.value}
              checked={tier === t.value}
              onChange={() => void handleTierChange(t.value)}
              disabled={saving}
            />
            <span>
              {t.label}
              <span className="ml-2 text-xs text-muted-foreground">
                {t.hint}
              </span>
            </span>
          </label>
        ))}
      </div>

      <h3 className="mb-1 text-base font-medium">工具审批</h3>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="工具名"
          placeholder="如 mcp__fs__write"
          value={toolName}
          onChange={(e) => setToolName(e.target.value)}
          className="w-48 rounded-md border px-3 py-1.5 text-sm"
        />
        <Select
          value={scope}
          onValueChange={(next) => {
            if (typeof next === "string") setScope(next as typeof scope);
          }}
          items={SCOPES.map((s) => ({ value: s.value, label: s.label }))}
        >
          <SelectTrigger aria-label="记忆粒度" className="py-1.5">
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
      {message ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  );
}
