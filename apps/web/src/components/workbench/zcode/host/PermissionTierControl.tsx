import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { Input } from "@zui/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import { Textarea } from "@zui/components/ui/textarea.js";
import { toast } from "@zui/components/ui/toast.js";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@zui/components/lib/utils.js";
import {
  SettingsGroupCard,
  SettingsRow,
  SettingsSubheading,
} from "@zui/settings/SettingsPageParts.js";
import { useCallback, useEffect, useState } from "react";
import { ModelDefaultsSection } from "./ModelDefaultsSection.js";
import { surfaceJson } from "./surfaceApi.js";

/**
 * 权限档（G7/T7/C1，KenFutWork 宿主件）：旧四档语义（默认/自动审批/完全访问/自定义）
 * 充当「新会话默认档」（Q12：不采用 ZCode build/edit/plan/yolo 作权限档）。
 *
 * 数据面：GET/PUT /api/permissions/tier（app_config 写穿 + 启动读回）。
 * 服务端 evaluate 已在 agent-runs toolGateFor 生效（内置工具 + 内核注册表工具两路）。
 * 「自定义」档的规则表与工具审批都在权限分区（PermissionTierSection）；
 * composer 的权限按钮只换档，自定义档选中即按已保存的自定义规则走。
 */

type PermissionTier = "default" | "auto-approve" | "full-access" | "custom";

interface TierView {
  tier: PermissionTier;
}

const TIERS: ReadonlyArray<{
  value: PermissionTier;
  label: string;
  hint: string;
}> = [
  { value: "default", label: "默认", hint: "改文件 / 跑命令前先问我" },
  { value: "auto-approve", label: "自动审批", hint: "已批准的调用自动通过" },
  { value: "full-access", label: "完全访问", hint: "不限制" },
  { value: "custom", label: "自定义", hint: "按下面的规则表判定" },
];

function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "保存失败";
}

/** 读取当前默认档；端点不可用时返回 null（调用方隐藏控件）。 */
export function usePermissionTier() {
  const [tier, setTier] = useState<PermissionTier | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<TierView>("/api/permissions/tier")
      .then((view) => {
        if (!cancelled) setTier(view.tier);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (next: PermissionTier) => {
      const previous = tier;
      setTier(next);
      try {
        await surfaceJson<TierView>("/api/permissions/tier", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tier: next }),
        });
        return true;
      } catch (error) {
        if (previous) setTier(previous);
        toast(readableError(error));
        return false;
      }
    },
    [tier],
  );

  return { tier, save };
}

/**
 * composer 的权限档 chip：只列三档，名称与说明对齐产品口径。
 *
 * `custom`（自定义规则表）不在此出现——它只在设置页的权限分区里编辑，
 * 聊天框摆一个出来会多一个档位却无从配置。
 */
const CHIP_TIERS: ReadonlyArray<{
  value: PermissionTier;
  label: string;
  hint: string;
}> = [
  { value: "default", label: "变更前确认", hint: "人工或审批模型" },
  { value: "auto-approve", label: "自动编辑", hint: "自动修改文件" },
  { value: "full-access", label: "完全访问", hint: "访问本机文件与网络" },
];

