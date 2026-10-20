import {
  buildOpenDesignHello,
  buildOpenDesignHelloAck,
  isAllowedOpenDesignOrigin,
  parseOpenDesignInbound,
} from "@kenfutwork/shared";
import { ZCodeStartupLogoBadge, ZCodeStartupSpinner } from "@zui/root/RootStartupLoading.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenDesignEntry } from "./openDesignHost.js";
import { surfaceJson } from "./surfaceApi.js";
import { OPEN_DESIGN_PROJECT_EVENT } from "./useOpenDesignProjectWatch.js";

/**
 * OpenDesign 面板（Code 模式右侧栏的联动画布，与浏览器面板同位互斥）。
 *
 * 入口显隐由启动卡按「插件安装态 + 宿主就绪」门控（见 `openDesignHost`）；这里再解析一次
 * 是为了拿 `frontendUrl`——tab 不带地址，避免把探针结果冻进持久侧栏状态。
 * 未就绪时不摆空壳，直接说明原因（fail loud）。
 *
 * `od/v1` 握手：宿主 iframe 加载后发 `od/hello`，面板侧按协议回 `od/hello` 才算握手
 * 成立，宿主随即回 `od/hello-ack`。上游尚未实现该协议（nexu-io/open-design#8776），
 * 握手不成立**不影响画布浏览**——深链「打开当前文件」已按用户口径移除（2026-10-15：
 * 面板只要自动连接、打开、编辑画布本身），`data-od-handshake` 留作诊断与验收钩子。
 *
 * **安全双闸**（《OpenDesign 集成规划》§8 风险 5）：消息来源必须等于配置里的前端
 * origin（origin 白名单），内容必须过 `parseOpenDesignInbound` 的 schema——两道独立
 * 校验，缺一不可；出站一律带 `targetOrigin`，**不向 `"*"` 广播**。
 */
export function OpenDesignPane() {
  const entry = useOpenDesignEntry();
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [handshake, setHandshake] = useState<"pending" | "ok">("pending");
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /**
   * 最近由对话创建的 OpenDesign 项目：有就打开它的项目画布，没有才停在上游首页。
   * 这样「对话里用了 OpenDesign 能力 → 右侧打开对应画布」不需要会话级绑定；
   * 等绑定落点定下来，再把这个单槽位升级成 sessionId → projectId。
   */
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectResolved, setProjectResolved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void surfaceJson<{ project?: { projectId?: string } }>(
      "/api/open-design/last-project",
    )
      .then((data) => {
        if (!cancelled) setProjectId(data?.project?.projectId ?? null);
      })
      .catch(() => {
        // 未配置数据目录或接口不可用：退回首页，不挡画布本身。
      })
      .finally(() => {
        if (!cancelled) setProjectResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 面板已打开时又建了新项目：直接切过去，不要求重新挂载。
  useEffect(() => {
    const onProject = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: unknown }>).detail
        ?.projectId;
      if (typeof projectId === "string") setProjectId(projectId);
    };
    window.addEventListener(OPEN_DESIGN_PROJECT_EVENT, onProject);
    return () =>
      window.removeEventListener(OPEN_DESIGN_PROJECT_EVENT, onProject);
  }, []);

  // 切项目时重新走一次加载态，避免旧画布在加载前被误认为新项目已就绪。
  useEffect(() => {
    setFrameLoaded(false);
  }, [projectId]);

  /**
   * 上游就绪状态：没有可用 agent CLI 时，项目页会退到「模型与提供商」。
   * 这条探针让面板自己说明原因，而不是让用户对着上游设置页猜。
   */
  const [readiness, setReadiness] = useState<{
    reachable: boolean;
    agentAvailable: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void surfaceJson<{ reachable: boolean; agentAvailable: boolean }>(
      "/api/open-design/host/readiness",
    )
      .then((value) => {
        if (!cancelled) setReadiness(value);
      })
      .catch(() => {
        // 探针失败不挡面板
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allowedOrigin = entry?.available
    ? new URL(entry.frontendUrl).origin
    : null;

  const post = useCallback(
    (message: Parameters<Window["postMessage"]>[0]) => {
      const target = frameRef.current?.contentWindow;
      // 出站必须带 targetOrigin：向 "*" 广播会把消息送给任何能收到它的窗口。
      if (target && allowedOrigin) target.postMessage(message, allowedOrigin);
    },
    [allowedOrigin],
  );

  useEffect(() => {
    if (!entry?.available || !allowedOrigin || !frameLoaded) return;
    let cancelled = false;

    const onMessage = (event: MessageEvent) => {
      if (cancelled) return;
      // 闸一：来源白名单。跨源伪造直接丢，不做「也许是同源子窗口」的宽容。
      if (!isAllowedOpenDesignOrigin(event.origin, allowedOrigin)) return;
      // 闸二：内容 schema。类型不明 / 字段越界一律当噪声丢弃。
      const parsed = parseOpenDesignInbound(event.data);
      if (!parsed) return;
      if (parsed.type === "od/hello") {
        setHandshake("ok");
        post(buildOpenDesignHelloAck());
      }
    };
    window.addEventListener("message", onMessage);
    // 宿主先开口：面板侧按协议回 hello 才算握手成立。
    post(buildOpenDesignHello());

    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [entry, allowedOrigin, frameLoaded, post]);

  if (entry === null || !projectResolved) {
    return (
      <div
        data-testid="open-design-pane"
        data-od-handshake={handshake}
        className="flex h-full flex-col items-center justify-center gap-5 bg-background"
      >
        <ZCodeStartupLogoBadge />
        <ZCodeStartupSpinner />
      </div>
    );
  }

  if (!entry.available) {
    return (
      <div
        data-testid="open-design-pane"
        data-od-handshake={handshake}
        className="flex h-full items-center justify-center bg-background px-6 text-center text-xs text-foreground-subtle"
      >
        {entry.reason}
      </div>
    );
  }

  return (
    <div
      data-testid="open-design-pane"
      data-od-handshake={handshake}
      className="flex h-full w-full flex-col bg-background"
    >
      {readiness?.reachable && !readiness.agentAvailable ? (
        <div
          role="status"
          data-testid="open-design-readiness"
          className="shrink-0 border-b border-border px-3 py-2 text-ui-caption text-foreground-subtle"
        >
          没有可用的设计引擎
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/*
         * 上游没有「只看画布」的路由：项目页是 1:1 的聊天/画布分栏。这里按 2 倍宽度
         * 渲染再把左半（上游聊天栏）裁掉，只露出 OpenDesign 自己的画布；默认分栏未
         * 拖过时正好是一半，拖过聊天栏则只会更窄，不会露出聊天内容。
         */}
        <iframe
          ref={frameRef}
          src={
            projectId
              ? `${entry.frontendUrl.replace(/\/$/u, "")}/projects/${encodeURIComponent(projectId)}`
              : entry.frontendUrl
          }
          title="OpenDesign"
          data-od-canvas-only="true"
          style={{
            position: "absolute",
            top: 0,
            left: "-100%",
            width: "200%",
            height: "100%",
          }}
          className={`border-0 transition-opacity duration-300 ${
            frameLoaded ? "opacity-100" : "opacity-0"
          }`}
          onLoad={() => setFrameLoaded(true)}
          allow="clipboard-read; clipboard-write; fullscreen"
        />
        {!frameLoaded ? (
          <div
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-background"
          >
            <ZCodeStartupLogoBadge />
            <ZCodeStartupSpinner />
          </div>
        ) : null}
      </div>
    </div>
  );
}
