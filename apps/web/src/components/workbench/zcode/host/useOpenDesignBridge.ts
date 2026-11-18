import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  OPEN_DESIGN_BRIDGE_SOURCE,
  type OpenDesignHit,
  type OpenDesignRects,
} from "./openDesignRuntime.js";

/**
 * 与画布 iframe 里那块桥脚本说话。
 *
 * 只吃「来自当前这个 frame 且 source 匹配」的消息：iframe 是不透明 origin，
 * `event.source === contentWindow` 是唯一可靠的身份判断（拿不到它的文档）。
 */
export function useOpenDesignBridge({
  frameRef,
  documentKey,
  trackedPaths,
  onPickHit,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  /** 换文档（刷新/切版本/保存后重渲染）就把它变一次，ready 随之重置。 */
  documentKey: string;
  /** 需要持续跟踪矩形的 CSS 路径（评论锚点）。 */
  trackedPaths: string[];
  onPickHit: (hit: OpenDesignHit) => void;
}) {
  const [ready, setReady] = useState(false);
  const [rects, setRects] = useState<OpenDesignRects["rects"]>({});
  const [docSize, setDocSize] = useState<OpenDesignRects["doc"] | null>(null);
  const seq = useRef(0);
  const pending = useRef(
    new Map<number, (hit: OpenDesignHit | null) => void>(),
  );
  const pickHandler = useRef(onPickHit);
  pickHandler.current = onPickHit;
  const trackedKey = trackedPaths.join("\n");

  const post = useCallback(
    (message: Record<string, unknown>) => {
      frameRef.current?.contentWindow?.postMessage(
        { source: OPEN_DESIGN_BRIDGE_SOURCE, ...message },
        "*",
      );
    },
    [frameRef],
  );

  useEffect(() => {
    setReady(false);
    setRects({});
  }, [documentKey]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as {
        source?: string;
        type?: string;
        id?: number;
        hit?: OpenDesignHit | null;
        rects?: OpenDesignRects["rects"];
        doc?: OpenDesignRects["doc"];
      } | null;
      if (!data || data.source !== OPEN_DESIGN_BRIDGE_SOURCE) return;
      if (data.type === "ready" || data.type === "rects") {
        setReady(true);
        if (data.rects) setRects(data.rects);
        if (data.doc) setDocSize(data.doc);
        return;
      }
      if (data.type === "hit" && typeof data.id === "number") {
        if (data.id < 0) {
          pickHandler.current(data.hit as OpenDesignHit);
          return;
        }
        const resolve = pending.current.get(data.id);
        if (resolve) {
          pending.current.delete(data.id);
          resolve(data.hit ?? null);
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [documentKey, frameRef]);

  // 路径或文档变了就重新登记；桥会在滚动/缩放时自己重报矩形。
  useEffect(() => {
    if (!ready) return;
    post({ type: "track", ids: trackedKey ? trackedKey.split("\n") : [] });
  }, [post, ready, trackedKey]);

  const setPicking = useCallback(
    (on: boolean) => {
      post({ type: "pick", on });
    },
    [post],
  );

  const hitTest = useCallback(
    (x: number, y: number): Promise<OpenDesignHit | null> =>
      new Promise((resolve) => {
        seq.current += 1;
        const id = seq.current;
        pending.current.set(id, resolve);
        post({ type: "hit", id, x, y });
      }),
    [post],
  );

  return { ready, rects, docSize, setPicking, hitTest };
}
