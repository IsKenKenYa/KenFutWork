/**
 * zcode 照搬：`@/components/EmbeddedWebsiteHeader.tsx`（references/zcode/packages/ui/src/components/EmbeddedWebsiteHeader.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */

import { cn } from "@zui/components/lib/utils";
import { Button } from "@zui/components/ui/button";
import { useZCodeIntl } from "@zui/i18n/IntlProvider";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";

export function EmbeddedWebsiteHeader({
  title,
  loading,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onReload,
  onClose,
}: {
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <header className="bg-background px-6 py-4 pb-0 max-sm:px-4">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg"
              aria-label={intl.formatMessage({
                id: "quickPick.command.goBack",
              })}
              disabled={!canGoBack}
              onClick={onBack}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg"
              aria-label={intl.formatMessage({
                id: "quickPick.command.goForward",
              })}
              disabled={!canGoForward}
              onClick={onForward}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg"
              aria-label={intl.formatMessage({ id: "common.refresh" })}
              onClick={onReload}
            >
              <RefreshCwIcon
                className={cn("size-4", loading && "animate-spin")}
              />
            </Button>
          </div>
          <h2 className="truncate text-ui-lg font-medium">{title}</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className="rounded-xl"
          aria-label={intl.formatMessage({ id: "common.close" })}
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
    </header>
  );
}
