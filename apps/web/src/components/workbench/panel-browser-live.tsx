"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/toast";
import {
  isRemoteKeyEvent,
  modifiersOf,
  streamSrc,
  textToForward,
  toViewportPoint,
} from "@/lib/cdp-view";
import { getServerBaseUrl } from "@/lib/env";
import {
  type CdpInputWireEvent,
  type CdpViewportView,
  connectCdp,
  fetchCdpStatus,
  openCdpView,
  sendCdpInput,
} from "@/lib/server-api";

/**
 * 右栏浏览器面板的**画面**：受控浏览器的实时画面（MJPEG）+ 交互回填。
 *
 * 为什么不是 iframe：iframe 是跨源的，读不到 DOM、挂不上调试工具、也注不进脚本。
 * 用户口径是「调试面板要在内嵌页面里出来」——只有让面板显示受控浏览器**自己的画面**，
 * 注入到页面里的调试控制台才会出现在面板里。
 *
 * 交互按**视口 CSS 坐标**回填（`toViewportPoint` 把面板里的显示坐标线性映射过去），
 * 键盘走一个不可见的输入框：有名字的键当按键发，可打印字符（含中文输入法合成的结果）
 * 走 `insertText`。
 */
export function BrowserLiveView({
  accessToken,
  url,
  frameWidth,
  frameHeight,
  reloadToken,
  navigateToken,
  onReload,
}: {
  accessToken: string | null;
  url: string;
  /** 画面尺寸（= 受控浏览器的视口尺寸；面板按它排版，所以页面不会有莫名其妙的横向滚动）。 */
  frameWidth: number;
  frameHeight: number;
  reloadToken: number;
  /** 「用户主动打开」计数：变一次 = 重开流并让浏览器真的去加载 url（页面自跳不计数）。 */
  navigateToken: number;
  /** 画面流断了要用户手动重来时：请上层把地址重新加载一遍。 */
  onReload?: (() => void) | undefined;
}) {
  const [state, setState] = useState<
    | { status: "connecting" }
    | { status: "live"; src: string }
    | { status: "error"; message: string }
  >({ status: "connecting" });
  const [viewport, setViewport] = useState<CdpViewportView>({
    width: 0,
    height: 0,
    scale: 1,
  });
  const { toast } = useToast();

  const imgRef = useRef<HTMLImageElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<HTMLTextAreaElement>(null);
  const draggingRef = useRef(false);
  const lastHoverRef = useRef(0);
  /** 自动重连预算（换地址/换尺寸/手动刷新时归零）。 */
  const retriesRef = useRef(0);
  /** 上一次开流用的 reloadToken：变了说明用户点了「刷新」，这次要真的重载。 */
  const lastReloadRef = useRef(reloadToken);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const openRef = useRef<() => Promise<void>>(async () => {});

  // biome-ignore lint/correctness/useExhaustiveDependencies: 这几个值只当触发器（重试预算随它们归零）
  useEffect(() => {
    retriesRef.current = 0;
  }, [url, frameWidth, frameHeight, reloadToken]);

  /**
   * 开流：确认受控浏览器在（不在就**无头**起一个——面板就是它的窗口，别再弹一个出来）
   * → 导航 + 换票据 → 把票据挂到 `<img>` 上。
   */
  const open = useCallback(async () => {
    if (!accessToken || !url || frameWidth <= 0 || frameHeight <= 0) return;
    // 用户点了「刷新」（换地址/换尺寸不带 reload：那些不需要重载当前页）
    const forceReload = lastReloadRef.current !== reloadToken;
    lastReloadRef.current = reloadToken;
    setState({ status: "connecting" });
    try {
      const status = await fetchCdpStatus(accessToken);
      if (status.status !== "connected") {
        const connected = await connectCdp(accessToken, { headless: true });
        if (connected.status !== "connected") {
          throw new Error(
            connected.status === "error"
              ? connected.message
              : "浏览器启动失败。",
          );
        }
      }
      const opened = await openCdpView(accessToken, {
        url,
        width: frameWidth,
        height: frameHeight,
        ...(forceReload ? { reload: true } : {}),
      });
      setViewport(opened.viewport);
      setState({
        status: "live",
        src: streamSrc(getServerBaseUrl(), opened.ticket),
      });
    } catch (error: unknown) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "画面打开失败。",
      });
    }
  }, [accessToken, url, frameWidth, frameHeight, reloadToken]);
  openRef.current = open;

  /**
   * 重开流只在「用户主动打开（`navigateToken`）/ 换尺寸 / 手动刷新 / 换 token」时发生——
   * **不停在 `url` 上**：地址栏跟随页面自跳时会改 url，但那时画面本来就是页面本身，
   * 重开流只会把受控浏览器导航回去。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 触发器组（open 从 ref 取，读到的还是最新 url）
  useEffect(() => {
    void openRef.current();
  }, [accessToken, navigateToken, frameWidth, frameHeight, reloadToken]);

  /** 画面流断了：先自己重开两次，还不行就如实说（不假装还在跑）。 */
  const handleFrameError = useCallback(() => {
    if (retriesRef.current >= 2) {
      setState({
        status: "error",
        message: "画面已断开（浏览器可能被关闭）。",
      });
      return;
    }
    retriesRef.current += 1;
    void openRef.current();
  }, []);

  const send = useCallback(
    (event: CdpInputWireEvent) => {
      if (!accessToken) return;
      sendCdpInput(accessToken, event).catch((error: unknown) => {
        toast(
          error instanceof Error ? error.message : "操作没能送达浏览器。",
          "error",
        );
      });
    },
    [accessToken, toast],
  );

  /** 鼠标位置 → 视口坐标（画面按比例铺满显示盒，所以线性映射即可）。 */
  const pointFrom = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const rect =
        imgRef.current?.getBoundingClientRect() ??
        viewerRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return toViewportPoint(
        rect,
        { x: event.clientX, y: event.clientY },
        viewportRef.current,
      );
    },
    [],
  );

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // 点画面 = 焦点交给那个页面（键盘从这里进去）
      sinkRef.current?.focus();
      const point = pointFrom(event);
      if (!point) return;
      const pressed =
        event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
      draggingRef.current = pressed === "left";
      send({
        type: "mouse",
        action: "pressed",
        x: point.x,
        y: point.y,
        button: pressed,
        buttons: pressed === "left" ? 1 : pressed === "right" ? 2 : 4,
        modifiers: modifiersOf(event),
      });
    },
    [pointFrom, send],
  );

  const handleMouseUp = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const point = pointFrom(event);
      draggingRef.current = false;
      if (!point) return;
      send({
        type: "mouse",
        action: "released",
        x: point.x,
        y: point.y,
        button: event.button === 2 ? "right" : "left",
        buttons: 0,
        modifiers: modifiersOf(event),
      });
    },
    [pointFrom, send],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // 悬停只为触发 CSS hover：节流到 ~8fps 就够（拖拽中不节流）
      const now = Date.now();
      if (!draggingRef.current && now - lastHoverRef.current < 120) return;
      lastHoverRef.current = now;
      const point = pointFrom(event);
      if (!point) return;
      send({
        type: "mouse",
        action: "moved",
        x: point.x,
        y: point.y,
        button: draggingRef.current ? "left" : "none",
        buttons: draggingRef.current ? 1 : 0,
        modifiers: modifiersOf(event),
      });
    },
    [pointFrom, send],
  );

  /**
   * 滚轮要**非被动**监听：React 的 `onWheel` 在根节点上是 passive 的，`preventDefault()`
   * 会被浏览器拒掉，结果滚轮滚的是外层面板而不是被控页面。
   */
  useEffect(() => {
    const host = viewerRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = pointFrom(event);
      if (!point) return;
      // deltaMode 1 = 按行（滚轮常见）；换算成像素，页面才按正常速度滚
      const factor = event.deltaMode === 1 ? 16 : 1;
      send({
        type: "wheel",
        x: point.x,
        y: point.y,
        deltaX: event.deltaX * factor,
        deltaY: event.deltaY * factor,
      });
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [pointFrom, send]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        !isRemoteKeyEvent({
          key: event.key,
          composing: event.nativeEvent.isComposing,
        })
      ) {
        return;
      }
      event.preventDefault();
      send({
        type: "key",
        key: event.key,
        code: event.code,
        modifiers: modifiersOf(event),
      });
    },
    [send],
  );

  /** 可打印字符（含输入法合成的最终结果）走 insertText；输入框自己保持空。 */
  const handleInput = useCallback(
    (event: React.FormEvent<HTMLTextAreaElement>) => {
      const native = event.nativeEvent as InputEvent;
      const text = textToForward({
        data: native.data ?? null,
        isComposing: native.isComposing,
      });
      // 输入框只是个「键盘入口」：内容不留、不显示
      event.currentTarget.value = "";
      if (text) send({ type: "text", text });
    },
    [send],
  );

  return (
    <div className="relative h-full w-full bg-background">
      <section
        ref={viewerRef}
        aria-label="内嵌浏览器画面"
        className="relative h-full w-full overflow-hidden"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          draggingRef.current = false;
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        {state.status === "live" ? (
          // biome-ignore lint/performance/noImgElement: 这是 MJPEG 流（multipart/x-mixed-replace），next/image 用不了
          <img
            ref={imgRef}
            src={state.src}
            alt={`浏览器画面：${url}`}
            draggable={false}
            onError={handleFrameError}
            className="absolute top-0 left-0 h-full w-full select-none"
          />
        ) : state.status === "connecting" ? (
          <p className="p-2 text-xs text-muted-foreground">
            正在打开内嵌浏览器…
          </p>
        ) : (
          <div className="p-2 text-xs">
            <p className="text-destructive">{state.message}</p>
            {onReload ? (
              <button
                type="button"
                onClick={onReload}
                className="mt-1 border px-1.5 py-0.5 hover:bg-muted"
              >
                重新加载
              </button>
            ) : null}
          </div>
        )}
      </section>
      {/*
        键盘入口：必须是**真的输入元素**才收得到输入法（中文）合成。
        隐藏但不能 `display:none`/`visibility:hidden`（那样拿不到焦点），所以压到 1px 透明。
      */}
      <textarea
        ref={sinkRef}
        aria-label="浏览器键盘输入"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        className="absolute h-px w-px resize-none border-0 p-0 opacity-0 outline-none"
        style={{ left: 1, top: 1 }}
      />
    </div>
  );
}
