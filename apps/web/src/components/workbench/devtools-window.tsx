"use client";

import {
  Eraser,
  Network,
  SquareArrowOutUpRight,
  SquareTerminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/toast";
import {
  type BrowserRequestView,
  type ConsoleMessageView,
  clearConsoleMessages,
  evaluateInPage,
  fetchBrowserRequests,
  fetchConsoleMessages,
  openCdpDevtools,
} from "@/lib/server-api";

/**
 * 开发者工具（**内嵌**在工作台里的悬浮窗：可拖动、可关闭、能浮在任意位置，不局限于右栏）。
 *
 * 为什么是我们自己画而不是开一层真 DevTools 窗口：用户口径是「改用内嵌的，只是可以悬浮」。
 * 真 DevTools 前端没法内嵌（浏览器不给 iframe 挂调试器、自托管前端也不可行），而面板里的页面
 * 本来就是**受控浏览器的画面**——所以把它的数据面（CDP 的控制台事件与网络事件）搬到我们自己的
 * 窗口里，就得到「内嵌 + 可悬浮」的开发者工具。
 *
 * 三个 Tab 如实标边界：**控制台**（日志/异常 + 就地执行表达式）、**网络**（方法/URL/状态/失败原因）；
 * 需要 Elements / 性能 / 应用那些，标题栏那个 ↗ 去受控浏览器窗口里开完整 DevTools。
 */

/** 每个列表最多渲染多少条（与滚动量平衡）。 */
const MAX_RENDERED = 300;

/** 悬浮窗位置记在这（拖过一次之后，关了再开还在原地）。 */
const POSITION_KEY = "workbench:devtools-pos";

const WINDOW_SIZE = { width: 520, height: 320 };

/** 默认位置：右下角（离右栏近，但不受它限制）。 */
function defaultPosition() {
  if (typeof window === "undefined") return { x: 80, y: 80 };
  return {
    x: Math.max(16, window.innerWidth - WINDOW_SIZE.width - 24),
    y: Math.max(16, window.innerHeight - WINDOW_SIZE.height - 24),
  };
}

/** 读回上次拖到的位置；没有或坏了就用默认（局部兜底，不影响主流程）。 */
function savedPosition() {
  if (typeof window === "undefined") return defaultPosition();
  try {
    const raw = window.localStorage.getItem(POSITION_KEY);
    if (!raw) return defaultPosition();
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // 值坏了：当没存过
  }
  return defaultPosition();
}

type Tab = "console" | "network";

export function DevtoolsWindow({
  accessToken,
  onClose,
}: {
  accessToken: string | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("console");
  const [messages, setMessages] = useState<ConsoleMessageView[]>([]);
  const [requests, setRequests] = useState<BrowserRequestView[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState(savedPosition);
  const { toast } = useToast();
  /** 两条增量游标（各自独立）。 */
  const messageSeqRef = useRef(0);
  const requestSeqRef = useRef(0);
  /** 本地回显（自己敲的那行）的伪 seq：递减的负数，与服务端 seq 不撞。 */
  const echoSeqRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  /**
   * 轮询当前 Tab 的数据：窗口开着才轮询（关掉就停，不在后台空转）。
   * 服务端缓存里有「打开窗口之前」的记录，所以第一次（since=0）会带回历史。
   */
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    const pull = async () => {
      try {
        if (tab === "console") {
          const result = await fetchConsoleMessages(
            accessToken,
            messageSeqRef.current,
          );
          if (cancelled || result.messages.length === 0) return;
          messageSeqRef.current = Math.max(
            messageSeqRef.current,
            result.nextSeq,
          );
          setMessages((current) =>
            [...current, ...result.messages].slice(-MAX_RENDERED),
          );
          return;
        }
        const result = await fetchBrowserRequests(
          accessToken,
          requestSeqRef.current,
        );
        if (cancelled || result.requests.length === 0) return;
        requestSeqRef.current = Math.max(requestSeqRef.current, result.nextSeq);
        setRequests((current) =>
          [...current, ...result.requests].slice(-MAX_RENDERED),
        );
      } catch {
        // 拉取失败不弹错（可能刚断开/正在换页）：下一轮继续
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accessToken, tab]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容只当触发器（滚到底要发生在渲染之后）
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, requests, tab]);

  /** 夹进视口（窗口不许被拖出去）。 */
  const clamp = useCallback((next: { x: number; y: number }) => {
    if (typeof window === "undefined") return next;
    return {
      x: Math.max(0, Math.min(next.x, window.innerWidth - 120)),
      y: Math.max(0, Math.min(next.y, window.innerHeight - 40)),
    };
  }, []);

  // 视口变小后别把窗口留在看不见的地方
  useEffect(() => {
    const onResize = () => setPosition((current) => clamp(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    /**
     * 捕获指针：拖出窗口边界也要继续收到 move。
     * 可选调用 + try/catch：jsdom 没这个方法，自动化工具派发的合成事件也会因
     * 「pointerId 不存在」抛 NotFoundError——那两种情况都不该让拖动整个失效。
     */
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // 拿不到捕获也能拖（只是拖出边界后会丢事件）
    }
    dragRef.current = {
      dx: event.clientX - position.x,
      dy: event.clientY - position.y,
    };
  };
  const onDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPosition(
      clamp({ x: event.clientX - drag.dx, y: event.clientY - drag.dy }),
    );
  };
  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    } catch {
      // 存不了（隐私模式等）：只是下次回默认位置
    }
  };

  const run = async () => {
    const expression = input.trim();
    if (!expression || !accessToken) return;
    setInput("");
    setBusy(true);
    echoSeqRef.current -= 1;
    setMessages((current) =>
      [
        ...current,
        {
          seq: echoSeqRef.current,
          level: "log" as const,
          text: `> ${expression}`,
          at: new Date().toISOString(),
          source: "input" as const,
        },
      ].slice(-MAX_RENDERED),
    );
    try {
      const message = await evaluateInPage(accessToken, expression);
      setMessages((current) => [...current, message].slice(-MAX_RENDERED));
      messageSeqRef.current = Math.max(messageSeqRef.current, message.seq);
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : "执行失败。", "error");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setMessages([]);
    setRequests([]);
    if (!accessToken) return;
    try {
      await clearConsoleMessages(accessToken);
    } catch {
      // 清空失败不必打扰：本地已清，下一轮增量会带回来
    }
  };

  /** 完整 DevTools（受控浏览器窗口里那个，含 Elements / 性能 / 应用）。 */
  const openFullDevtools = () => {
    if (!accessToken) return;
    void (async () => {
      try {
        await openCdpDevtools(accessToken, {
          left: 60,
          top: 60,
          width: Math.min(1280, Math.round(window.screen.availWidth * 0.7)),
          height: Math.min(860, Math.round(window.screen.availHeight * 0.8)),
        });
        toast("完整开发者工具已打开（独立窗口）");
      } catch (error: unknown) {
        toast(
          error instanceof Error ? error.message : "打开完整开发者工具失败。",
          "error",
        );
      }
    })();
  };

  const tabClass = (value: Tab) =>
    `flex items-center gap-1 px-2 py-1 text-[11px] ${
      tab === value
        ? "bg-background text-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div
      role="dialog"
      aria-label="开发者工具"
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 flex h-80 w-[32rem] max-w-[calc(100vw-1rem)] flex-col border border-foreground/20 bg-background shadow-lg"
    >
      {/* 标题栏整体是拖动把手（悬浮窗的常规交互）：不是按钮，故不加按钮语义 */}
      <div
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex cursor-move items-center gap-1 border-b bg-muted px-2 py-1 text-[11px] select-none"
      >
        <span className="font-medium">开发者工具</span>
        <span className="text-muted-foreground">（可拖动）</span>
        <div className="ml-2 flex items-center">
          <button
            type="button"
            onClick={() => setTab("console")}
            className={tabClass("console")}
            aria-pressed={tab === "console"}
          >
            <SquareTerminal className="h-3 w-3" />
            控制台
          </button>
          <button
            type="button"
            onClick={() => setTab("network")}
            className={tabClass("network")}
            aria-pressed={tab === "network"}
          >
            <Network className="h-3 w-3" />
            网络
          </button>
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            aria-label="清空"
            title="清空"
            onClick={() => void clear()}
            className="p-1 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <Eraser className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="在浏览器窗口打开完整开发者工具"
            title="在浏览器窗口打开完整开发者工具（Elements / 性能 / 应用）"
            onClick={openFullDevtools}
            className="p-1 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <SquareArrowOutUpRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="关闭开发者工具"
            title="关闭"
            onClick={onClose}
            className="p-1 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div
        ref={listRef}
        role="log"
        aria-label={tab === "console" ? "控制台消息" : "网络请求"}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px] leading-relaxed"
      >
        {tab === "console" ? (
          messages.length === 0 ? (
            <p className="text-muted-foreground">
              这一页还没有控制台输出（页面里的 console.log /
              报错会出现在这里）。
            </p>
          ) : (
            messages.map((message) => (
              <div
                key={message.seq}
                className={`whitespace-pre-wrap break-words border-b border-border/40 py-0.5 last:border-0 ${
                  message.level === "error"
                    ? "text-destructive"
                    : message.level === "warn"
                      ? "text-amber-600"
                      : message.level === "info"
                        ? "text-muted-foreground"
                        : "text-foreground"
                }`}
              >
                <span className="mr-1 text-muted-foreground">
                  {message.at.slice(11, 19)}
                </span>
                {message.text}
              </div>
            ))
          )
        ) : requests.length === 0 ? (
          <p className="text-muted-foreground">
            还没有捕获到请求（在面板里打开网页、点几下就会出现）。
          </p>
        ) : (
          requests.map((request) => (
            <div
              key={request.seq}
              className="flex gap-2 border-b border-border/40 py-0.5 last:border-0"
            >
              <span className="shrink-0 text-muted-foreground">
                {request.method}
              </span>
              <span
                className={`shrink-0 ${
                  request.failed
                    ? "text-destructive"
                    : request.status !== undefined && request.status >= 400
                      ? "text-amber-600"
                      : "text-muted-foreground"
                }`}
              >
                {request.failed ? "失败" : (request.status ?? "…")}
              </span>
              <span className="min-w-0 flex-1 truncate" title={request.url}>
                {request.url}
              </span>
            </div>
          ))
        )}
      </div>

      {tab === "console" ? (
        <form
          className="flex items-center gap-1 border-t px-2 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <span
            aria-hidden
            className="font-mono text-[11px] text-muted-foreground"
          >
            ›
          </span>
          <input
            aria-label="执行表达式"
            value={input}
            disabled={busy}
            onChange={(event) => setInput(event.target.value)}
            placeholder="在页面里执行表达式，回车运行"
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none"
          />
        </form>
      ) : null}
    </div>
  );
}
