import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { surfaceJson } from "./surfaceApi.js";

export interface TerminalShellMenuOption {
  id: string;
  label: string;
}

interface TerminalShellsResponse {
  shells: TerminalShellMenuOption[];
  /** 会话未显式选 shell（auto）时实际会用的那个。 */
  resolvedShell: string;
}

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
}: {
  /** 当前会话显式选用的 shell id；缺省表示跟随实例设置默认。 */
  activeShell?: string | undefined;
  onSelectShell: (shell: string) => void;
}) {
  const [response, setResponse] = useState<TerminalShellsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    surfaceJson<TerminalShellsResponse>("/api/code/shells")
      .then((data) => {
        if (!cancelled) setResponse(data);
      })
      .catch((error) => {
        console.warn("[TerminalShellMenu] shells 列表加载失败：", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 拿不到清单就不摆菜单（不放假开关）；清单为空同样是「这台机器没 shell」的事实。
  if (!response || response.shells.length === 0) return null;
  const current = activeShell ?? response.resolvedShell;
  const currentLabel =
    response.shells.find((shell) => shell.id === current)?.label ?? "Shell";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="default"
          variant="ghost"
          className="max-w-40 px-2 text-foreground-subtle"
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
