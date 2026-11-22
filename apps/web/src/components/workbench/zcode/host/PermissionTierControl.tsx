import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zui/components/ui/dialog.js";
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
import { ChevronRightIcon, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

/** 一条三态规则的界面形状（与服务端 `permissionPolicySchema` 对齐）。 */
type PolicyRule = { pattern: string; action: "allow" | "ask" | "deny" };

/** 规则表在界面上的统一行形状：三种规则只是「值」的含义不同。 */
type EditableRule = {
  value: string;
  action: PolicyRule["action"];
  /** 只有路径规则用：这次规则管的是读 / 写 / 删（缺省按读）。 */
  operation?: "read" | "write" | "delete";
};

/** 路径规则的三个操作档（与 `permissionFileOperationSchema` 一一对应）。 */
const FILE_OPERATIONS: ReadonlyArray<{
  value: NonNullable<EditableRule["operation"]>;
  label: string;
}> = [
  { value: "read", label: "读" },
  { value: "write", label: "写" },
  { value: "delete", label: "删" },
];

/** 网络整体策略（与 `permissionNetworkModeSchema` 一一对应）。 */
type NetworkMode = "allow-all" | "auto" | "ask" | "whitelist" | "blacklist";

const NETWORK_MODES: ReadonlyArray<{
  value: NetworkMode;
  label: string;
}> = [
  { value: "allow-all", label: "全部放行" },
  { value: "auto", label: "自动审批" },
  { value: "ask", label: "默认询问" },
  { value: "whitelist", label: "白名单" },
  { value: "blacklist", label: "黑名单" },
];

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

export type { PermissionTier };

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
 * composer 会话设置的权限三档（与设置页同一套措辞）。
 *
 * `custom`（自定义规则表）不在此出现——它只在设置页的权限分区里编辑，
 * 聊天框摆一个出来会多一个档位却无从配置。
 */
export const PERMISSION_MENU_TIERS: ReadonlyArray<{
  value: PermissionTier;
  label: string;
  hint: string;
}> = [
  { value: "default", label: "变更前确认", hint: "人工或审批模型" },
  { value: "auto-approve", label: "自动编辑", hint: "自动修改文件" },
  { value: "full-access", label: "完全访问", hint: "访问本机文件与网络" },
];

/**
 * 设置页「权限」分区：基础配置 + 规则与放行两组。
 *
 * 用户口径（2026-11-22）：这一页只保留这两组，其余分组（自动化任务档、手动放行、
 * AI 安全防护、敏感保护、审批模型、审计中心）从本页移除。它们的能力没有删除——
 * 服务端字段与执行链路照旧，只是不再在这个页面配置。
 */
export function PermissionTierSection() {
  const { tier, save } = usePermissionTier();
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-6">
      {/* 基础配置：整组一张卡片（用户口径 2026-11-22：同组的配置连在一起）。
          行顺序按用户清单：权限模式、沙箱、删除、命令审查、备份。 */}
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>基础配置</SettingsSubheading>
        <SettingsGroupCard>
          <SettingsRow
            label="默认权限模式"
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
          <SandboxSecuritySection />
          <DeleteModeSection />
          <CommandReviewSection />
          <AutoBackupSection />
        </SettingsGroupCard>
      </section>
      {/* 规则与放行：整组一张卡片。没命中任何规则时按上面选定的权限模式办。 */}
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>规则与放行</SettingsSubheading>
        <PermissionPolicySection />
      </section>
    </div>
  );
}

/**
 * 开 / 关做成下拉（用户口径 2026-11-22：所有勾选框都换成下拉框）。
 *
 * 视觉与同页其它配置一致：标签在左、下拉在右；开关语义只有两个值，
 * 不给「未设置」这类第三态——服务端字段都是布尔。
 */