export function PermissionTierChip() {
  const { tier, save } = usePermissionTier();
  const [busy, setBusy] = useState(false);

  if (!tier) return null;
  // custom 档不在三档里：菜单仍显示它最接近的语义，避免按钮空白。
  const current =
    CHIP_TIERS.find((entry) => entry.value === tier) ?? CHIP_TIERS[0]!;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-lg px-2 text-ui-base"
          disabled={busy}
          aria-label="权限"
          data-testid="permission-tier-chip"
        >
          <span>{current.label}</span>
          <ChevronDownIcon className="size-3.5 text-foreground-subtle" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" sideOffset={4} className="w-64">
        <DropdownMenuRadioGroup
          value={tier}
          onValueChange={(next) => {
            setBusy(true);
            void save(next as PermissionTier).finally(() => setBusy(false));
          }}
        >
          {CHIP_TIERS.map((entry) => (
            <DropdownMenuRadioItem
              key={entry.value}
              value={entry.value}
              className="min-h-13 items-start gap-3 py-2"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{entry.label}</span>
                <span className="text-ui-sm text-foreground-subtle">
                  {entry.hint}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 设置页「权限」分区（T7）：四档横排 + 自定义规则 + 工具审批。 */
export function PermissionTierSection() {
  const { tier, save } = usePermissionTier();
  const [automationTier, setAutomationTier] = useState<PermissionTier | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{ automationTier: PermissionTier }>("/api/permissions/tier")
      .then((view) => {
        if (!cancelled) setAutomationTier(view.automationTier);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const saveAutomation = async (next: PermissionTier) => {
    if (!automationTier) return;
    const previous = automationTier;
    setAutomationTier(next);
    try {
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ automationTier: next }),
      });
    } catch (error) {
      setAutomationTier(previous);
      toast(readableError(error));
    }
  };

  return (
    <div className="space-y-6">
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>常规任务</SettingsSubheading>
        <SettingsGroupCard>
          <SettingsRow
            label="默认档"
            description="改文件 / 跑命令前先问我"
            control={
              <TierPicker
                label="常规任务档位"
                name="permission-tier"
                current={tier ?? "default"}
                saving={busy || tier === null}
                onPick={(next) => {
                  setBusy(true);
                  void save(next).finally(() => setBusy(false));
                }}
              />
            }
          />
        </SettingsGroupCard>
      </section>
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>自动化任务</SettingsSubheading>
        <SettingsGroupCard>
          <SettingsRow
            label="自动化任务档"
            description="无人值守轮次使用的档位"
            control={
              <TierPicker
                label="自动化任务档位"
                name="automation-permission-tier"
                current={automationTier ?? "default"}
                saving={automationTier === null}
                onPick={(next) => void saveAutomation(next)}
              />
            }
          />
        </SettingsGroupCard>
      </section>
      <CustomRulesSection active={tier === "custom"} />
      <ModelDefaultsSection approvalOnly />
      <ToolApprovalSection />
    </div>
  );
}

/** 四档横排（用户口径「能左右就别上下」），选中档的含义在下面给一行小字。 */
/** 权限档选择：与设置页其他分区同一形状（SettingsRow + 右控件），不再自造卡片。 */
function TierPicker({
  label,
  name,
  current,
  saving,
  onPick,
}: {
  label: string;
  name: string;
  current: PermissionTier;
  saving: boolean;
  onPick: (value: PermissionTier) => void;
}) {
  return (
    <fieldset aria-label={label} className="min-w-0">
      <TierRadioRow
        name={name}
        current={current}
        saving={saving}
        onPick={onPick}
      />
    </fieldset>
  );
}

function TierRadioRow({
  name,
  current,
  saving,
  onPick,
}: {
  name: string;
  current: PermissionTier;
  saving: boolean;
  onPick: (value: PermissionTier) => void;
}) {
  const selected = TIERS.find((entry) => entry.value === current);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {TIERS.map((entry) => (
        <label
          key={entry.value}
          className={cn(
            "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-ui-base transition-colors hover:bg-surface-hover",
            current === entry.value &&
              "border-foreground/30 bg-surface text-foreground",
          )}
        >
          <input
            type="radio"
            name={name}
            value={entry.value}
            checked={current === entry.value}
            onChange={() => onPick(entry.value)}
            disabled={saving}
            className="size-3.5 shrink-0 accent-foreground"
          />
          {entry.label}
        </label>
      ))}
      {selected ? (
        <span className="text-ui-sm text-foreground-subtle">
          {selected.hint}
        </span>
      ) : null}
    </div>
  );
}

function rulesToLines(rules: readonly string[]): string {
  return rules.join("\n");
}

function linesToRules(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 自定义档的规则表：一行一条、`*` 通配、拒绝优先（与 service 的判定顺序同源）。 */
function CustomRulesSection({ active }: { active: boolean }) {
  const [denyText, setDenyText] = useState("");
  const [allowText, setAllowText] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{ rules: { allow: string[]; deny: string[] } }>(
      "/api/permissions/tier",
    )
      .then((view) => {
        if (cancelled) return;
        setDenyText(rulesToLines(view.rules.deny));
        setAllowText(rulesToLines(view.rules.allow));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const saveRules = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rules: {
            deny: linesToRules(denyText),
            allow: linesToRules(allowText),
          },
        }),
      });
      setMessage("规则已保存");
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="min-w-0 space-y-3">
      <SettingsSubheading>自定义规则</SettingsSubheading>
      <SettingsGroupCard>
        <div className="space-y-3 p-3">
          {active ? null : (
            <p className="text-ui-sm text-foreground-subtle">
              切到自定义档后按这条规则表判定
            </p>
          )}
          <div className="block text-ui-base">
            <span>拒绝这些工具</span>
            <Textarea
              aria-label="拒绝规则"
              value={denyText}
              onChange={(event) => setDenyText(event.target.value)}
              rows={3}
              placeholder={"mcp__dangerous__delete\nshell_*"}
              className="mt-1 font-mono text-ui-sm"
            />
          </div>
          <div className="block text-ui-base">
            <span>放行这些工具</span>
            <Textarea
              aria-label="放行规则"
              value={allowText}
              onChange={(event) => setAllowText(event.target.value)}
              rows={3}
              placeholder={"write_file\nmcp__py-helper__echo"}
              className="mt-1 font-mono text-ui-sm"
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => void saveRules()}
            >
              保存规则
            </Button>
            <span className="text-ui-sm text-foreground-subtle">
              一行一条 · * 通配 · 拒绝优先
            </span>
            {message ? (
              <span role="status" className="text-ui-sm text-foreground-subtle">
                {message}
              </span>
            ) : null}
          </div>
        </div>
      </SettingsGroupCard>
    </section>
  );
}

