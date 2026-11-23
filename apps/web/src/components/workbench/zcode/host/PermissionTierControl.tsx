import { cn } from "@zui/components/lib/utils.js";
import { Button } from "@zui/components/ui/button.js";
import {
  Dialog,
  DialogClose,
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
import { Switch } from "@zui/components/ui/switch.js";
import { toast } from "@zui/components/ui/toast.js";
import {
  SettingsGroupCard,
  SettingsRow,
  SettingsSubheading,
} from "@zui/settings/SettingsPageParts.js";
import { ShieldCheck, Trash2, X } from "lucide-react";
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

/** 读取出错时给人看的一句话。 */
function readableError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "保存失败";
}

/**
 * 设置行里控件的宽度（用户口径 2026-11-23「按钮和输入框只要下拉框的一半」）。
 *
 * 下拉框占满整列 192px（要装下「删除前询问」「命令执行前审查」这类长文案）；
 * 按钮与数字输入框只要它的一半 96px，右对齐——按钮本来就短，占满整列显得空。
 *
 * 白底是同一个口径里的「颜色统一」（用户原话：颜色也统一一下，白色）：
 * 下拉框走 `input` 变体本来就是白底（`--color-input` 在浅色主题就是白色），
 * 而 `outline` 按钮默认透明底，两者并排会一透一白。
 */
const CONTROL_FULL_WIDTH = "w-full";
const CONTROL_HALF_WIDTH = "w-24 shrink-0";
const CONTROL_BUTTON_SURFACE = "bg-input";

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
 * 开 / 关用 Switch（用户口径 2026-11-22：与浏览器控制页同一个开关控件）。
 *
 * 上一版做成了「打开 / 关闭」下拉，那不是浏览器控制页的样子；本页所有布尔项
 * 统一用这个开关，视觉与开关行为都和浏览器控制页一致。
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
    <Switch
      aria-label={ariaLabel}
      checked={value}
      disabled={disabled}
      onCheckedChange={onChange}
    />
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
      <SelectTrigger size="lg" aria-label={ariaLabel} className="w-full">
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
            className={CONTROL_HALF_WIDTH}
          />
        }
      />
      {/* 成功不弹行内提示（用户口径 2026-11-23：不要显示「已保存」这类东西）；
          只有失败才要一句话说明怎么处理。 */}
      {message && message !== "已保存" ? (
        <div className="px-4 pb-3">
          <span role="alert" className="text-ui-sm text-destructive">
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
            <SelectTrigger size="lg" aria-label="删除模式" className="w-full">
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
      {/* 成功不弹行内提示（用户口径 2026-11-23：不要显示「已保存」这类东西）；
          只有失败才要一句话说明怎么处理。 */}
      {message && message !== "已保存" ? (
        <div className="px-4 pb-3">
          <span role="alert" className="text-ui-sm text-destructive">
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
              className="w-full"
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
          这里只放一个「编辑」入口，点开进弹窗（用户口径 2026-11-22）。
          严格档不看字典，此时不展示入口，免得以为它也生效。 */}
      {mode === "strict" ? null : (
        <SettingsRow
          label="高危命令"
          control={
            <Button
              type="button"
              variant="outline"
              size="lg"
              aria-label="编辑高危命令"
              disabled={mode === "off" || saving}
              onClick={() => setEditorOpen(true)}
              className={cn(CONTROL_HALF_WIDTH, CONTROL_BUTTON_SURFACE)}
            >
              编辑
            </Button>
          }
        />
      )}
      {/* 成功不弹行内提示（用户口径 2026-11-23），只有失败才显示。 */}
      {message && message !== "已保存" ? (
        <div className="px-4 pb-3">
          <span role="alert" className="text-ui-sm text-destructive">
            {message}
          </span>
        </div>
      ) : null}
      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open);
          // 关闭即保存（用户口径 2026-11-23：不要「完成」按钮）。
          if (!open) void save({ mode, patterns });
        }}
      >
        {/* 固定尺寸（用户口径 2026-11-23：宽 60%、高 80%）+ 内部滚动。 */}
        <DialogContent className="flex h-[80vh] w-[60vw] max-w-none flex-col">
          <DialogHeader>
            <DialogTitle>高危命令</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {/* 添加放在条目列表上方左侧（用户口径：与插件页一致）。 */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPatterns((current) => [...current, ""])}
            >
              添加
            </Button>
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
          {/* 关闭即保存（用户口径 2026-11-23：不需要「完成」按钮，操作完自动保存）。 */}
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
      {/* 成功不弹行内提示（用户口径 2026-11-23：不要显示「已保存」这类东西）；
          只有失败才要一句话说明怎么处理。 */}
      {message && message !== "已保存" ? (
        <div className="px-4 pb-3">
          <span role="alert" className="text-ui-sm text-destructive">
            {message}
          </span>
        </div>
      ) : null}
    </>
  );
}

