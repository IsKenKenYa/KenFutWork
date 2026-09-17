"use client";

import type { TerminalShellId } from "@kenfutwork/shared";
import { Eraser, Play, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WebSocketHandle } from "@/hooks/use-websocket";
import {
  fetchTerminalShells,
  type TerminalShellOption,
} from "@/lib/code-git-api";

/**
 * 终端（R3-1「终端」标签）：**交互式会话**——一条常驻 shell，cd 保留、REPL 能连续对话
 * （python / node / psql…），不再是一条命令起一个进程。
 *
 * 三条如实写在界面上的边界：
 * - **没有 TTY**（服务端是常驻进程 + 管道，不是 node-pty）：shell 自己不做行编辑与回显，
 *   提示符与输入回显由这里补（参考图里的 `PS D:\…>` 也是这个意思）；
 * - 会话绑在 WS 连接上：连接断了服务端会收掉会话，这里在重连后自动重开一条；
 * - 一次只跑一条会话（切 shell = 关掉旧的、开一条新的），会话闲置 30 分钟由服务端收掉。
 */

/** 前端缓冲上限：终端是「看最近的输出」，无限追加会把这个标签页吃光。 */
const MAX_BUFFER_CHARS = 200_000;

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `term-${crypto.randomUUID()}`;
  }
  return `term-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function TerminalPane({
  accessToken,
  canvasId,
  ws,
}: {
  accessToken: string | null;
  canvasId: string | null;
  ws: WebSocketHandle;
}) {
  const [shells, setShells] = useState<TerminalShellOption[]>([]);
  /**
   * shell 清单是否已问过一遍：**会话要等它回来再开**——否则会在默认 shell 还没解析出来时
   * 先起一条，用户看到的会话就不是设置里配的那个（实测：起完才发现列表到了，shell 没带上）。
   */
  const [shellsResolved, setShellsResolved] = useState(false);
  const [shell, setShell] = useState<TerminalShellId | null>(null);
  const [autoShell, setAutoShell] = useState<TerminalShellId | null>(null);
  const [buffer, setBuffer] = useState("");
  const [command, setCommand] = useState("");
  const [status, setStatus] = useState<
    "idle" | "starting" | "running" | "exited"
  >("idle");
  const [exitReason, setExitReason] = useState<string | null>(null);
  /** 当前会话 id：**每次开新会话都换一个**（旧会话的 exit 事件不能误伤新会话）。 */
  const sessionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { connected } = ws;

  // shell 清单（含工作区默认）：终端下拉与设置页同一份
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    fetchTerminalShells(accessToken)
      .then((next) => {
        if (cancelled) return;
        setShells(next.shells);
        setAutoShell(next.resolvedShell);
        setShell((current) => current ?? next.defaultShell);
        setShellsResolved(true);
      })
      .catch(() => {
        // 拿不到清单就不摆下拉：会话仍可起（服务端按工作区默认解析）
        setShellsResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const append = useCallback((text: string) => {
    setBuffer((current) => {
      const next = current + text;
      return next.length > MAX_BUFFER_CHARS
        ? next.slice(next.length - MAX_BUFFER_CHARS)
        : next;
    });
  }, []);

  /** 起会话：换一个 sessionId（旧会话即便还没退干净也不会串台）。 */
  const start = useCallback(() => {
    if (!canvasId) return;
    const sessionId = makeSessionId();
    sessionRef.current = sessionId;
    setStatus("starting");
    setExitReason(null);
    ws.startTerminal({
      sessionId,
      canvasId,
      ...(shell ? { shell } : {}),
    });
  }, [canvasId, shell, ws]);

  /** 监听会话事件（输出/结束/起好了）。 */
  useEffect(() => {
    return ws.onTerminal((event) => {
      if (event.sessionId !== sessionRef.current) return;
      if (event.type === "output") append(event.data);
      if (event.type === "started") setStatus("running");
      if (event.type === "exit") {
        setStatus("exited");
        setExitReason(event.reason ?? null);
        append(
          `\r\n[会话结束${event.exitCode === null ? "" : ` · 退出码 ${event.exitCode}`}]\r\n`,
        );
      }
    });
  }, [ws, append]);

  // 第一次挂载就开会话（终端标签被打开就是要用）；等 shell 清单回来再开，别开错壳
  useEffect(() => {
    if (status !== "idle") return;
    if (!canvasId || !connected || !shellsResolved) return;
    start();
  }, [canvasId, connected, status, shellsResolved, start]);

  // 断线后服务端会话已被收掉：重连时自动重开一条（而不是留下一个不响应的界面）
  useEffect(() => {
    if (connected) return;
    if (status === "running" || status === "starting") {
      setStatus("idle");
      append("\r\n[连接断开，重连后会自动重开会话]\r\n");
    }
  }, [connected, status, append]);

  // 卸载（工作台离开）时收掉会话，别把进程留给服务端
  useEffect(() => {
    return () => {
      if (sessionRef.current) ws.stopTerminal(sessionRef.current);
    };
  }, [ws]);

  // 输出滚动到底
  // biome-ignore lint/correctness/useExhaustiveDependencies: buffer 只当触发器（滚动位置按 DOM 现算）；去掉后新输出不再跟随滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [buffer]);

  const send = useCallback(() => {
    const line = command;
    if (status !== "running" || !sessionRef.current) return;
    // 没有 TTY：回显由这里补（shell 自己不会回显管道里的输入）
    append(`❯ ${line}\r\n`);
    ws.sendTerminalInput(sessionRef.current, line);
    setCommand("");
  }, [append, command, status, ws]);

  if (!canvasId) {
    return (
      <p className="text-xs text-muted-foreground">
        这个会话没有绑定工作目录——终端要在工作目录里执行。
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {shells.length > 0 ? (
          <Select
            aria-label="终端 shell"
            value={shell ?? shells.at(0)?.id}
            onValueChange={(next) => {
              if (typeof next !== "string") return;
              // 换 shell = 关掉旧会话、开一条新的（会话是进程，不能原地换壳）
              if (sessionRef.current) ws.stopTerminal(sessionRef.current);
              sessionRef.current = null;
              setShell(next as TerminalShellId);
              setBuffer("");
              setStatus("idle");
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
        <span className="text-[10px] text-muted-foreground">
          {status === "running"
            ? "会话进行中"
            : status === "starting"
              ? "正在开会话…"
              : connected
                ? "会话已结束"
                : "未连接"}
        </span>
        <button
          type="button"
          aria-label="清屏"
          title="清掉这个标签页里的输出（不影响会话）"
          onClick={() => setBuffer("")}
          className="ml-auto shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Eraser className="h-3.5 w-3.5" />
        </button>
        {status === "exited" ? (
          <button
            type="button"
            aria-label="重新开会话"
            onClick={start}
            className="shrink-0 rounded-md border px-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            <Play className="mr-0.5 inline h-3 w-3" />
            重开
          </button>
        ) : null}
      </div>

      {exitReason ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
          {exitReason}
        </p>
      ) : null}

      <div
        ref={scrollRef}
        role="log"
        aria-label="终端输出"
        className="min-h-0 flex-1 overflow-y-auto rounded-xl border bg-muted/30 p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap"
      >
        {buffer.length === 0 ? (
          <span className="text-muted-foreground">
            {status === "running"
              ? "会话已就绪。输入命令回车执行——cd 会保留，python / node 这类 REPL 也可以连续交互。"
              : "正在准备终端会话…"}
          </span>
        ) : (
          buffer
        )}
      </div>

      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <span
          aria-hidden
          className="shrink-0 font-mono text-xs text-muted-foreground"
        >
          ❯
        </span>
        <input
          aria-label="终端命令"
          value={command}
          disabled={status !== "running"}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={
            status === "running" ? "输入命令，回车执行" : "会话未就绪"
          }
          /* 终端是「一条命令一行」：不进历史、不做输入法之外的处理 */
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={status !== "running"}
          className="shrink-0 rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
        >
          执行
        </button>
      </form>
      <p className="text-[10px] text-muted-foreground">
        命令在**工作目录**里执行，走上面选中的 shell 本体（默认值在「设置 → 通用
        → 终端」里配）； 这是常驻会话（cd 保留、REPL 可用），没有
        TTY——行内编辑与回显由这里补。
      </p>
    </div>
  );
}

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
