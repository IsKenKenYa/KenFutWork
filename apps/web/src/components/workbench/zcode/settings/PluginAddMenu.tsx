import { ChevronDown, Loader2, Plus, Sparkles } from "lucide-react";
import type { CreateTaskRequest } from "@zui/app-shell/types.js";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { usePluginCreator } from "@zui/hooks/usePluginCreator.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";

export function PluginAddMenu({
  onCreateTask,
  onAddMarketplace,
  onInstallSource,
  testId,
}: {
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onAddMarketplace: () => void;
  onInstallSource?: () => void;
  testId: string;
}) {
  const { intl } = useZCodeIntl();
  const creator = usePluginCreator(onCreateTask);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="default" data-testid={testId}>
          {creator.busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {intl.formatMessage({ id: "pluginCreator.add" })}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="plugin-add-menu">
        {onInstallSource ? <DropdownMenuItem data-testid="plugin-store-install-source-menu-item" onSelect={onInstallSource}><Plus className="size-4" aria-hidden="true" />从链接或目录安装</DropdownMenuItem> : null}
        <DropdownMenuItem
          data-testid="plugin-create-menu-item"
          disabled={creator.busy || !creator.available}
          onSelect={() => void creator.create()}
        >
          <Sparkles className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "pluginCreator.create" })}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="plugin-store-add-source-menu-item"
          onSelect={onAddMarketplace}
        >
          <Plus className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "pluginCreator.addMarketplace" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
