"use client";

import type { TerminalShellId } from "@kenfutwork/shared";
import { Check, Eraser, Plus, RotateCw, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TerminalScreen } from "@/components/workbench/panel-terminal-screen";
import type { WebSocketHandle } from "@/hooks/use-websocket";
import {
  fetchTerminalShells,
  type TerminalShellOption,
} from "@/lib/code-git-api";

/**
 * 终端（R3-1「终端」标签）：**像系统终端那样**的多标签交互式会话。
 *
 * 用户口径：「不要选择，自动进入系统默认配置的终端，然后终端标签页右键要切换终端！！！！并且
 * 终端不应该限制绑定文件目录！！！！」——三条落到实现上：
 *
 * 1. **不摆 shell 选择器**：开标签时不带 shell，服务端按系统默认解析（Windows 优先 PowerShell，
 *    见 `defaultShellOrder`）；工作区里显式配过 shell 的仍以配置为准（服务端解析时优先它）。
 * 2. **右键标签切换终端**：菜单列出本机探测到的 shell（当前那个打勾）+ 新建 / 关闭标签，
 *    换 shell = 换一条新会话（进程不能原地换壳）。
 * 3. **不要求绑工作目录**：没有 canvasId 时 cwd 落到服务端的启动目录——终端不该被目录限制住。
 *
 * 终端本体是**真 PTY**（服务端 node-pty / ConPTY）+ **xterm.js**（见 panel-terminal-screen）：
 * 提示符、行编辑、历史、Tab 补全、颜色、方向键、Ctrl+C 全由 shell 自己做，客户端只做
 * 「渲染 + 采集按键 + 报尺寸」。会话绑 WS 连接，断了会自动重开；闲置由服务端收掉。
 */

type TabStatus = "idle" | "starting" | "running" | "exited";

interface TerminalTab {
  /** 标签自己的标识（稳定，切 shell / 重开都沿用），也是 React key。 */
  key: string;
  /** 选定的 shell；null = 系统默认（不含 `auto` 字面量，语义由这里表达）。 */
  shell: TerminalShellId | null;
  /** 服务端 ack 回来的**实际** shell（标签名用它：显示真实在跑的那个）。 */
  resolved: TerminalShellId | null;
  /** 会话 id：每次开新会话都换一个（旧会话的 exit 事件不能误伤新会话）。 */
  sessionId: string;
  status: TabStatus;
  exitReason: string | null;
  /** 清屏信号：每次 +1 让这个标签的模拟器清缓冲（会话不动）。 */
  clearSignal: number;
}

let tabSeq = 0;

