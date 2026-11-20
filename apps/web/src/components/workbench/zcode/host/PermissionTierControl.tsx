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
import { toast } from "@zui/components/ui/toast.js";
import {
  SettingsGroupCard,
  SettingsRow,
  SettingsSubheading,
} from "@zui/settings/SettingsPageParts.js";
import { ChevronDownIcon, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ModelDefaultsSection } from "./ModelDefaultsSection.js";
import { surfaceJson } from "./surfaceApi.js";

/** 一条三态规则的界面形状（与服务端 `permissionPolicySchema` 对齐）。 */
type PolicyRule = { pattern: string; action: "allow" | "ask" | "deny" };

/** 规则表在界面上的统一行形状：三种规则只是「值」的含义不同。 */
type EditableRule = { value: string; action: PolicyRule["action"] };

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
  const fallback = CHIP_TIERS[0];
  const current = CHIP_TIERS.find((entry) => entry.value === tier) ?? fallback;
  if (!current) return null;

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

/** 设置页「权限」分区：档位、规则与审批三块，控件与全站一致。 */
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
        <SettingsSubheading>权限模式</SettingsSubheading>
        <SettingsGroupCard>
          <SettingsRow
            label="常规任务"
            description="改文件 / 跑命令前先问我"
            control={
              <PermissionTierSelect
                ariaLabel="常规任务档位"
                value={tier}
                busy={busy || tier === null}
                onChange={(next) => {
                  setBusy(true);
                  void save(next).finally(() => setBusy(false));
                }}
              />
            }
          />
          <SettingsRow
            label="自动化任务"
            description="无人值守轮次使用的档位"
            control={
              <PermissionTierSelect
                ariaLabel="自动化任务档位"
                value={automationTier}
                busy={automationTier === null}
                onChange={(next) => void saveAutomation(next)}
              />
            }
          />
        </SettingsGroupCard>
      </section>
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>规则与放行</SettingsSubheading>
        <PermissionPolicySection />
        <ToolApprovalSection />
      </section>
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>审批模型</SettingsSubheading>
        <ModelDefaultsSection approvalOnly showHeading={false} />
      </section>
    </div>
  );
}