/** 四类规则：匹配对象不同，界面形状一致（列表 + 弹窗编辑）。 */
type RuleKind = "tool" | "path" | "command" | "domain";

const RULE_GROUPS: ReadonlyArray<{
  kind: RuleKind;
  title: string;
  placeholder: string;
  ariaLabel: string;
  /** 只有路径规则需要「读 / 写 / 删」这一档。 */
  showOperation?: boolean;
}> = [
  {
    kind: "tool",
    title: "工具规则",
    placeholder: "mcp__fs__*",
    ariaLabel: "工具名或前缀",
  },
  {
    kind: "path",
    title: "文件路径规则",
    placeholder: "D:\\项目\\敏感目录",
    ariaLabel: "路径前缀",
    showOperation: true,
  },
  {
    kind: "command",
    title: "命令规则",
    placeholder: "rm -rf",
    ariaLabel: "命令前缀",
  },
  {
    kind: "domain",
    title: "网络规则",
    placeholder: "*.example.com",
    ariaLabel: "域名",
  },
];

/**
 * 规则与放行：四类三态规则（工具 / 文件 / 命令 / 网络）。
 *
 * 版式与浏览器控制页一致：每类规则一个设置行（标签在左、编辑按钮在右），
 * 已配置的规则直接列在行下方——点某一条就在弹窗里编辑那一条，行尾可删除。
 * 匹配对象不同的四类都直接写出「按什么匹配」，用户不必猜路径规则与命令规则差在哪。
 *
 * 四组合成一次保存——它们同属一个策略对象，分四次提交会让「先存了规则、后存失败」
 * 留下半套配置。提交前读回整份策略再合并：PUT 收的是完整 policy，漏传的字段会被
 * 服务端缺省值冲掉（曾经把沙箱总开关、自动备份与 AI 安全防护一并重置）。
 * 空白匹配值在提交前剔除：空规则会命中一切，绝不能静默存下去。
 *
 * 旧的「禁用工具」清单不再单列：它与「工具规则 + 拦截」的判定完全一致（都是硬拒绝、
 * 不给审批机会），两处并存只会让用户以为它们是两种不同的东西。读回时把清单里的
 * 匹配式折成排在**最前**的工具拦截规则——保持原来「禁用先判」的先后关系。
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
  /** 打开的是哪一组规则；`index` 非空表示从列表里点进来的那一条。 */
  const [editor, setEditor] = useState<{
    kind: RuleKind;
    index: number | null;
  } | null>(null);
  /** 弹窗打开时锁定到规则详情：从列表点进来先展示那一条，从「编辑」进来先看列表。 */
  const [editorDetail, setEditorDetail] = useState<number | null>(null);
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

  /**
   * 提交规则与网络策略。
   *
   * `override` 用于「改完立刻生效」的单点操作：这些值在 setState 之后还没进闭包，
   * 直接读 state 会提交旧值。`rows` 适用于删除一条规则时同时替换该组规则表。
   */
  const savePolicy = async (override?: {
    networkMode?: NetworkMode;
    httpAllowed?: boolean;
    tlsVerification?: boolean;
    rows?: Partial<Record<RuleKind, EditableRule[]>>;
  }) => {
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
      const nextTool = override?.rows?.tool ?? toolRules;
      const nextPath = override?.rows?.path ?? pathRules;
      const nextCommand = override?.rows?.command ?? commandRules;
      const nextDomain = override?.rows?.domain ?? domainRules;
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: {
            ...(view.policy ?? {}),
            rules: trimmed(nextTool).map((row) => ({
              pattern: row.value,
              action: row.action,
            })),
            // 禁用清单已并入工具规则（「拦截」），这里清空：否则读回时会被再展开一遍。
            disabledTools: [],
            pathRules: trimmed(nextPath).map((row) => ({
              path: row.value,
              operation: row.operation ?? "read",
              action: row.action,
            })),
            commandRules: trimmed(nextCommand).map((row) => ({
              prefix: row.value,
              action: row.action,
            })),
            domainRules: trimmed(nextDomain).map((row) => ({
              domain: row.value,
              action: row.action,
            })),
            networkPolicy: {
              networkMode: override?.networkMode ?? networkPolicy.networkMode,
              httpAllowed: override?.httpAllowed ?? networkPolicy.httpAllowed,
              tlsVerification:
                override?.tlsVerification ?? networkPolicy.tlsVerification,
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

  /** 四组规则表与各自的 setter：四类共用一个编辑器，按 kind 查表。 */
  const ruleTable: Record<
    RuleKind,
    { rows: EditableRule[]; setRows: (next: EditableRule[]) => void }
  > = {
    tool: { rows: toolRules, setRows: setToolRules },
    path: { rows: pathRules, setRows: setPathRules },
    command: { rows: commandRules, setRows: setCommandRules },
    domain: { rows: domainRules, setRows: setDomainRules },
  };
  const editorGroup = editor
    ? RULE_GROUPS.find((group) => group.kind === editor.kind)
    : undefined;

  /** 打开某一组规则：`index` 有值时直接进入该条详情，否则展示列表。 */
  const openEditor = (kind: RuleKind, index: number | null) => {
    setEditor({ kind, index });
    setEditorDetail(index);
  };

  return (
    <SettingsGroupCard>
      {/* 放行策略：没命中任何规则时怎么办——全部放行 / 自动审批 / 默认询问 /
          白名单 / 黑名单。 */}
      <SettingsRow
        label="放行策略"
        control={
          <Select
            value={networkPolicy.networkMode}
            disabled={saving}
            onValueChange={(next) => {
              const mode = next as NetworkMode;
              setNetworkPolicy((current) => ({
                ...current,
                networkMode: mode,
              }));
              void savePolicy({ networkMode: mode });
            }}
          >
            <SelectTrigger size="lg" aria-label="放行策略" className="w-full">
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
      {/* 四类规则各一行：标签在左、编辑按钮在右（与浏览器控制页同一版式）。
          规则条目本身不在页面上铺开——用户口径 2026-11-23「这些东西不要显示，
          进编辑按钮打开的弹窗那边编辑」，页面只留入口。 */}
      {RULE_GROUPS.map((group) => (
        <SettingsRow
          key={group.kind}
          label={group.title}
          control={
            <Button
              type="button"
              variant="outline"
              size="lg"
              aria-label={`编辑${group.title}`}
              disabled={saving}
              onClick={() => openEditor(group.kind, null)}
              className={cn(CONTROL_HALF_WIDTH, CONTROL_BUTTON_SURFACE)}
            >
              编辑
            </Button>
          }
        />
      ))}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) {
            // 关闭即保存（用户口径 2026-11-23：不需要「完成」按钮，操作完自动保存）。
            // 规则表与两个协议开关都已在改动时写进 state，这里统一提交一次。
            void savePolicy();
            setEditor(null);
            setEditorDetail(null);
          }
        }}
      >
        {/* 固定尺寸（用户口径 2026-11-23：宽 60%、高 80%）+ 内部滚动。 */}
        <DialogContent
          showCloseButton={false}
          className="flex h-[80vh] w-[60vw] max-w-none flex-col gap-0 overflow-hidden p-0"
        >
          {/* 标题栏：照知识库弹窗的样子（左侧图标 + 标题，右侧窗控，细底线）。 */}
          <DialogHeader className="relative flex-row items-center justify-between space-y-0 border-b px-5 py-3 pr-12">
            <DialogTitle className="flex min-w-0 items-center gap-2 text-base font-medium">
              <ShieldCheck
                className="size-4 shrink-0 text-foreground-subtle"
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">
                {editorGroup?.title ?? "规则"}
              </span>
            </DialogTitle>
            <DialogClose
              className="absolute top-1/2 right-2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md border border-transparent text-foreground transition-colors hover:bg-muted"
              aria-label="关闭"
              title="关闭"
            >
              <X className="size-[18px]" strokeWidth={1.4} aria-hidden="true" />
            </DialogClose>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
            {/* 网络规则的协议开关（用户口径：放最上方）。 */}
            {editor?.kind === "domain" ? (
              <div className="shrink-0 divide-y divide-border rounded-lg border border-border">
                <NetworkToggleRow
                  label="HTTP 放行"
                  ariaLabel="HTTP 放行"
                  value={networkPolicy.httpAllowed}
                  disabled={saving}
                  onChange={(next) => {
                    setNetworkPolicy((current) => ({
                      ...current,
                      httpAllowed: next,
                    }));
                    void savePolicy({ httpAllowed: next });
                  }}
                />
                <NetworkToggleRow
                  label="SSL 证书校验"
                  ariaLabel="SSL 证书校验"
                  value={networkPolicy.tlsVerification}
                  disabled={saving}
                  onChange={(next) => {
                    setNetworkPolicy((current) => ({
                      ...current,
                      tlsVerification: next,
                    }));
                    void savePolicy({ tlsVerification: next });
                  }}
                />
              </div>
            ) : null}
            {editor === null || editorGroup === undefined
              ? null
              : (() => {
                  const table = ruleTable[editor.kind];
                  const detailRow =
                    editorDetail === null
                      ? undefined
                      : table.rows[editorDetail];
                  return detailRow === undefined ? (
                    <RuleEditor
                      rows={table.rows}
                      onChange={table.setRows}
                      placeholder={editorGroup.placeholder}
                      ariaLabel={editorGroup.ariaLabel}
                      disabled={saving}
                      showOperation={editorGroup.showOperation === true}
                      onEditRow={(index) => setEditorDetail(index)}
                    />
                  ) : (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <RuleDetail
                        row={detailRow}
                        placeholder={editorGroup.placeholder}
                        ariaLabel={editorGroup.ariaLabel}
                        disabled={saving}
                        showOperation={editorGroup.showOperation === true}
                        onChange={(next) =>
                          table.setRows(
                            table.rows.map((row, i) =>
                              i === editorDetail ? next : row,
                            ),
                          )
                        }
                        onBack={() => setEditorDetail(null)}
                      />
                    </div>
                  );
                })()}
            {/* 失败时的说明：成功不打扰（操作完自动保存）。 */}
            {message && message !== "已保存" ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {message}
              </p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </SettingsGroupCard>
  );
}

/**
 * 网络规则弹窗里的协议开关行。
 *
 * 行高与设置页其他行一致（用户口径 2026-11-23「和设置其他部分一样高」）：
 * `px-4 py-3` + 32px 控件，实测就是设置页标准行的 57px。
 * 用自己的紧凑结构而不套 `SettingsRow`：后者会给整行画 `border-t`，
 * 放进这个带外框的分组里会出现双线。
 */
function NetworkToggleRow({
  label,
  ariaLabel,
  value,
  disabled,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-ui-base font-medium text-foreground">{label}</span>
      {/* 开关只有 18px 高，行会矮于设置页其它行（那里控件是 32px 的下拉）。
          用一个 32px 高的容器兜住，行高才与「设置其他部分」一致。 */}
      <span className="flex h-8 w-[192px] shrink-0 items-center justify-end">
        <ToggleSelect
          ariaLabel={ariaLabel}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      </span>
    </div>
  );
}

/**
 * 规则编辑弹窗里的列表：添加按钮在左，每条点开就是那一条的编辑面板。
 *
 * 与插件页的列表同一形状（添加在左上、条目逐行、行尾删除），不再把输入框、
 * 两个下拉和删除按钮挤在同一行——那是弹窗宽度溢出与右侧控件贴边的原因。
 */
function RuleEditor({
  rows,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
  showOperation = false,
  onEditRow,
}: {
  rows: EditableRule[];
  onChange: (next: EditableRule[]) => void;
  placeholder: string;
  ariaLabel: string;
  disabled: boolean;
  showOperation?: boolean;
  onEditRow: (index: number) => void;
}) {
  /** 新增一条后直接进它的详情：新条目没内容，停在列表里没有可编辑的对象。 */
  const addRow = () => {
    onChange([...rows, { value: "", action: "ask" }]);
    onEditRow(rows.length);
  };
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  /** 搜索只影响展示，不改动数据顺序——下标仍按原表算，编辑/删除指向同一条。 */
  const visible = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      normalizedQuery
        ? row.value.toLowerCase().includes(normalizedQuery)
        : true,
    );

  // 表格列：匹配值占满剩余，操作/动作定宽，行尾固定操作列。
  const gridCols = showOperation
    ? "grid-cols-[minmax(0,1fr)_72px_96px_56px]"
    : "grid-cols-[minmax(0,1fr)_96px_56px]";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 工具条：添加在左、搜索在右（用户口径 2026-11-23：添加按钮放左边不变，
          列表参照快捷键页的搜索框样式）。 */}
      <div className="flex shrink-0 items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disabled}
          onClick={addRow}
          className="bg-input"
        >
          添加
        </Button>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索"
          aria-label={`搜索${ariaLabel}`}
          className="w-64"
        />
      </div>
      {/* 表格：表头 + 分隔线行（参照快捷键页）。 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div
            className={cn(
              "grid items-center bg-card px-4 py-3 text-ui-sm text-foreground-subtle",
              gridCols,
            )}
          >
            <span>{ariaLabel}</span>
            {/* 「读 / 写 / 删」这一列叫「权限」，避免与行尾操作列同名。 */}
            {showOperation ? <span>权限</span> : null}
            <span>动作</span>
            <span className="sr-only">操作</span>
          </div>
          {visible.length === 0 ? (
            <div className="border-t border-border px-4 py-8 text-center text-ui-sm text-foreground-subtle">
              {rows.length === 0 ? "还没有规则" : "没有匹配的规则"}
            </div>
          ) : (
            visible.map(({ row, index }) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: 规则表允许重复值，索引是唯一稳定键。
                key={index}
                className={cn(
                  "grid items-center border-t border-border px-4 py-3 text-ui-base",
                  gridCols,
                )}
              >
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`编辑规则 ${row.value || placeholder}`}
                  onClick={() => onEditRow(index)}
                  className="min-w-0 truncate text-left font-mono text-foreground hover:underline"
                >
                  {row.value || placeholder}
                </button>
                {showOperation ? (
                  <span className="text-foreground-subtle">
                    {FILE_OPERATIONS.find(
                      (entry) => entry.value === (row.operation ?? "read"),
                    )?.label ?? "读"}
                  </span>
                ) : null}
                <span className="text-foreground-subtle">
                  {RULE_ACTIONS.find((entry) => entry.value === row.action)
                    ?.label ?? ""}
                </span>
                <span className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`删除规则 ${row.value || ariaLabel}`}
                    disabled={disabled}
                    onClick={() => onChange(rows.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 单条规则的编辑面板：匹配值与动作各一行（标签在上、控件铺满），
 * 顶部可返回列表。宽度随弹窗，控件不再横向挤在一起。
 */
function RuleDetail({
  row,
  placeholder,
  ariaLabel,
  disabled,
  showOperation = false,
  onChange,
  onBack,
}: {
  row: EditableRule;
  placeholder: string;
  ariaLabel: string;
  disabled: boolean;
  showOperation?: boolean;
  onChange: (next: EditableRule) => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="text-ui-base text-foreground-subtle hover:text-foreground"
      >
        返回列表
      </button>
      <div className="space-y-1.5">
        <span className="text-ui-base text-foreground-subtle">{ariaLabel}</span>
        <Input
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={row.value}
          disabled={disabled}
          onChange={(event) => onChange({ ...row, value: event.target.value })}
          className="w-full font-mono text-ui-base"
        />
      </div>
      {showOperation ? (
        <div className="space-y-1.5">
          <span className="text-ui-base text-foreground-subtle">操作</span>
          <Select
            value={row.operation ?? "read"}
            disabled={disabled}
            onValueChange={(next) =>
              onChange({
                ...row,
                operation: next as NonNullable<EditableRule["operation"]>,
              })
            }
          >
            <SelectTrigger size="lg" aria-label="操作" className="w-full">
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
        </div>
      ) : null}
      <div className="space-y-1.5">
        <span className="text-ui-base text-foreground-subtle">动作</span>
        <Select
          value={row.action}
          disabled={disabled}
          onValueChange={(next) =>
            onChange({ ...row, action: next as PolicyRule["action"] })
          }
        >
          <SelectTrigger size="lg" aria-label="动作" className="w-full">
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
      </div>
    </div>
  );
}
