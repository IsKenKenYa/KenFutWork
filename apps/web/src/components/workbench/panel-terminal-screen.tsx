"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { WebSocketHandle } from "@/hooks/use-websocket";

/**
 * 终端屏幕（一个标签一个实例）：**xterm.js 终端模拟器 + 服务端 PTY**。
 *
 * 为什么必须有模拟器：PTY 那边是**真 shell 自己排版**——提示符、行编辑、颜色、光标移动、
 * 历史、Tab 补全、全屏 TUI 全走 ANSI 转义序列。用 `<pre>` 显示会得到一堆控制字符，
 * 且没法回传按键。xterm 负责「渲染 + 采集按键」，服务端 PTY 负责「shell 侧的行为」，
 * 两者合起来才等于「直接打开一个 PowerShell 窗口」。
 *
 * 三个方向的数据：
 * - 输出：`term.write(服务端来的原样字节)`；
 * - 输入：`term.onData` 拿到的是**原始按键序列**（回车 = `\r`、方向键 = `\u001b[A`），
 *   原样送服务端——不在客户端做任何解析（解析归 shell）；
 * - 尺寸：`FitAddon` 量出格子数，`term.onResize` → 服务端 PTY resize（PSReadLine 与
 *   全屏程序靠它排版；不改尺寸时长命令会绕行错乱）。
 */
export function TerminalScreen({
  sessionId,
  ws,
  active,
  clearSignal,
}: {
  sessionId: string;
  ws: WebSocketHandle;
  /** 是否是当前选中的标签（隐藏的标签也保持挂载：切回来时滚动缓冲还在）。 */
  active: boolean;
  /** 每次 +1 = 请清屏（清的是这个标签的模拟器缓冲，不动会话）。 */
  clearSignal: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      // 让终端背景跟面板走（xterm 默认黑底，在浅色主题里像块补丁）
      allowTransparency: true,
      theme: { background: "rgba(0,0,0,0)" },
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 11,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      // 容器还没有尺寸（面板刚展开）：下一次 active 变化会再 fit
    }
    // 初次量出来就告诉 PTY，别让 shell 以为自己是 80×24
    ws.resizeTerminal(sessionId, term.cols, term.rows);

    const offData = term.onData((data) => {
      ws.sendTerminalInput(sessionId, data);
    });
    const offResize = term.onResize(({ cols, rows }) => {
      ws.resizeTerminal(sessionId, cols, rows);
    });
    const offTerminal = ws.onTerminal((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.type === "output") term.write(event.data);
      if (event.type === "exit") {
        term.write(
          `\r\n[会话结束${
            event.exitCode === null ? "" : ` · 退出码 ${event.exitCode}`
          }]\r\n`,
        );
      }
    });
    // 宿主窗口/面板宽度变化：重新量格子（宿主不派发 resize 的情形由 active 变化兜底）
    const onWindowResize = () => {
      try {
        fit.fit();
      } catch {
        // 容器当时不可见：忽略
      }
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      offData.dispose();
      offResize.dispose();
      offTerminal();
      window.removeEventListener("resize", onWindowResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, ws]);

  // 切到当前标签：重新量一次并聚焦（键盘直接进终端，不需要先点一下）
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // 同上
      }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  // 清屏（只清这个标签的缓冲）
  useEffect(() => {
    if (clearSignal > 0) termRef.current?.clear();
  }, [clearSignal]);

  return (
    <div
      ref={hostRef}
      role="log"
      aria-label="终端输出"
      data-session={sessionId}
      className={
        active ? "h-full min-h-0 w-full" : "hidden h-full min-h-0 w-full"
      }
    />
  );
}
