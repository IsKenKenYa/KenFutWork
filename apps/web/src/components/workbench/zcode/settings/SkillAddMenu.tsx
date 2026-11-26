import {
  ChevronDown,
  Sparkles,
  SquareArrowRightEnter,
  Store,
} from "lucide-react";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";

/**
 * 技能页的「添加」入口：导入 / 从市场添加 / 使用 agent 创建。
 * 形态与插件页的 PluginAddMenu 相同（主按钮 + 下拉）。
 * 宿主没有接通技能市场时不传 `onAddMarketplace`，这一项不出现。
 */
export function SkillAddMenu({
  onImport,
  onAddMarketplace,
  onCreateWithAgent,
  importDisabled = false,
  createDisabled = false,
}: {
  onImport: () => void;
  onAddMarketplace?: () => void;
  onCreateWithAgent: () => void;
  importDisabled?: boolean;
  createDisabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="default" data-testid="skill-add-trigger">
          {intl.formatMessage({ id: "settings.skills.add" })}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="skill-add-menu">
        <DropdownMenuItem
          data-testid="skill-add-import"
          disabled={importDisabled}
          onSelect={onImport}
        >
          <SquareArrowRightEnter className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.resourceActions.import" })}
        </DropdownMenuItem>
        {onAddMarketplace ? (
          <DropdownMenuItem
            data-testid="skill-add-marketplace"
            onSelect={onAddMarketplace}
          >
            <Store className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.skills.add.marketplace" })}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          data-testid="skill-add-agent"
          disabled={createDisabled}
          onSelect={onCreateWithAgent}
        >
          <Sparkles className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.skills.add.agent" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