/** 设置页的档位选择：与全站 Select 一致的单一控件，不再并排四个胶囊。 */
function PermissionTierSelect({
  ariaLabel,
  value,
  busy,
  onChange,
}: {
  ariaLabel: string;
  value: PermissionTier | null;
  busy: boolean;
  onChange: (next: PermissionTier) => void;
}) {
  return (
    <Select
      value={value ?? ""}
      onValueChange={(next) => onChange(next as PermissionTier)}
      disabled={busy}
    >
      <SelectTrigger size="lg" aria-label={ariaLabel} className="w-56">
        <SelectValue placeholder="读取中" />
      </SelectTrigger>
      <SelectContent>
        {TIERS.map((entry) => (
          <SelectItem key={entry.value} value={entry.value}>
            {entry.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 规则动作的三个选项（工具、路径、命令三张表共用一套措辞）。 */
const RULE_ACTIONS: ReadonlyArray<{
  value: PolicyRule["action"];
  label: string;
}> = [
  { value: "allow", label: "允许" },
  { value: "ask", label: "询问" },
  { value: "deny", label: "拒绝" },
];

/**
 * 一张三态规则表：每行「匹配值 + 动作 + 删除」，底部添加按钮。
 *
 * 三张表（工具 / 路径 / 命令）形状一致，只差占位提示与说明；
 * 抽成一个组件是为了让「按顺序匹配 首个命中生效」这句话只有一份。
 */
function RuleTable({
  rows,
  onChange,
  addLabel,
  placeholder,
  ariaLabel,
  emptyLabel,
  disabled,
}: {
  rows: EditableRule[];
  onChange: (next: EditableRule[]) => void;
  addLabel: string;
  placeholder: string;
  ariaLabel: string;
  emptyLabel: string;
  disabled: boolean;
}) {
  const update = (index: number, patch: Partial<EditableRule>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtle">{emptyLabel}</p>
      ) : (
        rows.map((row, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 规则表允许重复值，索引是唯一稳定键。
            key={index}
            className="flex flex-wrap items-center gap-2"
          >
            <Input
              aria-label={ariaLabel}
              placeholder={placeholder}
              value={row.value}
              onChange={(event) => update(index, { value: event.target.value })}
              className="min-w-0 flex-1 font-mono text-ui-sm"
            />
            <Select
              value={row.action}
              onValueChange={(next) =>
                update(index, { action: next as PolicyRule["action"] })
              }
            >
              <SelectTrigger
                size="lg"
                aria-label="动作"
                className="w-28 shrink-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_ACTIONS.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="删除这条规则"
              disabled={disabled}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...rows, { value: "", action: "ask" }])}
      >
        {addLabel}
      </Button>
    </div>
  );
}

/**
 * 工具策略：工具规则、路径规则、命令规则与禁用清单。
 *
 * 四块合成一次保存——它们同属一个策略对象，分四次提交会让「先存了规则、后存失败」
 * 留下半套配置。空白匹配值在提交前剔除：空规则会命中一切，绝不能静默存下去。
 */
function PermissionPolicySection() {
  const [toolRules, setToolRules] = useState<EditableRule[]>([]);
  const [pathRules, setPathRules] = useState<EditableRule[]>([]);
  const [commandRules, setCommandRules] = useState<EditableRule[]>([]);
  const [disabledTools, setDisabledTools] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{
      policy?: {
        rules?: Array<{ pattern: string; action: PolicyRule["action"] }>;
        disabledTools?: string[];
        pathRules?: Array<{ path: string; action: PolicyRule["action"] }>;
        commandRules?: Array<{ prefix: string; action: PolicyRule["action"] }>;
      };
    }>("/api/permissions/tier")
      .then((view) => {
        if (cancelled) return;
        setToolRules(
          (view.policy?.rules ?? []).map((rule) => ({
            value: rule.pattern,
            action: rule.action,
          })),
        );
        setDisabledTools(view.policy?.disabledTools ?? []);
        setPathRules(
          (view.policy?.pathRules ?? []).map((rule) => ({
            value: rule.path,
            action: rule.action,
          })),
        );
        setCommandRules(
          (view.policy?.commandRules ?? []).map((rule) => ({
            value: rule.prefix,
            action: rule.action,
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const savePolicy = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const trimmed = (rows: EditableRule[]) =>
        rows
          .map((row) => ({ value: row.value.trim(), action: row.action }))
          .filter((row) => row.value.length > 0);
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: {
            rules: trimmed(toolRules).map((row) => ({
              pattern: row.value,
              action: row.action,
            })),
            disabledTools: disabledTools
              .map((pattern) => pattern.trim())
              .filter((pattern) => pattern.length > 0),
            pathRules: trimmed(pathRules).map((row) => ({
              path: row.value,
              action: row.action,
            })),
            commandRules: trimmed(commandRules).map((row) => ({
              prefix: row.value,
              action: row.action,
            })),
          },
        }),
      });
      setMessage("已保存");
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroupCard>
      <div className="space-y-4 p-4">
        <div className="space-y-2">
          <div className="text-ui-base font-medium text-foreground">
            工具规则
          </div>
          <RuleTable
            rows={toolRules}
            onChange={setToolRules}
            addLabel="添加工具规则"
            placeholder="mcp__fs__*"
            ariaLabel="工具名或前缀"
            emptyLabel="没有工具规则"
            disabled={saving}
          />
        </div>
        <div className="space-y-2 border-t border-border pt-4">
          <div className="text-ui-base font-medium text-foreground">
            路径规则
          </div>
          <RuleTable
            rows={pathRules}
            onChange={setPathRules}
            addLabel="添加路径规则"
            placeholder="D:\\项目\\敏感目录"
            ariaLabel="路径前缀"
            emptyLabel="没有路径规则"
            disabled={saving}
          />
        </div>
        <div className="space-y-2 border-t border-border pt-4">
          <div className="text-ui-base font-medium text-foreground">
            命令规则
          </div>
          <RuleTable
            rows={commandRules}
            onChange={setCommandRules}
            addLabel="添加命令规则"
            placeholder="rm -rf"
            ariaLabel="命令前缀"
            emptyLabel="没有命令规则"
            disabled={saving}
          />
        </div>
        <div className="space-y-2 border-t border-border pt-4">
          <div className="text-ui-base font-medium text-foreground">
            禁用工具
          </div>
          {disabledTools.length === 0 ? (
            <p className="text-ui-sm text-foreground-subtle">没有禁用的工具</p>
          ) : (
            <div className="space-y-2">
              {disabledTools.map((pattern, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: 禁用清单允许重复，索引是唯一稳定键。
                  key={index}
                  className="flex items-center gap-2"
                >
                  <Input
                    aria-label="禁用工具名或前缀"
                    value={pattern}
                    onChange={(event) =>
                      setDisabledTools((current) =>
                        current.map((item, i) =>
                          i === index ? event.target.value : item,
                        ),
                      )
                    }
                    className="min-w-0 flex-1 font-mono text-ui-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="移出禁用清单"
                    disabled={saving}
                    onClick={() =>
                      setDisabledTools((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => setDisabledTools((current) => [...current, ""])}
          >
            添加禁用项
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => void savePolicy()}
          >
            保存
          </Button>
          <span className="text-ui-sm text-foreground-subtle">
            按顺序匹配 首个命中生效
          </span>
          {message ? (
            <span role="status" className="text-ui-sm text-foreground-subtle">
              {message}
            </span>
          ) : null}
        </div>
      </div>
    </SettingsGroupCard>
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