const APPROVAL_SCOPES = [
  { value: "once", label: "仅本次" },
  { value: "thread", label: "本会话" },
  { value: "forever", label: "永久" },
] as const;

/** 人工放行某个工具（agent 没有自我授权路径，只能由这里批准）。 */
function ToolApprovalSection() {
  const [toolName, setToolName] = useState("");
  const [scope, setScope] =
    useState<(typeof APPROVAL_SCOPES)[number]["value"]>("once");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [approvedForever, setApprovedForever] = useState<string[]>([]);

  const loadApproved = useCallback(async () => {
    try {
      const view = await surfaceJson<{ approvedForever?: string[] }>(
        "/api/permissions/tier",
      );
      setApprovedForever(view.approvedForever ?? []);
    } catch {
      // 列表读不到不影响批准动作本身。
    }
  }, []);

  useEffect(() => {
    void loadApproved();
  }, [loadApproved]);

  const approve = async () => {
    const trimmed = toolName.trim();
    if (!trimmed) {
      setMessage("请填写工具名");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await surfaceJson("/api/permissions/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolName: trimmed, scope }),
      });
      setMessage(
        `已批准 ${trimmed}（${
          APPROVAL_SCOPES.find((entry) => entry.value === scope)?.label ?? scope
        }）`,
      );
      setToolName("");
      void loadApproved();
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="min-w-0 space-y-3">
      <SettingsSubheading>工具审批</SettingsSubheading>
      <SettingsGroupCard>
        <div className="space-y-3 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="工具名"
              placeholder="如 mcp__fs__write"
              value={toolName}
              onChange={(event) => setToolName(event.target.value)}
              className="min-w-0 flex-1"
            />
            <Select
              value={scope}
              onValueChange={(next) =>
                setScope(next as (typeof APPROVAL_SCOPES)[number]["value"])
              }
            >
              <SelectTrigger aria-label="批准范围" className="w-28 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APPROVAL_SCOPES.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => void approve()}
            >
              批准
            </Button>
          </div>
          {approvedForever.length > 0 ? (
            <p className="text-ui-sm text-foreground-subtle">
              已永久批准：{approvedForever.join("、")}
            </p>
          ) : null}
          {message ? (
            <p role="status" className="text-ui-sm text-foreground-subtle">
              {message}
            </p>
          ) : null}
        </div>
      </SettingsGroupCard>
    </section>
  );
}
