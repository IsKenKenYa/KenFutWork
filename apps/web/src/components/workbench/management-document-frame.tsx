"use client";

import {
  type CodeUiBootstrap,
  codeUiParentRequestSchema,
  type ManagementTarget,
  managementNavigationSchema,
} from "@kenfutwork/shared";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";
import { getServerBaseUrl } from "@/lib/env";
import { toNextTheme } from "@/lib/instance-theme";
import { LOCAL_ACCESS_LOST_EVENT } from "@/lib/local-access";
import { useLocalInstance } from "@/lib/local-instance-context";
import { PLUGIN_INVENTORY_CHANGED_EVENT } from "@/lib/plugin-panels";

/**
 * 独立管理文档（设置/插件市场）。父页 keep-alive 复用同一 iframe——重复打开
 * 不重载；换目标经 `kenfutwork:management-target` 推送（文档内切换分区/页面）。
 * 关闭走文档内「返回工作区」（onBack → management-close）；不提供外置关闭按钮
 * （用户口径：右边的关闭按钮去掉）。
 */
export function ManagementDocumentFrame({
  target,
  visible,
  onClose,
}: {
  target: ManagementTarget;
  /** keep-alive 模式：false 时隐藏不卸载（避免下次打开整文档重载）。 */
  visible: boolean;
  onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // 本地实例主人（DEC-20 免账户）：与 Code 壳同一份用户，管理页底部显示
  // 「本地用户」而不是「连接使用」。
  const { instance: localInstance } = useLocalInstance();
  const { resolvedTheme, setTheme } = useTheme();
  const themeRef = useRef<"zai-dark" | "zai-light">("zai-light");
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      const parsed = codeUiParentRequestSchema.safeParse(event.data);
      if (!parsed.success) return;
      if (parsed.data.type === "kenfutwork:code-ready") {
        const bootstrap: CodeUiBootstrap = {
          type: "kenfutwork:code-bootstrap",
          apiBase: new URL(
            getServerBaseUrl() || window.location.origin,
            window.location.origin,
          )
            .toString()
            .replace(/\/$/, ""),
          user: localInstance
            ? {
                id: localInstance.instanceId,
                username: "local",
                displayName: "本地用户",
              }
            : null,
          management: target,
        };
        frame.current?.contentWindow?.postMessage(
          bootstrap,
          window.location.origin,
        );
        frame.current?.contentWindow?.postMessage(
          { type: "kenfutwork:code-theme", theme: themeRef.current },
          window.location.origin,
        );
      } else if (parsed.data.type === "kenfutwork:code-theme-change") {
        setTheme(toNextTheme(parsed.data.theme));
      } else if (parsed.data.type === "kenfutwork:management-close") onClose();
      else if (parsed.data.type === "kenfutwork:code-plugins-changed")
        window.dispatchEvent(new Event(PLUGIN_INVENTORY_CHANGED_EVENT));
      else if (parsed.data.type === "kenfutwork:code-access-lost")
        window.dispatchEvent(new Event(LOCAL_ACCESS_LOST_EVENT));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [target, onClose, localInstance, setTheme]);

  // 与 Code 壳共用父页的实例主题；ready 握手会补发当前值，避免预加载时丢消息。
  useEffect(() => {
    const theme = resolvedTheme === "dark" ? "zai-dark" : "zai-light";
    themeRef.current = theme;
    frame.current?.contentWindow?.postMessage(
      { type: "kenfutwork:code-theme", theme },
      window.location.origin,
    );
  }, [resolvedTheme]);

  // 打开期间目标变化（例：设置→插件市场）：推给文档内切换，不重载。
  useEffect(() => {
    if (!visible) return;
    frame.current?.contentWindow?.postMessage(
      managementNavigationSchema.parse({
        type: "kenfutwork:management-target",
        target,
      }),
      window.location.origin,
    );
  }, [target, visible]);

  return (
    <iframe
      ref={frame}
      title="管理设置"
      src="/code-ui/index.html?document=management"
      hidden={!visible}
      className="fixed inset-0 z-40 h-dvh w-full border-0"
    />
  );
}
