import { z } from "zod";

import type { PermissionRules, PermissionTier } from "@kenfutwork/shared";
import {
  permissionRulesSchema,
  permissionTierSchema,
} from "@kenfutwork/shared";

import type { PersistenceService } from "../persistence/types.js";

/**
 * 权限相关配置的持久化（app_config 单行表，DEC-4 / R5-3 / R5-4）。
 * 实例级配置，无租户维度：直接走 persistence 根客户端（不涉 `:instance` 谓词）。
 *
 * 一张表里现在放四件事（都是「本安装实例的信任级别」）：
 * - `permission_tier`：常规任务档位；
 * - `automation_permission_tier`：自动化任务（目标/循环）档位；
 * - `permission_rules`：第 4 档「自定义」的 allow / deny 规则；
 * - `approved_tools`：「永久」粒度批准的工具名（此前只存内存，重启即丢）；
 * - `browser_control_enabled`：agent 能不能用 `browser_open` 打网页；
 * - `browser_devtools_read_enabled`：agent 能不能读面板控制台采集到的开发者工具数据。
 */

const approvedToolsSchema = z.array(z.string().min(1));


export interface PermissionSettings {
  /** 常规任务档位。 */
  tier: PermissionTier;
  /** 自动化任务（goal/loop）档位。 */
  automationTier: PermissionTier;
  rules: PermissionRules;
  /** 「永久」粒度批准的工具名（持久化；重启后依旧生效）。 */
  approvedForever: string[];
  browserControlEnabled: boolean;
  /** 浏览器动作后自动附截图（R5-4「自动截图」）。 */
  browserAutoScreenshot: boolean;
  /** CDP 托管浏览器是否无头（默认有窗口，便于用户看着它干活）。 */
  browserHeadless: boolean;
  /**
   * agent 能不能读**开发者工具数据**（控制台日志 / 页面报错 / 网络请求）。
   * 默认开——这是 agent 调试网页的主要依据，且数据只来自本机受控浏览器会话。
   */
  browserDevtoolsReadEnabled: boolean;
}

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  tier: "default",
  automationTier: "default",
  rules: { allow: [], deny: [] },
  approvedForever: [],
  browserControlEnabled: false,
  browserAutoScreenshot: false,
  browserHeadless: false,
  browserDevtoolsReadEnabled: true,
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
  approved_tools: unknown;
  browser_control_enabled: unknown;
  browser_auto_screenshot: unknown;
  browser_headless: unknown;
  browser_devtools_read_enabled: unknown;
};

export function createPermissionSettingsStore(
  persistence: PersistenceService,
): PermissionSettingsStore {
  return {
    async load() {
      const row = await persistence.queryOne<AppConfigRow>(
        `select permission_tier, automation_permission_tier, permission_rules,
                approved_tools,
                browser_control_enabled, browser_auto_screenshot, browser_headless,
                browser_devtools_read_enabled
           from public.app_config where id = 1`,
      );
      if (!row) return { ...DEFAULT_PERMISSION_SETTINGS };
      const tier = permissionTierSchema.safeParse(row.permission_tier);
      const automation = permissionTierSchema.safeParse(
        row.automation_permission_tier,
      );
      const rules = permissionRulesSchema.safeParse(row.permission_rules);
      const approvedTools = approvedToolsSchema.safeParse(row.approved_tools);
      return {
        // 坏值一律落 default：权限档宁严勿松（历史故障：UI 显示旧档、服务端按 default 拦）
        tier: tier.success ? tier.data : DEFAULT_PERMISSION_SETTINGS.tier,
        automationTier: automation.success
          ? automation.data
          : DEFAULT_PERMISSION_SETTINGS.automationTier,
        rules: rules.success ? rules.data : DEFAULT_PERMISSION_SETTINGS.rules,
        // 缺列/坏值落空数组：旧行没有这一列，与默认一致（没有历史批准可恢复）
        approvedForever: approvedTools.success
          ? approvedTools.data
          : DEFAULT_PERMISSION_SETTINGS.approvedForever,
        browserControlEnabled: row.browser_control_enabled === true,
        browserAutoScreenshot: row.browser_auto_screenshot === true,
        browserHeadless: row.browser_headless === true,
        // 缺列/坏值一律**当开**：与缺省一致（这一项是「读数」能力，不是放行动作）
        browserDevtoolsReadEnabled:
          row.browser_devtools_read_enabled === undefined
            ? DEFAULT_PERMISSION_SETTINGS.browserDevtoolsReadEnabled
            : row.browser_devtools_read_enabled === true,
      };
    },

    async save(settings) {
      await persistence.execute(
        `insert into public.app_config
           (id, permission_tier, automation_permission_tier, permission_rules,
            approved_tools,
            browser_control_enabled, browser_auto_screenshot, browser_headless,
            browser_devtools_read_enabled)
         values (1, $1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8)
         on conflict (id) do update
           set permission_tier = excluded.permission_tier,
               automation_permission_tier = excluded.automation_permission_tier,
               permission_rules = excluded.permission_rules,
               approved_tools = excluded.approved_tools,
               browser_control_enabled = excluded.browser_control_enabled,
               browser_auto_screenshot = excluded.browser_auto_screenshot,
               browser_headless = excluded.browser_headless,
               browser_devtools_read_enabled = excluded.browser_devtools_read_enabled,
               updated_at = now()`,
        [
          settings.tier,
          settings.automationTier,
          JSON.stringify(settings.rules),
          JSON.stringify(settings.approvedForever),
          settings.browserControlEnabled,
          settings.browserAutoScreenshot,
          settings.browserHeadless,
          settings.browserDevtoolsReadEnabled,
        ],
      );
    },
  };
}
