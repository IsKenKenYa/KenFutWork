import { Button } from "@zui/components/ui/button.js";
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
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ModelDefaultsSection } from "./ModelDefaultsSection.js";
import { surfaceJson, surfaceRequest } from "./surfaceApi.js";

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

/**
 * 当前连接是否走加密传输。
 *
 * 只看页面协议：自托管/局域网部署配了
 * `KENFUTWORK_TLS_CERT_PATH` + `KENFUTWORK_TLS_KEY_PATH` 后整站是 https，
 * WS 升级走同一端口因此也是 wss。本机回环形态是 http + 本机凭据。
 * 不额外问服务端：页面能打开就说明协议已经定了，多一次请求只会更不确定。
 */
function secureTransportActive(): boolean {
  return window.location.protocol === "https:";
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
        <SettingsSubheading>沙箱安全</SettingsSubheading>
        <SandboxSecuritySection />
      </section>
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>规则与放行</SettingsSubheading>
        <PermissionPolicySection />
        <ToolApprovalSection />
      </section>
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>数据安全</SettingsSubheading>
        <DataSafetySection />
      </section>
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>AI 安全防护</SettingsSubheading>
        <AiSafetySection />
      </section>
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>自动备份</SettingsSubheading>
        <AutoBackupSection />
      </section>
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>审批模型</SettingsSubheading>
        <ModelDefaultsSection approvalOnly showHeading={false} />
      </section>
      <section className="min-w-0 space-y-3">
        <SettingsSubheading>审计中心</SettingsSubheading>
        <PermissionAuditSection />
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
  hint,
  rows,
  onChange,
  addLabel,
  placeholder,
  ariaLabel,
  disabled,
  showOperation = false,
}: {
  title: string;
  hint: string;
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
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-ui-base font-medium text-foreground">
            {title}
          </span>
          <span className="truncate text-ui-sm text-foreground-subtle">
            {hint}
          </span>
        </div>
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
 */
function AutoBackupSection() {
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{ policy?: { autoBackup?: { enabled?: boolean } } }>(
      "/api/permissions/tier",
    )
      .then((view) => {
        if (cancelled) return;
        setEnabled(view.policy?.autoBackup?.enabled !== false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (next: boolean) => {
    setSaving(true);
    setMessage(null);
    const previous = enabled;
    setEnabled(next);
    try {
      const view = await surfaceJson<{ policy?: Record<string, unknown> }>(
        "/api/permissions/tier",
      );
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: { ...(view.policy ?? {}), autoBackup: { enabled: next } },
        }),
      });
      setMessage("已保存");
    } catch (error) {
      setEnabled(previous);
      setMessage(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label="轮次前自动备份"
        description="改动文件前留快照"
        control={
          <input
            type="checkbox"
            aria-label="轮次前自动备份"
            checked={enabled}
            disabled={saving}
            onChange={(event) => void save(event.target.checked)}
            className="size-4"
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
    </SettingsGroupCard>
  );
}

/**
 * AI 安全防护：三项里落地了两项，整组默认关闭（与 WorkBuddy 一致）。
 *
 * - **工具内容注入防护**：工具返回内容里出现「覆盖先前指令」「索取凭据」这类句式时，
 *   在结果末尾追加属主声明，提示模型那是外部内容。
 * - **审批模型审查**：属主声明了操作类型的工具在进入人工审批之前，先交给审批模型审一次
 *   ——常规且有界的自动放行，可疑或越权的交回人工并附风险说明；未配置审批模型时
 *   一律回落到人工。关掉后审批一律走人工。
 *
 * 「模型行为智能审查」与「AI 智能审批」在 WorkBuddy 里是两项，本仓库由同一条
 * 审阅链路承担（`features/permissions/approval-review-service`），所以合成一个开关。
 */
function AiSafetySection() {
  const [injectionGuard, setInjectionGuard] = useState(false);
  const [approvalReview, setApprovalReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{
      policy?: {
        aiSafety?: { injectionGuard?: boolean; approvalReview?: boolean };
      };
    }>("/api/permissions/tier")
      .then((view) => {
        if (cancelled) return;
        setInjectionGuard(view.policy?.aiSafety?.injectionGuard === true);
        setApprovalReview(view.policy?.aiSafety?.approvalReview === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 改一项、另一项原样带上：PUT 收的是整个 policy，`aiSafety` 是整体替换，
   * 少传一个字段就会被服务端缺省值冲掉。
   */
  const save = async (next: {
    injectionGuard: boolean;
    approvalReview: boolean;
  }) => {
    setSaving(true);
    setMessage(null);
    const previous = { injectionGuard, approvalReview };
    setInjectionGuard(next.injectionGuard);
    setApprovalReview(next.approvalReview);
    try {
      const view = await surfaceJson<{ policy?: Record<string, unknown> }>(
        "/api/permissions/tier",
      );
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: { ...(view.policy ?? {}), aiSafety: next },
        }),
      });
      setMessage("已保存");
    } catch (error) {
      setInjectionGuard(previous.injectionGuard);
      setApprovalReview(previous.approvalReview);
      setMessage(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label="工具内容注入防护"
        description="标注外部内容里的指令"
        control={
          <input
            type="checkbox"
            aria-label="工具内容注入防护"
            checked={injectionGuard}
            disabled={saving}
            onChange={(event) =>
              void save({
                injectionGuard: event.target.checked,
                approvalReview,
              })
            }
            className="size-4"
          />
        }
      />
      <SettingsRow
        label="审批模型审查"
        description="高风险操作先自动审一遍"
        control={
          <input
            type="checkbox"
            aria-label="审批模型审查"
            checked={approvalReview}
            disabled={saving}
            onChange={(event) =>
              void save({
                injectionGuard,
                approvalReview: event.target.checked,
              })
            }
            className="size-4"
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
    </SettingsGroupCard>
  );
}

/**
 * 沙箱安全：如实说明执行隔离的**实际**状态，不摆开关。
 *
 * 本仓库的命令执行已经跑在进程沙箱里（`features/process-sandbox`）：文件系统按 Task
 * 授权目录白名单、只读目录单独列出、网络走 `strictAllowlist` 白名单。这些不是可选项，
 * 所以这里不提供「开/关沙箱」——关掉它等于给 AI 完整的本机权限，那不是配置项，
 * 是权限档位（完全访问）已经在管的事。
 *
 * 界面因此只做**事实披露**：隔离生效在哪里、网络白名单从哪来。
 */
function SandboxSecuritySection() {
  const [sandboxEnabled, setSandboxEnabled] = useState(true);
  const [bundledRuntimes, setBundledRuntimes] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{
      policy?: {
        bundledRuntimes?: { enabled?: boolean };
        sandbox?: { enabled?: boolean };
      };
    }>("/api/permissions/tier")
      .then((view) => {
        if (cancelled) return;
        setBundledRuntimes(view.policy?.bundledRuntimes?.enabled !== false);
        setSandboxEnabled(view.policy?.sandbox?.enabled !== false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** 沙箱安全总开关：读回策略再合并提交（与内置运行时同一手法）。 */
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

  /**
   * 只改内置运行时一项：读回当前策略再合并提交。
   *
   * 不复用「规则与放行」的一次性保存——那个卡片持有全部规则表，两处各自提交
   * 会把对方刚改的字段覆盖回旧值。
   */
  const saveBundledRuntimes = async (enabled: boolean) => {
    setSaving(true);
    setMessage(null);
    const previous = bundledRuntimes;
    setBundledRuntimes(enabled);
    try {
      const view = await surfaceJson<{ policy?: Record<string, unknown> }>(
        "/api/permissions/tier",
      );
      await surfaceJson("/api/permissions/tier", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: { ...(view.policy ?? {}), bundledRuntimes: { enabled } },
        }),
      });
      setMessage("已保存");
    } catch (error) {
      setBundledRuntimes(previous);
      setMessage(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label="执行隔离"
        description="命令在进程沙箱内运行"
        control={
          <input
            type="checkbox"
            aria-label="沙箱安全"
            checked={sandboxEnabled}
            disabled={saving}
            onChange={(event) => void saveSandbox(event.target.checked)}
            className="size-4"
          />
        }
      />
      <SettingsRow
        label="文件访问"
        description="限 Task 授权目录"
        control={
          <span className="text-ui-sm text-foreground-subtle">白名单</span>
        }
      />
      <SettingsRow
        label="网络访问"
        description="系统层只放行代理端口"
        control={
          <span className="text-ui-sm text-foreground-subtle">严格白名单</span>
        }
      />
      <SettingsRow
        label="内置运行时"
        description="命令使用随包运行时"
        control={
          <input
            type="checkbox"
            aria-label="内置运行时"
            checked={bundledRuntimes}
            disabled={saving}
            onChange={(event) => void saveBundledRuntimes(event.target.checked)}
            className="size-4"
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
    </SettingsGroupCard>
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
      };
    }>("/api/permissions/tier")
      .then((view) => {
        if (cancelled) return;
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
        <RuleGroup
          title="工具规则"
          hint="按工具名或前缀"
          rows={toolRules}
          onChange={setToolRules}
          addLabel="添加工具规则"
          placeholder="mcp__fs__*"
          ariaLabel="工具名或前缀"
          disabled={saving}
        />
        <div className="border-t border-border pt-4">
          <RuleGroup
            title="文件路径规则"
            hint="按路径前缀 读写删分别配"
            rows={pathRules}
            onChange={setPathRules}
            addLabel="添加路径规则"
            placeholder="D:\\项目\\敏感目录"
            ariaLabel="路径前缀"
            disabled={saving}
            showOperation
          />
        </div>
        <div className="border-t border-border pt-4">
          <RuleGroup
            title="命令规则"
            hint="按命令开头"
            rows={commandRules}
            onChange={setCommandRules}
            addLabel="添加命令规则"
            placeholder="rm -rf"
            ariaLabel="命令前缀"
            disabled={saving}
          />
        </div>
        <div className="border-t border-border pt-4">
          <RuleGroup
            title="网络域名规则"
            hint="按域名或子域"
            rows={domainRules}
            onChange={setDomainRules}
            addLabel="添加域名规则"
            placeholder="*.example.com"
            ariaLabel="域名"
            disabled={saving}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => void savePolicy()}
          >
            保存规则
          </Button>
          <span className="text-ui-sm text-foreground-subtle">
            从上往下匹配 第一条命中生效
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

/**
 * 数据安全：删除保护与敏感保护，外加两项如实状态（安全网关 / 传输加密）。
 *
 * 单独一张卡片：这几项管的是「数据会不会丢、凭据会不会被发出去」，与工具 / 路径 /
 * 命令 / 域名那四组规则不是一个判断维度；混在规则卡片里，用户既找不到它们，
 * 也看不出它们与规则无关。
 *
 * 开关与阈值立即提交（与本页其它开关一致：界面上是开的，服务端就必须已经存了），
 * 敏感规则是文本编辑，由「保存敏感规则」按钮提交——逐字提交会把半截正则写进策略。
 * 提交前读回整份策略再合并，只替换本卡片负责的两个字段。
 */
function DataSafetySection() {
  const [deleteProtection, setDeleteProtection] = useState({
    enabled: false,
    batchThreshold: 50,
    trashFirst: false,
  });
  const [sensitiveProtection, setSensitiveProtection] = useState({
    enabled: true,
    patterns: [] as string[],
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<{
      policy?: {
        deleteProtection?: {
          enabled?: boolean;
          batchThreshold?: number;
          trashFirst?: boolean;
        };
        sensitiveProtection?: { enabled?: boolean; patterns?: string[] };
      };
    }>("/api/permissions/tier")
      .then((view) => {
        if (cancelled) return;
        setDeleteProtection({
          enabled: view.policy?.deleteProtection?.enabled === true,
          batchThreshold: view.policy?.deleteProtection?.batchThreshold ?? 50,
          trashFirst: view.policy?.deleteProtection?.trashFirst === true,
        });
        setSensitiveProtection({
          enabled: view.policy?.sensitiveProtection?.enabled !== false,
          patterns: view.policy?.sensitiveProtection?.patterns ?? [],
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 提交：读回整份策略再合并，只替换本卡片负责的两个字段。
   *
   * 开关立即提交（与本页其它开关一致，避免出现「看着是开的、实际没存」的假状态）；
   * 敏感规则是文本编辑，逐字提交会把半截正则写进策略，所以由「保存敏感规则」按钮触发。
   */
  const save = async (next: {
    deleteProtection: {
      enabled: boolean;
      batchThreshold: number;
      trashFirst: boolean;
    };
    sensitiveProtection: { enabled: boolean; patterns: string[] };
  }) => {
    setSaving(true);
    setMessage(null);
    const previous = { deleteProtection, sensitiveProtection };
    setDeleteProtection(next.deleteProtection);
    setSensitiveProtection(next.sensitiveProtection);
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
            deleteProtection: {
              enabled: next.deleteProtection.enabled,
              batchThreshold: Math.max(
                1,
                Math.round(next.deleteProtection.batchThreshold),
              ),
              trashFirst: next.deleteProtection.trashFirst,
            },
            sensitiveProtection: {
              enabled: next.sensitiveProtection.enabled,
              patterns: next.sensitiveProtection.patterns
                .map((pattern) => pattern.trim())
                .filter((pattern) => pattern.length > 0),
            },
          },
        }),
      });
      setMessage("已保存");
    } catch (error) {
      setDeleteProtection(previous.deleteProtection);
      setSensitiveProtection(previous.sensitiveProtection);
      setMessage(readableError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label="删除保护"
        description="删除前先问我"
        control={
          <input
            type="checkbox"
            aria-label="删除保护"
            checked={deleteProtection.enabled}
            disabled={saving}
            onChange={(event) =>
              void save({
                deleteProtection: {
                  ...deleteProtection,
                  enabled: event.target.checked,
                },
                sensitiveProtection,
              })
            }
            className="size-4"
          />
        }
      />
      <SettingsRow
        label="批量删除审批"
        description="一次删到这么多先问我"
        control={
          <Input
            aria-label="批量删除审批阈值"
            type="number"
            min={1}
            max={10000}
            disabled={!deleteProtection.enabled || saving}
            value={deleteProtection.batchThreshold}
            onChange={(event) =>
              setDeleteProtection((current) => ({
                ...current,
                batchThreshold: Number(event.target.value) || 1,
              }))
            }
            // 数字输入在每次按键后提交会把「5」当最终值存下去（想填 50 的人先存了个 5）；
            // 离开输入框时才提交，改动内容一次落库。
            onBlur={() => void save({ deleteProtection, sensitiveProtection })}
            className="w-24"
          />
        }
      />
      <SettingsRow
        label="删除前先移到回收站"
        description="文件工具删除时先移入回收站"
        control={
          <input
            type="checkbox"
            aria-label="删除前先移到回收站"
            checked={deleteProtection.trashFirst}
            disabled={!deleteProtection.enabled || saving}
            onChange={(event) =>
              void save({
                deleteProtection: {
                  ...deleteProtection,
                  trashFirst: event.target.checked,
                },
                sensitiveProtection,
              })
            }
            className="size-4"
          />
        }
      />
      <SettingsRow
        label="敏感保护"
        description="参数里出现凭据格式就拦下"
        control={
          <input
            type="checkbox"
            aria-label="敏感保护"
            checked={sensitiveProtection.enabled}
            disabled={saving}
            onChange={(event) =>
              void save({
                deleteProtection,
                sensitiveProtection: {
                  ...sensitiveProtection,
                  enabled: event.target.checked,
                },
              })
            }
            className="size-4"
          />
        }
      />
      <div className="space-y-2 border-t border-border px-4 py-3">
        {sensitiveProtection.patterns.map((pattern, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 自定义正则可以重复，索引是唯一稳定键。
            key={index}
            className="flex items-center gap-2"
          >
            <Input
              aria-label="自定义敏感规则"
              placeholder="内部工号\\s*\\d{6}"
              disabled={!sensitiveProtection.enabled || saving}
              value={pattern}
              onChange={(event) =>
                setSensitiveProtection((current) => ({
                  ...current,
                  patterns: current.patterns.map((item, i) =>
                    i === index ? event.target.value : item,
                  ),
                }))
              }
              className="min-w-0 flex-1 font-mono text-ui-sm"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="删除这条敏感规则"
              disabled={saving}
              onClick={() =>
                setSensitiveProtection((current) => ({
                  ...current,
                  patterns: current.patterns.filter((_, i) => i !== index),
                }))
              }
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!sensitiveProtection.enabled || saving}
            onClick={() =>
              setSensitiveProtection((current) => ({
                ...current,
                patterns: [...current.patterns, ""],
              }))
            }
          >
            添加敏感规则
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => void save({ deleteProtection, sensitiveProtection })}
          >
            保存敏感规则
          </Button>
          {message ? (
            <span role="status" className="text-ui-sm text-foreground-subtle">
              {message}
            </span>
          ) : null}
        </div>
      </div>
      {/* 安全网关与传输加密：如实显示**当前连接的实际状态**。
          - 安全网关：入站由「回环监听 + CORS 白名单 + 每路由本机鉴权」收口，
            出站由域名规则（工具门 / 服务端出口 / HTTP MCP / 沙箱网络白名单）收口。
            自托管/局域网部署的 TLS 终结由用户自己的反向代理承担。
          - 传输加密：按页面协议判断——自托管配了 KENFUTWORK_TLS_CERT_PATH /
            KENFUTWORK_TLS_KEY_PATH 就是 https/wss；本机回环是 http + 本机凭据。 */}
      <SettingsRow
        label="安全网关"
        control={
          <span className="text-ui-sm text-foreground-subtle">
            出入站均收口
          </span>
        }
      />
      <SettingsRow
        label="传输加密"
        control={
          <span className="text-ui-sm text-foreground-subtle">
            {secureTransportActive() ? "HTTPS + WSS" : "本机凭据"}
          </span>
        }
      />
    </SettingsGroupCard>
  );
}

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
    <SettingsGroupCard>
      <div className="space-y-3 p-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-ui-base font-medium text-foreground">
            手动放行工具
          </span>
          <span className="truncate text-ui-sm text-foreground-subtle">
            立刻放行 不用等弹窗
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="工具名"
            placeholder="如 mcp__fs__write"
            value={toolName}
            onChange={(event) => setToolName(event.target.value)}
            className="min-w-0 flex-1 font-mono text-ui-sm"
          />
          <Select
            value={scope}
            onValueChange={(next) =>
              setScope(next as (typeof APPROVAL_SCOPES)[number]["value"])
            }
          >
            <SelectTrigger
              size="lg"
              aria-label="批准范围"
              className="w-28 shrink-0"
            >
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
  );
}

/** 审计来源 → 界面标签（与服务端 `permissionDecisionSourceSchema` 一一对应）。 */
const AUDIT_SOURCES: Record<string, string> = {
  disabled: "禁用清单",
  "tool-rule": "工具规则",
  "path-rule": "路径规则",
  "command-rule": "命令规则",
  "domain-rule": "域名规则",
  "custom-rules": "自定义规则",
  "approval-memory": "已批准",
  tier: "权限模式",
  approval: "人工审批",
};

interface AuditEntry {
  id: string;
  occurredAt: string;
  toolName: string;
  decision: "allow" | "deny";
  source: string | null;
  blocked: boolean;
  reason: string | null;
}

/**
 * 审计中心：最近的判定流水（放行与拦截都在），可导出与清空。
 *
 * 流水只记工具名、结论、命中的规则与理由——**不含工具参数**，所以整段导出
 * 不需要额外打码。导出为 CSV：一列一项，用户能直接用表格软件打开。
 */
function PermissionAuditSection() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const view = await surfaceJson<{ entries?: AuditEntry[] }>(
        "/api/permissions/audit",
      );
      setEntries(view.entries ?? []);
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = () => {
    const header = "时间,工具,结论,命中规则,硬拒绝,原因";
    const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = entries.map((entry) =>
      [
        entry.occurredAt,
        entry.toolName,
        entry.decision === "deny" ? "拒绝" : "放行",
        entry.source ? (AUDIT_SOURCES[entry.source] ?? entry.source) : "",
        entry.blocked ? "是" : "否",
        entry.reason ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
    const blob = new Blob([[header, ...rows].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `审计记录-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("已导出");
  };

  const clear = async () => {
    try {
      await surfaceRequest("/api/permissions/audit", { method: "DELETE" });
      setEntries([]);
      setMessage("已清空");
    } catch (error) {
      setMessage(readableError(error));
    }
  };

  return (
    <SettingsGroupCard>
      <div className="space-y-3 p-4">
        {loading ? (
          <p className="text-ui-sm text-foreground-subtle">读取中</p>
        ) : entries.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtle">还没有记录</p>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border pb-1 text-ui-sm last:border-b-0"
              >
                <span className="shrink-0 font-mono text-foreground-subtle">
                  {entry.occurredAt.slice(11, 19)}
                </span>
                <span className="font-mono text-foreground">
                  {entry.toolName}
                </span>
                <span
                  className={
                    entry.decision === "deny"
                      ? "text-destructive"
                      : "text-foreground-subtle"
                  }
                >
                  {entry.decision === "deny"
                    ? entry.blocked
                      ? "拒绝"
                      : "待审批"
                    : "放行"}
                </span>
                {entry.source ? (
                  <span className="text-foreground-subtle">
                    {AUDIT_SOURCES[entry.source] ?? entry.source}
                  </span>
                ) : null}
                {entry.reason ? (
                  <span className="min-w-0 flex-1 truncate text-foreground-subtle">
                    {entry.reason}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={load}>
            刷新
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={entries.length === 0}
            onClick={exportCsv}
          >
            导出
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={entries.length === 0}
            onClick={() => void clear()}
          >
            清空
          </Button>
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