function makeTabId(): string {
  tabSeq += 1;
  return `tab-${tabSeq}`;
}

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `term-${crypto.randomUUID()}`;
  }
  return `term-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newTab(shell: TerminalShellId | null = null): TerminalTab {
  return {
    key: makeTabId(),
    shell,
    resolved: null,
    sessionId: makeSessionId(),
    status: "starting",
    exitReason: null,
    clearSignal: 0,
  };
}

/** shell id → 标签上的短名（清单没回来时也能显示，不摆一个说不上名字的标签）。 */
const SHELL_SHORT: Record<TerminalShellId, string> = {
  auto: "终端",
  cmd: "cmd",
  powershell: "PowerShell",
  pwsh: "PowerShell 7",
  "git-bash": "Git Bash",
  bash: "bash",
  sh: "sh",
};

export function TerminalPane({
  accessToken,
  canvasId,
  ws,
}: {
  accessToken: string | null;
  /** 绑定画布（= 工作目录）；**可空**——空则不绑目录，cwd 用服务端启动目录。 */
  canvasId: string | null;
  ws: WebSocketHandle;
}) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [shells, setShells] = useState<TerminalShellOption[]>([]);
  /** 右键菜单：位置 + 属于哪个标签（null = 关着）。 */
  const [menu, setMenu] = useState<{
    key: string;
    x: number;
    y: number;
  } | null>(null);
  /** 会话 id → 标签 key：事件按会话路由，标签自己的 key 不因重开而变。 */
  const sessionToTab = useRef(new Map<string, string>());
  /** 标签现状的快照：**开关会话这类副作用不塞进 `setState` 更新器**（更新器可能被跑两次）。 */
  const tabsRef = useRef<TerminalTab[]>([]);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  /** 卸载时「收会话」的待触发句柄（见下面的清理 effect：要能取消）。 */
  const unmountTimer = useRef<number | null>(null);
  const { connected } = ws;

  const active = tabs.find((tab) => tab.key === activeKey) ?? null;

  const patchTab = useCallback(
    (key: string, patch: (tab: TerminalTab) => Partial<TerminalTab>) => {
      setTabs((current) =>
        current.map((tab) =>
          tab.key === key ? { ...tab, ...patch(tab) } : tab,
        ),
      );
    },
    [],
  );

  /** 起一条会话（换 shell / 重开都走它：进程不能原地换壳，一律新会话）。 */
  const startSession = useCallback(
    (key: string, shell: TerminalShellId | null) => {
      const previous = tabsRef.current.find((tab) => tab.key === key);
      if (previous) sessionToTab.current.delete(previous.sessionId);
      const sessionId = makeSessionId();
      sessionToTab.current.set(sessionId, key);
      setTabs((current) =>
        current.map((tab) =>
          tab.key === key
            ? {
                ...tab,
                sessionId,
                shell,
                resolved: null,
                status: "starting",
                exitReason: null,
                // 换会话 = 换屏：清屏信号 +1 让新会话从干净屏幕开始
                clearSignal: tab.clearSignal + 1,
              }
            : tab,
        ),
      );
      ws.startTerminal({
        sessionId,
        ...(canvasId ? { canvasId } : {}),
        ...(shell ? { shell } : {}),
      });
    },
    [canvasId, ws],
  );

  /** 新开一个标签（服务端默认 shell）并激活它。 */
  const openTab = useCallback(
    (shell: TerminalShellId | null = null) => {
      const tab = newTab(shell);
      sessionToTab.current.set(tab.sessionId, tab.key);
      setTabs((current) => [...current, tab]);
      setActiveKey(tab.key);
      ws.startTerminal({
        sessionId: tab.sessionId,
        ...(canvasId ? { canvasId } : {}),
        ...(shell ? { shell } : {}),
      });
      return tab.key;
    },
    [canvasId, ws],
  );

  const closeTab = useCallback(
    (key: string) => {
      const current = tabsRef.current;
      const index = current.findIndex((tab) => tab.key === key);
      const closing = current[index];
      if (closing) {
        ws.stopTerminal(closing.sessionId);
        sessionToTab.current.delete(closing.sessionId);
      }
      const rest = current.filter((tab) => tab.key !== key);
      setMenu(null);
      // 关掉最后一个就再开一个（终端面板不该变成空壳；与多数终端的「最后一个关不掉」同效）
      if (rest.length === 0) {
        openTab();
        return;
      }
      setTabs(rest);
      // 关掉的是当前标签 → **右邻接替**（没有右边的就用左边那个）
      if (key === activeKey) {
        const next = rest[index] ?? rest[rest.length - 1];
        setActiveKey(next?.key ?? null);
      }
    },
    [activeKey, openTab, ws],
  );

  // shell 清单（右键菜单用；会话不依赖它——默认 shell 由服务端解析）
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    fetchTerminalShells(accessToken)
      .then((next) => {
        if (!cancelled) setShells(next.shells);
      })
      .catch(() => {
        // 拿不到清单就不摆切换项：终端照常可用（默认 shell 不需要清单）
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  /**
   * 第一个标签：连上就开（终端面板被打开就是要用）。
   * 守卫看**会话表**而不是 `tabs.length`：StrictMode 会把 effect 跑两遍，两遍拿到的是同一个
   * 闭包里的 `tabs`（都还是空），于是开出两个标签（真机实测）；`openTab` 会同步写会话表，
   * 第二遍就看得到。
   */
  useEffect(() => {
    if (!connected || sessionToTab.current.size > 0) return;
    openTab();
  }, [connected, openTab]);

  // 会话事件（起好 / 结束）按会话路由到标签；**输出不在这里**——它由 TerminalScreen
  // 直接写进 xterm 模拟器（ANSI 由模拟器解析，这边只维护标签状态）
  useEffect(() => {
    return ws.onTerminal((event) => {
      const key = sessionToTab.current.get(event.sessionId);
      if (!key) return;
      if (event.type === "started") {
        patchTab(key, () => ({ status: "running", resolved: event.shell }));
      }
      if (event.type === "exit") {
        patchTab(key, () => ({
          status: "exited",
          exitReason: event.reason ?? null,
        }));
      }
    });
  }, [ws, patchTab]);

  // 断线：服务端会话已被收掉，重连后自动重开（不留一个不响应的界面）
  useEffect(() => {
    if (connected) return;
    setTabs((current) =>
      current.map((tab) => {
        if (tab.status !== "running" && tab.status !== "starting") return tab;
        return {
          ...tab,
          status: "idle",
          // 重开时换会话，屏幕上也要换个干净的
          clearSignal: tab.clearSignal + 1,
        };
      }),
    );
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    for (const tab of tabsRef.current) {
      if (tab.status === "idle") startSession(tab.key, tab.shell);
    }
  }, [connected, startSession]);

  // 菜单 / 卸载的收尾：关菜单、收会话（别把进程留给服务端）
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      const el = event.target as HTMLElement | null;
      if (el?.closest("[data-terminal-menu]")) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  /**
   * 离开工作台时收掉会话（别把进程留给服务端）。
   *
   * **不能直接在清理里停**：StrictMode 会在挂载后立刻跑一次清理，那样刚起的会话会被自己杀掉
   * （真机实测：界面显示「客户端关闭了终端」+ 退出码 1，输入框永远未就绪）。所以延到下一个
   * tick 执行——真正的卸载会走到它，StrictMode 的假卸载会因为紧接着的重挂载被取消。
   */
  useEffect(() => {
    if (unmountTimer.current !== null) {
      window.clearTimeout(unmountTimer.current);
      unmountTimer.current = null;
    }
    return () => {
      unmountTimer.current = window.setTimeout(() => {
        unmountTimer.current = null;
        for (const sessionId of sessionToTab.current.keys()) {
          ws.stopTerminal(sessionId);
        }
      }, 0);
    };
  }, [ws]);

  const switching = useMemo(
    () => (menu ? (tabs.find((tab) => tab.key === menu.key) ?? null) : null),
    [menu, tabs],
  );

  const labelOf = useCallback(
    (tab: TerminalTab): string => {
      const id = tab.resolved ?? tab.shell;
      if (!id) return "终端";
      return (
        shells.find((option) => option.id === id)?.label ??
        SHELL_SHORT[id] ??
        "终端"
      );
    },
    [shells],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      {/* 标签条（像系统终端那样）：右键 = 切换终端 / 新建 / 关闭 */}
      <div className="flex items-center gap-0.5 overflow-x-auto">
        <SquareTerminal className="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {tabs.map((tab) => (
          <span
            key={tab.key}
            className={`group inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] ${
              tab.key === activeKey
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60"
            }`}
          >
            <button
              type="button"
              aria-label={`终端标签：${labelOf(tab)}`}
              title={`${labelOf(tab)}（右键切换终端）`}
              onClick={() => setActiveKey(tab.key)}
              onContextMenu={(event) => {
                event.preventDefault();
                setActiveKey(tab.key);
                setMenu({
                  key: tab.key,
                  x: Math.round(event.clientX),
                  y: Math.round(event.clientY),
                });
              }}
              className="max-w-32 truncate"
            >
              {labelOf(tab)}
            </button>
            <button
              type="button"
              aria-label={`关闭终端标签：${labelOf(tab)}`}
              onClick={() => closeTab(tab.key)}
              className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <button
          type="button"
          aria-label="新建终端"
          title="新建终端（用系统默认 shell）"
          onClick={() => openTab()}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {active?.status === "running"
            ? "进行中"
            : active?.status === "starting"
              ? "正在开…"
              : connected
                ? "已结束"
                : "未连接"}
        </span>
        <button
          type="button"
          aria-label="清屏"
          title="清掉这个标签页里的输出（不影响会话）"
          onClick={() =>
            active &&
            patchTab(active.key, (tab) => ({
              clearSignal: tab.clearSignal + 1,
            }))
          }
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Eraser className="h-3.5 w-3.5" />
        </button>
        {active?.status === "exited" ? (
          <button
            type="button"
            aria-label="重新开会话"
            title="用同一个 shell 重开一条会话"
            onClick={() => active && startSession(active.key, active.shell)}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {active?.exitReason ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
          {active.exitReason}
        </p>
      ) : null}

      {/* 每个标签一个 xterm 模拟器：隐藏的保持挂载（切回来滚动缓冲还在），
          键盘直接进终端——不再有「输入框 + 执行按钮」那一层 */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-muted/30 p-1">
        {tabs.map((tab) => (
          <TerminalScreen
            key={`${tab.key}:${tab.sessionId}`}
            sessionId={tab.sessionId}
            ws={ws}
            active={tab.key === activeKey}
            clearSignal={tab.clearSignal}
          />
        ))}
      </div>

      {menu && switching ? (
        <div
          data-terminal-menu
          role="menu"
          aria-label="终端标签菜单"
          style={{ top: menu.y, left: menu.x }}
          className="fixed z-50 w-52 rounded-lg border bg-popover p-1 text-xs shadow-md"
        >
          <p className="px-2 py-1 text-[10px] text-muted-foreground">
            切换终端（{labelOf(switching)}）
          </p>
          {shells.map((option) => {
            const current =
              (switching.resolved ?? switching.shell) === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                onClick={() => {
                  startSession(switching.key, option.id);
                  setMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted"
              >
                <Check
                  className={`h-3 w-3 shrink-0 ${current ? "" : "opacity-0"}`}
                />
                <span className="truncate">{option.label}</span>
              </button>
            );
          })}
          <div className="my-1 border-t" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openTab();
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted"
          >
            <Plus className="h-3 w-3 shrink-0" />
            新建终端
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => closeTab(switching.key)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted"
          >
            <X className="h-3 w-3 shrink-0" />
            关闭此终端
          </button>
        </div>
      ) : null}
    </div>
  );
}
