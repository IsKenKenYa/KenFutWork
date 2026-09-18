import { randomUUID } from "node:crypto";

import type { CdpInputEvent } from "./cdp-session.js";

/**
 * 右栏浏览器面板的**画面流协议**（HTTP 那一层：票据 / 分帧 / 输入事件形状）。
 *
 * 为什么在服务端做流：面板要显示受控浏览器的画面（iframe 跨源拿不到 DOM、挂不上调试工具、
 * 也注不进脚本），画面只能由服务端从 CDP 取来再推给浏览器。传输用 **MJPEG**
 * （`multipart/x-mixed-replace`）——`<img src>` 直接就能渲染，客户端零 JS 解码，
 * 这也是业界嵌入式远端的常规做法。
 *
 * 票据为什么必要：`<img>` 发不了 `Authorization` 头，所以流端点只能用 URL 凭证。做法与
 * blob 签名 URL 同一思路——**短时、一次性**：先带登录头换一张票据，再用票据开流。
 */

/** MJPEG 的分界与响应头（客户端与测试都按这个常量对齐）。 */
export const MJPEG_CONTENT_TYPE =
  "multipart/x-mixed-replace; boundary=kfwframe";

/**
 * 把一帧 JPEG 封成 MJPEG 的一个 part。
 *
 * 必须带 `Content-Length`：不带的话浏览器只能靠分隔符猜边界，遇到帧里恰好出现分隔字符串
 * 就会错位（JPEG 是二进制，撞上是迟早的事）。
 */
export function mjpegPart(jpeg: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--kfwframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
    ),
    Buffer.from(jpeg),
    Buffer.from("\r\n"),
  ]);
}

export interface ViewTicketMeta {
  width?: number;
  height?: number;
  quality?: number;
}

export interface ViewTicketStore {
  /** 开一张票据（顺带清掉过期的）。 */
  mint(meta: ViewTicketMeta): string;
  /** 取用（**一次性**：取过即失效；过期或不存在返回 null）。 */
  take(ticket: string | undefined): ViewTicketMeta | null;
  /** 当前未过期的票据数（测试/诊断用）。 */
  size(): number;
}

/**
 * 画面流票据：短时 + 一次性。
 *
 * 一次性是刻意的：票据会出现在 URL 里（浏览器历史、日志），泄漏后的可用窗口要尽量小。
 * 客户端每次开流都新换一张——成本只是一次带登录头的 POST。
 */
export function createViewTicketStore(
  options: { ttlMs?: number; now?: () => number } = {},
): ViewTicketStore {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<
    string,
    { expiresAt: number; meta: ViewTicketMeta }
  >();
  return {
    mint(meta) {
      const current = now();
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= current) entries.delete(key);
      }
      const ticket = randomUUID();
      entries.set(ticket, { expiresAt: current + ttlMs, meta });
      return ticket;
    },
    take(ticket) {
      if (!ticket) return null;
      const entry = entries.get(ticket);
      if (!entry) return null;
      entries.delete(ticket);
      if (entry.expiresAt <= now()) return null;
      return entry.meta;
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * 两个地址是不是**同一页**（比 origin + path + query，忽略末尾斜杠与 hash）。
 *
 * 用途：面板打开某个地址时，受控浏览器**已经在这一页**就别再 `Page.navigate` 一次——
 * 重复导航会整页重载，滚动位置、填了一半的表单、面板里的调试控制台全没了。
 * 这条以前就吃过亏（元素拾取每次都把页面刷一遍），判定收在这里一份。
 */
export function samePageUrl(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    try {
      const url = new URL(value);
      url.hash = "";
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.origin}${path}${url.search}`;
    } catch {
      return value.trim().replace(/\/+$/, "");
    }
  };
  const left = normalize(a);
  return left.length > 0 && left === normalize(b);
}

/** 有限数字（非法一律 null，便于逐字段判）。 */
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function button(value: unknown): "left" | "right" | "middle" | "none" | null {
  return value === "left" ||
    value === "right" ||
    value === "middle" ||
    value === "none"
    ? value
    : null;
}

/**
 * 面板回填的输入事件（**形状校验**，纯函数）。
 *
 * 坐标一律是**视口 CSS px**（客户端按面板里的显示尺寸换算好再发）——服务端不做缩放，
 * 它不知道面板有多宽，也不该知道。
 */
export function parseCdpInputEvent(body: unknown): CdpInputEvent | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (raw.type === "mouse") {
    const action = raw.action;
    if (action !== "pressed" && action !== "released" && action !== "moved") {
      return null;
    }
    const x = finite(raw.x);
    const y = finite(raw.y);
    if (x === null || y === null) return null;
    const pressed = button(raw.button);
    const buttons = finite(raw.buttons);
    const modifiers = finite(raw.modifiers);
    return {
      type: "mouse",
      action,
      x,
      y,
      ...(pressed ? { button: pressed } : {}),
      ...(buttons === null ? {} : { buttons: Math.round(buttons) }),
      ...(modifiers === null ? {} : { modifiers: Math.round(modifiers) }),
    };
  }
  if (raw.type === "wheel") {
    const x = finite(raw.x);
    const y = finite(raw.y);
    if (x === null || y === null) return null;
    const deltaX = finite(raw.deltaX);
    const deltaY = finite(raw.deltaY);
    return {
      type: "wheel",
      x,
      y,
      ...(deltaX === null ? {} : { deltaX }),
      ...(deltaY === null ? {} : { deltaY }),
    };
  }
  if (raw.type === "key") {
    const key = typeof raw.key === "string" ? raw.key : "";
    if (!key) return null;
    const code = typeof raw.code === "string" ? raw.code : undefined;
    const modifiers = finite(raw.modifiers);
    return {
      type: "key",
      key,
      ...(code ? { code } : {}),
      ...(modifiers === null ? {} : { modifiers: Math.round(modifiers) }),
    };
  }
  if (raw.type === "text") {
    const text = typeof raw.text === "string" ? raw.text : "";
    if (!text) return null;
    return { type: "text", text };
  }
  return null;
}
