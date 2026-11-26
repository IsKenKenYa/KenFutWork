import { ChevronDown, Plus, Store } from "lucide-react";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";

/**
 * MCP 页的「添加」入口：新建 / 从市场添加。
 * 形态与技能页的 SkillAddMenu 相同（主按钮 + 下拉）。
 * 宿主没有接通 MCP 市场时只出现「新建」。
 */
export function McpAddMenu({
  onCreate,
  onAddMarketplace,
  createDisabled = false,
}: {
  onCreate: () => void;
  onAddMarketplace?: () => void;
  createDisabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="default" data-testid="mcp-add-trigger">
          {intl.formatMessage({ id: "settings.mcp.add" })}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="mcp-add-menu">
        <DropdownMenuItem
          data-testid="mcp-add-create"
          disabled={createDisabled}
          onSelect={onCreate}
        >
          <Plus className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.mcp.add.create" })}
        </DropdownMenuItem>
        {onAddMarketplace ? (
          <DropdownMenuItem
            data-testid="mcp-add-marketplace"
            onSelect={onAddMarketplace}
          >
            <Store className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.mcp.add.marketplace" })}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
