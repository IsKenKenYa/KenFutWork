"use client";

import type { TerminalShellId } from "@kenfutwork/shared";
import { SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchTerminalShells,
  runTerminalCommand,
  type TerminalResult,
  type TerminalShellOption,
} from "@/lib/code-git-api";

/**
 * 终端（R3-1「终端」标签）：在**该画布的工作目录**里跑用户自己敲的命令。
 *
 * 口径写在界面上：cwd = 工作目录、每次执行有超时（服务端 20s）与输出上限；
 * 这是「用户操作自己的机器」（不套 agent 的工具门），但没有 stdin——交互式命令会被超时掐掉。
 */
/**
 * 终端下拉的选项：`auto（→ 本机实际用的那个）` 在前，其后是探测到的 shell。
 * `auto` 单列出来是因为它**不是某个具体 shell**——不写清解析成谁，用户看不出实际用的是什么。
 */
function SHELL_CHOICES(
  shells: TerminalShellOption[],
  autoShell: TerminalShellId | null,
): Array<{ value: TerminalShellId; label: string; title: string }> {
  const resolved = shells.find((option) => option.id === autoShell);
  return [
    {
      value: "auto",
      label: autoShell ? `auto（→ ${autoShell}）` : "auto（按平台默认）",
      title: resolved
        ? `跟随设置：${resolved.executable}`
        : "跟随平台默认 shell",
    },
    ...shells.map((option) => ({
      value: option.id,
      label: option.label,
      title: option.executable,
    })),
  ];
}

export function TerminalPane({
  accessToken,
  canvasId,
}: {
  accessToken: string | null;
  canvasId: string | null;
}) {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<TerminalResult[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * shell 选择（用户口径：「终端应该是直连 cmd 或者 powershell、git-bash 等等」）。
   * 清单由服务端探测本机有什么；初值取**工作区设置的默认**（设置页里配的那个）。
   */
  const [shells, setShells] = useState<TerminalShellOption[]>([]);
  const [shell, setShell] = useState<TerminalShellId | null>(null);
  /** `auto` 在本机解析成谁（下拉里写「auto（→ cmd）」，免得看不出实际用的是哪个）。 */
  const [autoShell, setAutoShell] = useState<TerminalShellId | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    fetchTerminalShells(accessToken)
      .then((next) => {
        if (cancelled) return;
        setShells(next.shells);
        setAutoShell(next.resolvedShell);
        setShell((current) => current ?? next.defaultShell);
      })
      .catch(() => {
        // 拿不到清单就不摆下拉：命令仍可执行（服务端按工作区默认解析）
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const run = useCallback(async () => {
    const trimmed = command.trim();
    if (!trimmed || !accessToken || !canvasId || running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await runTerminalCommand(
        accessToken,
        canvasId,
        trimmed,
        shell ?? undefined,
      );
      setHistory((prev) => [...prev, result]);
      setCommand("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "执行失败。");
    } finally {
      setRunning(false);
    }
  }, [accessToken, canvasId, command, running, shell]);

  if (!canvasId) {
    return (
      <p className="text-xs text-muted-foreground">
        这个会话没有绑定工作目录——终端要在工作目录里执行。
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {shells.length > 0 ? (
          <Select
            aria-label="终端 shell"
            value={shell ?? shells[0]!.id}
            onValueChange={(next) => {
              if (typeof next === "string") setShell(next as TerminalShellId);
            }}
            items={SHELL_CHOICES(shells, autoShell).map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          >
            <SelectTrigger
              className="shrink-0 gap-1 border-transparent bg-muted/60 px-2 py-1 font-mono text-[11px]"
              aria-label="终端 shell"
              title={
                SHELL_CHOICES(shells, autoShell).find(
                  (option) => option.value === shell,
                )?.title ?? ""
              }
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="min-w-44">
              {SHELL_CHOICES(shells, autoShell).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <input
          aria-label="终端命令"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="输入命令，回车执行"
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={running || command.trim().length === 0}
          className="shrink-0 rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
        >
          {running ? "执行中…" : "执行"}
        </button>
      </form>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}

      <div
        aria-label="终端输出"
        className="min-h-0 flex-1 overflow-y-auto rounded-xl border bg-muted/30 p-2 font-mono text-[11px] leading-5"
      >
        {history.length === 0 ? (
          <p className="text-muted-foreground">
            还没有执行过命令。命令在**工作目录**里运行，有超时与输出上限。
          </p>
        ) : (
          history.map((entry, index) => (
            <div key={`${entry.command}-${index}`} className="mb-2 last:mb-0">
              <div className="text-muted-foreground">$ {entry.command}</div>
              {entry.stdout ? (
                <pre className="m-0 whitespace-pre-wrap">{entry.stdout}</pre>
              ) : null}
              {entry.stderr ? (
                <pre className="m-0 whitespace-pre-wrap text-destructive">
                  {entry.stderr}
                </pre>
              ) : null}
              <div className="text-muted-foreground">
                {entry.timedOut
                  ? `超时终止（${entry.durationMs}ms）`
                  : `${entry.shell} · 退出码 ${entry.exitCode ?? "未知"} · ${entry.durationMs}ms`}
                {entry.truncated ? " · 输出已截断" : ""}
              </div>
            </div>
          ))
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">
        命令交给上面选中的 shell 本体执行（默认值在「设置 → 通用 →
        终端」里配）； 工作目录内执行，单次上限 20 秒、输出各 64
        KB；不支持交互式命令（没有 stdin）。
      </p>
    </div>
  );
}