function ToggleSelect({
  ariaLabel,
  value,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  value: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Select
      value={value ? "on" : "off"}
      onValueChange={(next) => onChange(next === "on")}
      disabled={disabled}
    >
      <SelectTrigger size="lg" aria-label={ariaLabel} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="on">打开</SelectItem>
        <SelectItem value="off">关闭</SelectItem>
      </SelectContent>
    </Select>
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

/**
 * 一条规则的动作（四类规则共用一套措辞）。
 *
 * 用「放行 / 每次询问 / 拦截」而不是「允许 / 询问 / 拒绝」：这三个词直接说出这次调用会
 * 发生什么——放过去、每次都要你点同意、直接挡住不许执行。「询问」本身不说明要不要记住，
 * 用户看不出它和「允许」的区别。
 */
const RULE_ACTIONS: ReadonlyArray<{
  value: PolicyRule["action"];
  label: string;
}> = [
  { value: "allow", label: "放行" },
  { value: "ask", label: "每次询问" },
  { value: "deny", label: "拦截" },
];

/**
 * 一组三态规则：标题与「添加」按钮同行，下面列出各条规则。
 *
 * 四组（工具 / 文件路径 / 命令 / 域名）形状一致，只差标题、占位提示与是否显示「操作」列。
 * 标题直接用**匹配对象**命名（「文件路径规则」而不是「路径规则」）：用户看标题就知道
 * 这一组拦的是什么东西，不需要另一行解释。空组不写「没有…规则」——四组各一句同样的
 * 空态会变成一堵看不出区别的墙，标题加右侧的添加按钮已经把「这里是空的」说清楚了。
 */
function RuleGroup({
  title,
  rows,
  onChange,
  addLabel,
  placeholder,
  ariaLabel,
  disabled,
  showOperation = false,
}: {
  title: string;
  rows: EditableRule[];
  onChange: (next: EditableRule[]) => void;
  addLabel: string;
  placeholder: string;
  ariaLabel: string;
  disabled: boolean;
  /** 文件路径规则额外显示「操作」列（读 / 写 / 删分别配）。 */
  showOperation?: boolean;
}) {
  const update = (index: number, patch: Partial<EditableRule>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="shrink-0 text-ui-base font-medium text-foreground">
          {title}
        </span>
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
      {rows.length === 0 ? null : (
        <div className="space-y-2">
          {rows.map((row, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 规则表允许重复值，索引是唯一稳定键。
              key={index}
              className="flex flex-wrap items-center gap-2"
            >
              <Input
                aria-label={ariaLabel}
                placeholder={placeholder}
                value={row.value}
                onChange={(event) =>
                  update(index, { value: event.target.value })
                }
                className="min-w-0 flex-1 font-mono text-ui-sm"
              />
              {showOperation ? (
                <Select
                  value={row.operation ?? "read"}
                  onValueChange={(next) =>
                    update(index, {
                      operation: next as NonNullable<EditableRule["operation"]>,
                    })
                  }
                >
                  <SelectTrigger
                    size="lg"
                    aria-label="操作"
                    className="w-24 shrink-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILE_OPERATIONS.map((entry) => (
                      <SelectItem key={entry.value} value={entry.value}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
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
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 自动备份：每轮对话修改文件前先留一份影子快照（检查点）。
 *
 * 本仓库的对应实现是检查点：每个轮次边界在私有目录做一次 git 快照，可在时间线上
 * 回看与恢复。开关只控制**轮次前**那道；关掉后不再产生新的 pre 快照，已有快照仍可用。
 * 「保留上限」控制每个工作区最多留多少轮次快照，超出按时间删最旧（0 = 不设上限）。
 */
function AutoBackupSection() {
  const [enabled, setEnabled] = useState(true);
  const [maxSnapshots, setMaxSnapshots] = useState(50);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{
      policy?: { autoBackup?: { enabled?: boolean; maxSnapshots?: number } };
    }>("/api/permissions/tier")
      .then((view) => {
        if (cancelled) return;
        setEnabled(view.policy?.autoBackup?.enabled !== false);
        setMaxSnapshots(view.policy?.autoBackup?.maxSnapshots ?? 50);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** 读回整份策略再合并，只替换 autoBackup 一项（开关与上限同属它）。 */
  const save = async (next: { enabled: boolean; maxSnapshots: number }) => {
    setSaving(true);
    setMessage(null);
    const previous = { enabled, maxSnapshots };
    setEnabled(next.enabled);
    setMaxSnapshots(next.maxSnapshots);
    try {
      const view = await surfaceJson<{ policy?: Record<string, unknown> }>(
        "/api/permissions/tier",
      );
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: {
            ...(view.policy ?? {}),
            autoBackup: {
              enabled: next.enabled,
              maxSnapshots: Math.max(0, Math.round(next.maxSnapshots)),
            },
          },
        }),
      });
      setMessage("已保存");
    } catch (error) {
      setEnabled(previous.enabled);
      setMaxSnapshots(previous.maxSnapshots);
      setMessage(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsRow
        label="自动备份"
        control={
          <ToggleSelect
            ariaLabel="自动备份"
            value={enabled}
            disabled={saving}
            onChange={(next) => void save({ enabled: next, maxSnapshots })}
          />
        }
      />
      <SettingsRow
        label="备份保留上限"
        control={
          <Input
            aria-label="备份保留上限"
            type="number"
            min={0}
            max={10000}
            disabled={!enabled || saving}
            value={maxSnapshots}
            onChange={(event) =>
              setMaxSnapshots(Math.max(0, Number(event.target.value) || 0))
            }
            onBlur={() => void save({ enabled, maxSnapshots })}
            className="w-24"
          />
        }
      />
      {message ? (
        <div className="px-4 pb-3">
          <span role="status" className="text-ui-sm text-foreground-subtle">
            {message}
          </span>
        </div>
      ) : null}
    </>
  );
}

/** 删除模式的四个档（与 `permissionPolicySchema.deleteMode` 一一对应）。 */
const DELETE_MODES: ReadonlyArray<{
  value: "ask" | "auto-approve" | "trash" | "permanent";
  label: string;
  hint: string;
}> = [
  { value: "ask", label: "删除前询问", hint: "每次删除都问我" },
  { value: "auto-approve", label: "自动审批", hint: "符合规则就自动批准" },
  { value: "trash", label: "先移到回收站", hint: "删前移到回收站可找回" },
  { value: "permanent", label: "完全删除", hint: "不进回收站直接删" },
];

/**
 * 删除模式四档（用户口径：删除需要询问、自动审批、删除到回收站、完全删除）。
 *
 * 批量删除审批阈值不在用户清单里，从本页移除；服务端字段保留，保存时原样带回。
 */
function DeleteModeSection() {
  const [mode, setMode] = useState<
    "ask" | "auto-approve" | "trash" | "permanent"
  >("ask");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{
      policy?: {
        deleteMode?: "ask" | "auto-approve" | "trash" | "permanent";
      };
    }>("/api/permissions/tier")
      .then((view) => {
        if (cancelled) return;
        setMode(view.policy?.deleteMode ?? "ask");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (next: typeof mode) => {
    setSaving(true);
    setMessage(null);
    const previous = mode;
    setMode(next);
    try {
      const view = await surfaceJson<{ policy?: Record<string, unknown> }>(
        "/api/permissions/tier",
      );
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: { ...(view.policy ?? {}), deleteMode: next },
        }),
      });
      setMessage("已保存");
    } catch (error) {
      setMode(previous);
      setMessage(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsRow
        label="删除模式"
        control={
          <Select
            value={mode}
            onValueChange={(next) => void save(next as typeof mode)}
            disabled={saving}
          >
            <SelectTrigger size="lg" aria-label="删除模式" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DELETE_MODES.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {message ? (
        <div className="px-4 pb-3">
          <span role="status" className="text-ui-sm text-foreground-subtle">
            {message}
          </span>
        </div>
      ) : null}
    </>
  );
}

/** 命令执行前审查的三档（与 `permissionPolicySchema.commandReview` 对应）。 */
const COMMAND_REVIEW_MODES: ReadonlyArray<{
  value: "auto" | "strict" | "off";
  label: string;
  hint: string;
}> = [
  { value: "auto", label: "自动", hint: "只审查高危命令" },
  { value: "strict", label: "严格", hint: "每条命令都审查" },
  { value: "off", label: "关闭", hint: "不审查" },
];

/**
 * 命令执行前审查：命令跑起来之前先用审批模型过一遍。
 *
 * - 自动：只对命中**高危字典**的命令审查（字典可改），普通命令不额外花模型调用；
 * - 严格：每条命令都审，含只读命令；
 * - 关闭：只走权限模式与规则表。
 */
function CommandReviewSection() {
  const [mode, setMode] = useState<"auto" | "strict" | "off">("auto");
  const [patterns, setPatterns] = useState<string[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{
      policy?: {
        commandReview?: "auto" | "strict" | "off";
        commandReviewPatterns?: string[];
      };
    }>("/api/permissions/tier")
      .then((view) => {
        if (cancelled) return;
        setMode(view.policy?.commandReview ?? "auto");
        setPatterns(view.policy?.commandReviewPatterns ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (next: { mode: typeof mode; patterns: string[] }) => {
    setSaving(true);
    setMessage(null);
    const previous = { mode, patterns };
    setMode(next.mode);
    setPatterns(next.patterns);
    try {
      const view = await surfaceJson<{ policy?: Record<string, unknown> }>(
        "/api/permissions/tier",
      );
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: {
            ...(view.policy ?? {}),
            commandReview: next.mode,
            // 空前缀会命中一切，提交前剔除。
            commandReviewPatterns: next.patterns
              .map((pattern) => pattern.trim())
              .filter((pattern) => pattern.length > 0),
          },
        }),
      });
      setMessage("已保存");
    } catch (error) {
      setMode(previous.mode);
      setPatterns(previous.patterns);
      setMessage(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsRow
        label="命令执行前审查"
        control={
          <Select
            value={mode}
            onValueChange={(next) =>
              void save({ mode: next as typeof mode, patterns })
            }
            disabled={saving}
          >
            <SelectTrigger
              size="lg"
              aria-label="命令执行前审查"
              className="w-56"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMMAND_REVIEW_MODES.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {/* 高危命令字典条目多，逐条铺在页面上会把下面几组顶到第二屏：
          这里只放一行入口，点箭头进弹窗编辑（用户口径 2026-11-22）。
          严格档不看字典，此时不展示入口，免得以为它也生效。 */}
      {mode === "strict" ? null : (
        <SettingsRow
          label="高危命令"
          control={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="编辑高危命令"
              disabled={mode === "off" || saving}
              onClick={() => setEditorOpen(true)}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          }
        />
      )}
      {message ? (
        <div className="px-4 pb-3">
          <span role="status" className="text-ui-sm text-foreground-subtle">
            {message}
          </span>
        </div>
      ) : null}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>高危命令</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {patterns.length === 0 ? (
              <p className="text-ui-sm text-foreground-subtle">还没有条目</p>
            ) : null}
            {patterns.map((pattern, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: 前缀可重复，索引是唯一稳定键。
                key={index}
                className="flex items-center gap-2"
              >
                <Input
                  aria-label="高危命令前缀"
                  value={pattern}
                  onChange={(event) =>
                    setPatterns((current) =>
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
                  aria-label="删除这条高危命令"
                  onClick={() =>
                    setPatterns((current) =>
                      current.filter((_, i) => i !== index),
                    )
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPatterns((current) => [...current, ""])}
            >
              添加
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saving}
              onClick={() => {
                void save({ mode, patterns }).then(() => setEditorOpen(false));
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * 沙箱隔离开关（用户口径 2026-11-22：基础配置第 2 项「打开或者关闭」）。
 *
 * 文件访问 / 网络访问 / 内置运行时三行不在用户清单里，从本页移除；能力与
 * 服务端字段保留，只是不再在这个页面配置。
 */
function SandboxSecuritySection() {
  const [sandboxEnabled, setSandboxEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{
      policy?: {
        sandbox?: { enabled?: boolean };
      };
    }>("/api/permissions/tier")
      .then((view) => {
        if (cancelled) return;
        setSandboxEnabled(view.policy?.sandbox?.enabled !== false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** 沙箱隔离开关：读回策略再合并提交，只替换 sandbox 一项。 */
  const saveSandbox = async (enabled: boolean) => {
    setSaving(true);
    setMessage(null);
    const previous = sandboxEnabled;
    setSandboxEnabled(enabled);
    try {
      const view = await surfaceJson<{ policy?: Record<string, unknown> }>(
        "/api/permissions/tier",
      );
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: { ...(view.policy ?? {}), sandbox: { enabled } },
        }),
      });
      setMessage("已保存");
    } catch (error) {
      setSandboxEnabled(previous);
      setMessage(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsRow
        label="沙箱隔离"
        control={
          <ToggleSelect
            ariaLabel="沙箱隔离"
            value={sandboxEnabled}
            disabled={saving}
            onChange={(next) => void saveSandbox(next)}
          />
        }
      />
      {message ? (
        <div className="px-4 pb-3">
          <span role="status" className="text-ui-sm text-foreground-subtle">
            {message}
          </span>
        </div>
      ) : null}
    </>
  );
}

/**
 * 规则与放行：四类三态规则（工具 / 文件 / 命令 / 网络）。
 *
 * 每类规则的匹配对象不同，所以每组都直接写出「按什么匹配」——用户不必猜
 * 「路径规则」和「命令规则」差在哪。四组按**服务的判定顺序**排列（工具 → 路径 →
 * 命令 → 域名），因此卡片顶部那句「从上往下匹配」对用户来说是成立的。
 *
 * 四组合成一次保存——它们同属一个策略对象，分四次提交会让「先存了规则、后存失败」
 * 留下半套配置。提交前读回整份策略再合并：PUT 收的是完整 policy，漏传的字段会被
 * 服务端缺省值冲掉（曾经把沙箱总开关、自动备份与 AI 安全防护一并重置）。
 * 空白匹配值在提交前剔除：空规则会命中一切，绝不能静默存下去。
 *
 * 旧的「禁用工具」清单不再单列：它与「工具规则 + 拒绝」的判定完全一致（都是硬拒绝、
 * 不给审批机会），两处并存只会让用户以为它们是两种不同的东西。读回时把清单里的
 * 匹配式折成排在**最前**的工具拒绝规则——保持原来「禁用先判」的先后关系。
 */
function PermissionPolicySection() {
  const [toolRules, setToolRules] = useState<EditableRule[]>([]);
  const [pathRules, setPathRules] = useState<EditableRule[]>([]);
  const [commandRules, setCommandRules] = useState<EditableRule[]>([]);
  const [domainRules, setDomainRules] = useState<EditableRule[]>([]);
  const [networkPolicy, setNetworkPolicy] = useState<{
    networkMode: NetworkMode;
    httpAllowed: boolean;
    tlsVerification: boolean;
  }>({ networkMode: "auto", httpAllowed: true, tlsVerification: true });
  const [editingRules, setEditingRules] = useState<
    "tool" | "path" | "command" | "domain" | null
  >(null);
  const editingRulesTitle =
    editingRules === "tool"
      ? "工具规则"
      : editingRules === "path"
        ? "文件路径规则"
        : editingRules === "command"
          ? "命令规则"
          : "网络规则";
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{
      policy?: {
        rules?: Array<{ pattern: string; action: PolicyRule["action"] }>;
        disabledTools?: string[];
        pathRules?: Array<{
          path: string;
          operation?: NonNullable<EditableRule["operation"]>;
          action: PolicyRule["action"];
        }>;
        commandRules?: Array<{ prefix: string; action: PolicyRule["action"] }>;
        domainRules?: Array<{ domain: string; action: PolicyRule["action"] }>;
        networkPolicy?: {
          networkMode?: NetworkMode;
          httpAllowed?: boolean;
          tlsVerification?: boolean;
        };
      };
    }>("/api/permissions/tier")
      .then((view) => {
        if (cancelled) return;
        setNetworkPolicy({
          networkMode: view.policy?.networkPolicy?.networkMode ?? "auto",
          httpAllowed: view.policy?.networkPolicy?.httpAllowed !== false,
          tlsVerification:
            view.policy?.networkPolicy?.tlsVerification !== false,
        });
        // 禁用清单折成排在最前的「工具规则 + 拒绝」：两者判定相同（硬拒绝、不了审批），
        // 排在前面保持原本「禁用先判」的先后关系。
        setToolRules([
          ...(view.policy?.disabledTools ?? []).map((pattern) => ({
            value: pattern,
            action: "deny" as const,
          })),
          ...(view.policy?.rules ?? []).map((rule) => ({
            value: rule.pattern,
            action: rule.action,
          })),
        ]);
        setPathRules(
          (view.policy?.pathRules ?? []).map((rule) => ({
            value: rule.path,
            action: rule.action,
            operation: rule.operation ?? "read",
          })),
        );
        setCommandRules(
          (view.policy?.commandRules ?? []).map((rule) => ({
            value: rule.prefix,
            action: rule.action,
          })),
        );
        setDomainRules(
          (view.policy?.domainRules ?? []).map((rule) => ({
            value: rule.domain,
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
          .map((row) => ({
            value: row.value.trim(),
            action: row.action,
            ...(row.operation ? { operation: row.operation } : {}),
          }))
          .filter((row) => row.value.length > 0);
      // 读回整份策略再合并：PUT 收的是完整 policy，只送四张规则表会把沙箱总开关、
      // 自动备份、AI 安全防护一并冲回缺省值。
      const view = await surfaceJson<{ policy?: Record<string, unknown> }>(
        "/api/permissions/tier",
      );
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: {
            ...(view.policy ?? {}),
            rules: trimmed(toolRules).map((row) => ({
              pattern: row.value,
              action: row.action,
            })),
            // 禁用清单已并入工具规则（「拒绝」），这里清空：否则读回时会被再展开一遍。
            disabledTools: [],
            pathRules: trimmed(pathRules).map((row) => ({
              path: row.value,
              operation: row.operation ?? "read",
              action: row.action,
            })),
            commandRules: trimmed(commandRules).map((row) => ({
              prefix: row.value,
              action: row.action,
            })),
            domainRules: trimmed(domainRules).map((row) => ({
              domain: row.value,
              action: row.action,
            })),
            networkPolicy: {
              networkMode: networkPolicy.networkMode,
              httpAllowed: networkPolicy.httpAllowed,
              tlsVerification: networkPolicy.tlsVerification,
            },
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
      <div className="space-y-5 p-4">
        {/* 放行策略：没命中任何规则时怎么办——全部放行 / 自动审批 / 默认询问 /
            白名单 / 黑名单。自动审批与白名单里「没被审批过」的地址仍会先问
            （`auto` 回落档位审批、`whitelist` 名单外硬拦）。 */}
        <SettingsRow
          label="放行策略"
          control={
            <Select
              value={networkPolicy.networkMode}
              disabled={saving}
              onValueChange={(next) =>
                setNetworkPolicy((current) => ({
                  ...current,
                  networkMode: next as NetworkMode,
                }))
              }
            >
              <SelectTrigger size="lg" aria-label="放行策略" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NETWORK_MODES.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        {/* 四组规则都要逐条编辑，全铺在页面上会把这张卡片拉得很长：
            每组只留一行入口（标题 + 已配置条数 + 箭头），点箭头进弹窗编辑。 */}
        <RuleEntryRow
          title="工具规则"
          count={toolRules.length}
          onOpen={() => setEditingRules("tool")}
        />
        <RuleEntryRow
          title="文件路径规则"
          count={pathRules.length}
          onOpen={() => setEditingRules("path")}
        />
        <RuleEntryRow
          title="命令规则"
          count={commandRules.length}
          onOpen={() => setEditingRules("command")}
        />
        <RuleEntryRow
          title="网络规则"
          count={domainRules.length}
          onOpen={() => setEditingRules("domain")}
        />
        {/* HTTP 放行与 SSL 证书校验是单值配置，不随规则表进弹窗。 */}
        <SettingsRow
          label="HTTP 放行"
          control={
            <ToggleSelect
              ariaLabel="HTTP 放行"
              value={networkPolicy.httpAllowed}
              disabled={saving}
              onChange={(next) =>
                setNetworkPolicy((current) => ({
                  ...current,
                  httpAllowed: next,
                }))
              }
            />
          }
        />
        <SettingsRow
          label="SSL 证书校验"
          control={
            <ToggleSelect
              ariaLabel="SSL 证书校验"
              value={networkPolicy.tlsVerification}
              disabled={saving}
              onChange={(next) =>
                setNetworkPolicy((current) => ({
                  ...current,
                  tlsVerification: next,
                }))
              }
            />
          }
        />
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => void savePolicy()}
          >
            保存规则
          </Button>
          {message ? (
            <span role="status" className="text-ui-sm text-foreground-subtle">
              {message}
            </span>
          ) : null}
        </div>
      </div>
      <Dialog
        open={editingRules !== null}
        onOpenChange={(open) => {
          if (!open) setEditingRules(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingRulesTitle}</DialogTitle>
          </DialogHeader>
          {editingRules === "tool" ? (
            <RuleGroup
              title="工具规则"
              rows={toolRules}
              onChange={setToolRules}
              addLabel="添加工具规则"
              placeholder="mcp__fs__*"
              ariaLabel="工具名或前缀"
              disabled={saving}
            />
          ) : null}
          {editingRules === "path" ? (
            <RuleGroup
              title="文件路径规则"
              rows={pathRules}
              onChange={setPathRules}
              addLabel="添加路径规则"
              placeholder="D:\\项目\\敏感目录"
              ariaLabel="路径前缀"
              disabled={saving}
              showOperation
            />
          ) : null}
          {editingRules === "command" ? (
            <RuleGroup
              title="命令规则"
              rows={commandRules}
              onChange={setCommandRules}
              addLabel="添加命令规则"
              placeholder="rm -rf"
              ariaLabel="命令前缀"
              disabled={saving}
            />
          ) : null}
          {editingRules === "domain" ? (
            <RuleGroup
              title="网络规则"
              rows={domainRules}
              onChange={setDomainRules}
              addLabel="添加域名规则"
              placeholder="*.example.com"
              ariaLabel="域名"
              disabled={saving}
            />
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              disabled={saving}
              onClick={() => {
                void savePolicy().then(() => setEditingRules(null));
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroupCard>
  );
}

/** 规则组入口行：标题 + 已配置条数 + 箭头（点进弹窗编辑）。 */
function RuleEntryRow({
  title,
  count,
  onOpen,
}: {
  title: string;
  count: number;
  onOpen: () => void;
}) {
  return (
    <SettingsRow
      label={title}
      control={
        <span className="flex items-center gap-2">
          <span className="text-ui-sm tabular-nums text-foreground-subtle">
            {count}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`编辑${title}`}
            onClick={onOpen}
          >
            <ChevronRightIcon className="size-4" />
          </Button>
        </span>
      }
    />
  );
}
