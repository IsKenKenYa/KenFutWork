import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { ChevronDown } from "lucide-react";
import type { Ref } from "react";
import type { TerminalShellRead } from "./useTerminalShellCatalog.js";

/**
 * Code 终端面板工具栏的 shell 菜单（宿主适配件，G9/Q17）。
 *
 * 选项来自现有 `GET /api/code/shells`（与设置页同一清单，按本机存在性返回）；
 * 选择只回调 `onSelectShell`——「换 shell = 换会话」的重开逻辑在 vendored
 * Terminal 面板状态里（switchTerminalSessionShell），本组件不碰会话生命周期。
 */
export function TerminalShellMenu({
  activeShell,
  onSelectShell,
  read,
  triggerRef,
}: {
  /** 当前会话显式选用的 shell id；缺省表示跟随实例设置默认。 */
  activeShell?: string | undefined;
  onSelectShell: (shell: string) => void;
  read: TerminalShellRead;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  if (read.status !== "ready" || read.catalog.shells.length === 0) return null;
  const { catalog: response } = read;
  const current = activeShell ?? response.resolvedShell;
  const currentLabel =
    response.shells.find((shell) => shell.id === current)?.label ?? "Shell";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          size="default"
          variant="ghost"
          className="max-w-40 px-2 text-foreground-subtle focus-visible:outline-2 focus-visible:outline-primary"
          title="Shell"
          aria-label="Shell"
        >
          <span className="truncate">{currentLabel}</span>
          <ChevronDown data-icon="inline-end" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={current}>
          {response.shells.map((shell) => (
            <DropdownMenuRadioItem
              key={shell.id}
              value={shell.id}
              onSelect={() => {
                onSelectShell(shell.id);
              }}
            >
              {shell.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TerminalShellReadNotice({
  read,
  onRetry,
}: {
  read: TerminalShellRead;
  onRetry: (button: HTMLButtonElement) => void;
}) {
  if (read.status !== "error") return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <p role="alert" className="min-w-0 text-ui-base text-destructive">
        {read.message}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="focus-visible:outline-2 focus-visible:outline-primary"
        aria-label="重新读取 Shell 列表"
        aria-disabled={read.retrying}
        aria-busy={read.retrying}
        onClick={(event) => onRetry(event.currentTarget)}
      >
        {read.retrying ? "正在读取…" : "重新读取"}
      </Button>
    </div>
  );
}
