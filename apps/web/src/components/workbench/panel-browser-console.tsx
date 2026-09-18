"use client";

import { Eraser, PanelTop, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/toast";
import {
  type ConsoleMessageView,
  clearConsoleMessages,
  evaluateInPage,
  fetchConsoleMessages,
} from "@/lib/server-api";

/**
 * 悬浮控制台（用户口径：「内嵌的控制台不能做成悬浮窗的形式吗，并且可以拖动，可以关闭」）。
 *
 * 为什么自己画而不用页面里的 Eruda：Eruda 的界面在页面的 **shadow root** 里、只能铺在页面
 * 底部——既拖不动也关不掉。控制台要能拖能关，就得是**我们自己的 DOM**；消息从 CDP 这条线搬
 * （`GET /api/browser/cdp/messages` 增量拉），表达式直接在我们自己的输入框里敲并在页面里执行。
 *
 * 两条边界（如实写在界面上）：
 * - 这里只有 **Console**（日志 / 异常 / 浏览器错误 + 执行表达式）；Elements / Network 那些
 *   页内面板走标题栏的「完整面板」（注入 Eruda）；
 * - 消息在**打标签时就订阅**，所以打开窗口之前页面报的错也在；但清空与上限（300 条）
 *   由服务端缓存决定。
 */

/** 消息最多显示多少条（与页面的滚动量平衡）。 */
const MAX_RENDERED = 300;

/** 悬浮窗位置记在这（拖过一次之后，关了再开还在原地）。 */
const POSITION_KEY = "workbench:browser-console-pos";

/** 默认位置：左下角（控制台的常规落点），并夹进面板范围内。 */
function defaultPosition(bounds: { width: number; height: number }) {
  return {
    x: 16,
    y: Math.max(16, bounds.height - CONSOLE_SIZE.height - 16),
  };
}

/** 读回上次拖到的位置；没有或坏了就用默认（局部兜底，不影响主流程）。 */
function savedPosition(bounds: { width: number; height: number }) {
  if (typeof window === "undefined") return defaultPosition(bounds);
  try {
    const raw = window.localStorage.getItem(POSITION_KEY);
    if (!raw) return defaultPosition(bounds);
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // 值坏了：当没存过
  }
  return defaultPosition(bounds);
}

export function BrowserConsoleWindow({
  accessToken,
  onClose,
  onOpenPagePanel,
  bounds,
}: {
  accessToken: string | null;
  onClose: () => void;
  /** 「完整开发者工具」：独立窗口（浮动、可移动）。 */
  onOpenPagePanel: () => void;
  /** 可拖范围（面板里的画面区尺寸）——窗口不许拖出这块地方。 */
  bounds: { width: number; height: number };
}) {
  const [messages, setMessages] = useState<ConsoleMessageView[]>([]);
  const [position, setPosition] = useState(() => savedPosition(bounds));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  /** 已拿到的最大 seq（增量拉的游标）。 */
  const sinceRef = useRef(0);
  /** 本地回显（自己敲的那行）的伪 seq：递减的负数，与服务端 seq 不会撞。 */
  const echoSeqRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  /**
   * 增量拉消息：窗口开着才轮询（关掉就停，不在后台空转）。
   *
   * 服务端缓存里有「打开窗口之前」的消息，所以第一次拉（since=0）会一次带回来，
   * 正好是用户想要的历史。
   */
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const result = await fetchConsoleMessages(
          accessToken,
          sinceRef.current,
        );
        if (cancelled || result.messages.length === 0) return;
        sinceRef.current = Math.max(sinceRef.current, result.nextSeq);
        setMessages((current) =>
          [...current, ...result.messages].slice(-MAX_RENDERED),
        );
      } catch {
        // 拉取失败不弹错（面板可能刚断开、页面正在换）：下一轮继续
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accessToken]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages 只当触发器（滚到底要发生在渲染之后）
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const clamp = useCallback(
    (next: { x: number; y: number }) => ({
      x: Math.max(0, Math.min(next.x, Math.max(0, bounds.width - 120))),
      y: Math.max(0, Math.min(next.y, Math.max(0, bounds.height - 40))),
    }),
    [bounds.width, bounds.height],
  );

  // 面板变窄/收起后，别让窗口停在看不见的地方
  useEffect(() => {
    setPosition((current) => clamp(current));
  }, [clamp]);

  /** 拖动：整条标题栏是把手（pointer capture，松手即停）。 */
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    // 捕获指针：拖出窗口边界也要继续收到 move（jsdom 没有这个方法，故可选调用）
    event.currentTarget.setPointerCapture?.(event.pointerId);
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
    // 拖过就记住：关掉再开还在原地
    try {
      window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    } catch {
      // 存不了（隐私模式等）：只是下次回到默认位置，不算错
    }
  };

  const run = async () => {
    const expression = input.trim();
    if (!expression || !accessToken) return;
    setInput("");
    setBusy(true);
    // 自己敲的也先显示出来（不然执行期间看起来什么都没发生）
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
      sinceRef.current = Math.max(sinceRef.current, message.seq);
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : "执行失败。", "error");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setMessages([]);
    if (!accessToken) return;
    try {
      await clearConsoleMessages(accessToken);
    } catch {
      // 清空失败不必打扰用户：本地已经清了，下一轮增量会带回来
    }
  };

  return (
    <div
      role="dialog"
      aria-label="控制台"
      style={{ left: position.x, top: position.y }}
      className="absolute z-20 flex h-72 w-[26rem] max-w-[calc(100%-1rem)] flex-col border border-foreground/20 bg-background shadow-lg"
    >
      {/* 标题栏整体是拖动把手（悬浮窗的常规交互）：不是按钮，故不加按钮语义 */}
      <div
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex cursor-move items-center gap-1 border-b bg-muted px-2 py-1 text-[11px] select-none"
      >
        <span className="font-medium">控制台</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            aria-label="完整面板"
            title="打开完整面板"
            onClick={onOpenPagePanel}
            className="p-1 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <PanelTop className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="清空控制台"
            title="清空"
            onClick={() => void clear()}
            className="p-1 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <Eraser className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="关闭控制台"
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
        aria-label="控制台消息"
        className="min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px] leading-relaxed"
      >
        {messages.length === 0 ? (
          <p className="text-muted-foreground">还没有输出。</p>
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
        )}
      </div>

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
          placeholder="输入表达式，回车执行"
          className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none"
        />
      </form>
    </div>
  );
}

/** 默认悬浮窗尺寸（拖动夹取要用；与上面的 class 保持一致）。 */
const CONSOLE_SIZE = { width: 416, height: 288 };
