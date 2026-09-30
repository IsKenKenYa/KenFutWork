/**
 * zcode 照搬：`@/mentions/components/PluginMentionOptionContent.tsx`（references/zcode/packages/ui/src/mentions/components/PluginMentionOptionContent.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
import { PluginIcon } from "@zui/components/PluginIcon";
import type { MentionItem } from "@zui/mentions/mentionTypes";

export function PluginMentionOptionContent({ item }: { item: MentionItem }) {
  return (
    <span className="min-w-0 flex flex-1 items-center gap-2">
      <PluginIcon
        pluginId={item.data?.pluginId ?? item.value}
        src={item.data?.icon}
        className="size-5 rounded-md"
        iconClassName="size-3"
      />
      <span className="shrink-0 whitespace-nowrap text-ui-base font-medium text-foreground">
        {item.displayLabel ?? item.label}
      </span>
      <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
        {/* 冲突禁选项优先展示原因，普通项展示当前语言的插件描述。 */}
        {item.disabled && item.disabledReason
          ? item.disabledReason
          : item.description}
      </span>
    </span>
  );
}
