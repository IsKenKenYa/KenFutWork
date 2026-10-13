import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { toast } from "@zui/components/ui/toast.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@zui/settings/SettingsPageParts.js";
import { Hand, ShieldAlert, ShieldCheck, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { surfaceJson } from "./surfaceApi.js";

/**
 * 权限档（G7/T7/C1，KenFutWork 宿主件）：旧四档语义（默认/自动审批/完全访问/自定义）
 * 充当「新会话默认档」（Q12：不采用 ZCode build/edit/plan/yolo 作权限档）。
 *
 * 数据面：GET/PUT /api/permissions/tier（app_config 写穿 + 启动读回，实测已接）。
 * 服务端 evaluate 已在 agent-runs toolGateFor 生效（内置工具 + 内核注册表工具两路）。
 * 「自定义」档的规则编辑在权限分区（PermissionTierSection）；composer chip 只换档，
 * 自定义档选中即按已保存的自定义规则走。
 */

type PermissionTier = "default" | "auto-approve" | "full-access" | "custom";

interface TierView {
  tier: PermissionTier;
}

const TIERS: ReadonlyArray<{
  value: PermissionTier;
  label: string;
}> = [
  { value: "default", label: "默认" },
  { value: "auto-approve", label: "自动审批" },
  { value: "full-access", label: "完全访问" },
  { value: "custom", label: "自定义" },
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

/** composer 的权限档 chip（C1）：与 ZCode 协作档、六档执行模式并排。 */
export function PermissionTierChip() {
  const { tier, save } = usePermissionTier();
  const [busy, setBusy] = useState(false);

  if (!tier) return null;
  const label = TIERS.find((entry) => entry.value === tier)?.label ?? tier;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={busy}
          aria-label="权限档"
          data-testid="permission-tier-chip"
        >
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={tier}
          onValueChange={(next) => {
            setBusy(true);
            void save(next as PermissionTier).finally(() => setBusy(false));
          }}
        >
          {TIERS.map((entry) => (
            <DropdownMenuRadioItem key={entry.value} value={entry.value}>
              {entry.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 设置页「权限」分区（T7）：默认档选择 + 自动化任务档 + 说明行。 */
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
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          新会话默认档
        </div>
        <SettingsGroupCard>
          <SettingsRow
            label="默认档"
            control={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={tier === null || busy}
                    aria-label="默认档"
                    data-testid="settings-default-tier"
                  >
                    {TIERS.find((entry) => entry.value === tier)?.label ??
                      "读取中…"}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup
                    value={tier ?? ""}
                    onValueChange={(next) => {
                      setBusy(true);
                      void save(next as PermissionTier).finally(() =>
                        setBusy(false),
                      );
                    }}
                  >
                    {TIERS.map((entry) => (
                      <DropdownMenuRadioItem
                        key={entry.value}
                        value={entry.value}
                      >
                        {entry.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
          <SettingsRow
            label="自动化任务档"
            control={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={automationTier === null}
                    aria-label="自动化任务档"
                  >
                    {TIERS.find((entry) => entry.value === automationTier)
                      ?.label ?? "读取中…"}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup
                    value={automationTier ?? ""}
                    onValueChange={(next) =>
                      void saveAutomation(next as PermissionTier)
                    }
                  >
                    {TIERS.map((entry) => (
                      <DropdownMenuRadioItem
                        key={entry.value}
                        value={entry.value}
                      >
                        {entry.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
        </SettingsGroupCard>
      </section>
    </div>
  );
}
