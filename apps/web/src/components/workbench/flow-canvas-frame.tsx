"use client";

import { FLOW_EMBED_PROTOCOL_VERSION } from "@kenfutwork/shared";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { LoadingScreen } from "@/components/loading-screen";
import { getServerBaseUrl } from "@/lib/env";
import {
  buildHelloAck,
  buildIdentity,
  buildNavigate,
  parseFlowInbound,
} from "@/lib/flow-embed";
import { serverFetch } from "@/lib/local-access";

/**
 * 换一张一次性身份票据（本地实例身份缝）：宿主前端凭本机接入（cookie）换票，
 * 随 `ff-embed/identity` 注入 flow；票据由 flow 网关带回宿主验签。
 * 换票失败返回 null——不拿假身份硬握，flow 侧会如实降级并给出原因。
 */
async function fetchIdentityTicket(): Promise<string | null> {
  try {
    const response = await serverFetch(
      `${getServerBaseUrl()}/api/flow/host/identity-ticket`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: unknown };
    return typeof body.token === "string" && body.token.length > 0
      ? body.token
      : null;
  } catch {
    return null;
  }
}

/** 宿主对 flow 画布的命令句柄：侧栏导航项让 iframe 内的 flow 路由跳转。 */
export interface FlowCanvasFrameHandle {
  navigate: (path: string) => void;
}

/**
 * Flow 模式主区：内嵌 flow 前端（iframe）+ `ff-embed/v1` 宿主侧握手。
 *
 * 宿主承担的事（协议唯一权威 `flow/docs/ff-embed-v1.md`）：
 *  ① 回 `hello-ack`（版本协商）→ 发 `identity`（本机接入换的一次性身份票据，
 *     flow 只交给它自己的网关去宿主服务端验签，前端不解析）；
 *  ② 提供 iframe 容器（flow 自带全部画布 UI：列表 / 编排 / 发布 / 执行都在里面）；
 *  ③ 收 `ready`（握手完成）；`navigate`（宿主侧栏 → flow 站内跳转）；
 *  ④ 侧栏导航归宿主（内嵌形态 flow 自己的侧栏隐藏），账号归宿主（身份缝互通）。
 *
 * 主区恒为这块画布（与 Design 同一条不变量）：无论是否选中项目，flow 模式的
 * 主区不被任务/会话对话框顶掉——flow 自己的列表与画布都在 iframe 内导航。
 */
export const FlowCanvasFrame = forwardRef<
  FlowCanvasFrameHandle,
  {
    frontendUrl: string;
    title?: string;
    active?: boolean;
  }
>(function FlowCanvasFrame(props, ref) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [connected, setConnected] = useState(false);
  /** iframe 首次加载完成（onLoad）：之前显示画布同款加载层，防白屏。 */
  const [frameLoaded, setFrameLoaded] = useState(false);

  // origin 白名单就是 flow 前端地址的 origin（服务端已校验只收 origin 形式）。
  const flowOrigin = useMemo(() => {
    try {
      return new URL(props.frontendUrl).origin;
    } catch {
      return null;
    }
  }, [props.frontendUrl]);

  useEffect(() => {
    if (!flowOrigin) return;
    const version = FLOW_EMBED_PROTOCOL_VERSION;
    let disposed = false;

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== flowOrigin) return;
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;

      const message = parseFlowInbound(event.data, {
        origin: event.origin,
        allowedOrigin: flowOrigin,
      });
      if (!message) return;

      if (message.type === "ff-embed/hello") {
        frame.postMessage(buildHelloAck(version), flowOrigin);
        // 身份缝（本地实例）：先换一次性票据，再注入 identity；换票失败就不注入
        //（flow 侧会停在自己的降级面并给出原因，不拿假身份继续）。
        void fetchIdentityTicket().then((hostToken) => {
          const target = frameRef.current?.contentWindow;
          if (!disposed && hostToken && target === frame) {
            target.postMessage(buildIdentity(version, hostToken), flowOrigin);
          }
        });
        return;
      }
      if (message.type === "ff-embed/ready") {
        setConnected(true);
      }
      // run-event / navigation / error / bye：P5 事件统一进宿主 WS 通道时再消费。
    };

    window.addEventListener("message", onMessage);
    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
    };
  }, [flowOrigin]);

  // 侧栏导航项 → iframe 内的 flow 路由（握手前点击是 no-op，flow 会按默认页落地）。
  useImperativeHandle(
    ref,
    () => ({
      navigate: (path: string) => {
        const frame = frameRef.current?.contentWindow;
        if (!frame || !flowOrigin) return;
        frame.postMessage(
          buildNavigate(FLOW_EMBED_PROTOCOL_VERSION, path),
          flowOrigin,
        );
      },
    }),
    [flowOrigin],
  );

  if (!flowOrigin) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center bg-card text-sm text-muted-foreground"
      >
        flow 前端地址不合法（{props.frontendUrl}）· 检查
        KENFUTWORK_FLOW_FRONTEND_URL
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={frameRef}
        src={props.frontendUrl}
        title={props.title ?? "Flow 工作流画布"}
        className={`h-full w-full border-0 transition-opacity duration-300 ${
          frameLoaded ? "opacity-100" : "opacity-0"
        }`}
        inert={props.active === false}
        tabIndex={props.active === false ? -1 : 0}
        onLoad={() => setFrameLoaded(true)}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
      {/* 画布同款加载层：iframe 资源加载期间不再白屏（复用全站品牌加载屏，
          内嵌位置用 inline 变体——不做第二套加载动画） */}
      {!frameLoaded ? (
        <LoadingScreen variant="inline" />
      ) : !connected ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded-full bg-muted/80 px-3 py-1 text-xs text-muted-foreground"
        >
          正在与 flow 画布握手…
        </div>
      ) : null}
    </div>
  );
});
