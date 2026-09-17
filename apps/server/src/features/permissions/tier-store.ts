import type { PermissionRules, PermissionTier } from "@kenfutwork/shared";
import {
  permissionRulesSchema,
  permissionTierSchema,
} from "@kenfutwork/shared";

import type { PersistenceService } from "../persistence/types.js";

/**
 * 权限相关配置的持久化（app_config 单行表，DEC-4 / R5-3 / R5-4）。
 * 实例级配置，无租户维度：直接走 persistence 根客户端（不涉 `:workspace` 谓词）。
 *
 * 一张表里现在放四件事（都是「本安装实例的信任级别」）：
 * - `permission_tier`：常规任务档位；
 * - `automation_permission_tier`：自动化任务（目标/循环）档位；
 * - `permission_rules`：第 4 档「自定义配置」的 allow / deny 规则；
 * - `browser_control_enabled`：agent 能不能用 `browser_open` 打网页。
 */

export interface PermissionSettings {
  /** 常规任务档位。 */
  tier: PermissionTier;
  /** 自动化任务（goal/loop）档位。 */
  automationTier: PermissionTier;
  rules: PermissionRules;
  browserControlEnabled: boolean;
}

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  tier: "default",
  automationTier: "default",
  rules: { allow: [], deny: [] },
  browserControlEnabled: false,
};

export interface PermissionSettingsStore {
  /** 读回持久化设置；无行/坏值时逐字段回落缺省（宁严勿松）。 */
  load(): Promise<PermissionSettings>;
  /** 写入设置（单行 upsert，幂等）。只写送来的字段由调用方合并后再传入。 */
  save(settings: PermissionSettings): Promise<void>;
}

type AppConfigRow = {
  permission_tier: unknown;
  automation_permission_tier: unknown;
  permission_rules: unknown;
  browser_control_enabled: unknown;
};

export function createPermissionSettingsStore(
  persistence: PersistenceService,
): PermissionSettingsStore {
  return {
    async load() {
      const row = await persistence.queryOne<AppConfigRow>(
        `select permission_tier, automation_permission_tier, permission_rules,
                browser_control_enabled
           from public.app_config where id = 1`,
      );
      if (!row) return { ...DEFAULT_PERMISSION_SETTINGS };
      const tier = permissionTierSchema.safeParse(row.permission_tier);
      const automation = permissionTierSchema.safeParse(
        row.automation_permission_tier,
      );
      const rules = permissionRulesSchema.safeParse(row.permission_rules);
      return {
        // 坏值一律落 default：权限档宁严勿松（历史故障：UI 显示旧档、服务端按 default 拦）
        tier: tier.success ? tier.data : DEFAULT_PERMISSION_SETTINGS.tier,
        automationTier: automation.success
          ? automation.data
          : DEFAULT_PERMISSION_SETTINGS.automationTier,
        rules: rules.success ? rules.data : DEFAULT_PERMISSION_SETTINGS.rules,
        browserControlEnabled: row.browser_control_enabled === true,
      };
    },

    async save(settings) {
      await persistence.execute(
        `insert into public.app_config
           (id, permission_tier, automation_permission_tier, permission_rules,
            browser_control_enabled)
         values (1, $1, $2, $3::jsonb, $4)
         on conflict (id) do update
           set permission_tier = excluded.permission_tier,
               automation_permission_tier = excluded.automation_permission_tier,
               permission_rules = excluded.permission_rules,
               browser_control_enabled = excluded.browser_control_enabled,
               updated_at = now()`,
        [
          settings.tier,
          settings.automationTier,
          JSON.stringify(settings.rules),
          settings.browserControlEnabled,
        ],
      );
    },
  };
}
