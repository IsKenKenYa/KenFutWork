"use client";

import {
  type CodeUiBootstrap,
  codeUiParentRequestSchema,
  type ExecutionMode,
  type HostNewTaskRequest,
  type ManagementTarget,
  type WorkbenchMode,
  type WorkbenchModes,
} from "@kenfutwork/shared";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoadingScreen } from "@/components/loading-screen";
import { triggerDownload } from "@/lib/download";
import { getServerBaseUrl } from "@/lib/env";
import { toNextTheme } from "@/lib/instance-theme";
import { LOCAL_ACCESS_LOST_EVENT } from "@/lib/local-access";
import { useLocalInstance } from "@/lib/local-instance-context";
import {
  PLUGIN_INVENTORY_CHANGED_EVENT,
  type PluginPanelEntry,
  PluginPanelOverlay,
  usePluginPanels,
} from "@/lib/plugin-panels";

const DEFAULT_MODES: WorkbenchModes = ["code", "design"];

/** Code 的独立原文档保护 Design 的 CSS、theme 与 portal。 */
export function CodeWorkbenchFrame({
  mode,
  active = true,
  onOpenManagement,
  availableModes = DEFAULT_MODES,
  canvasId,
  newTaskRequest,
}: {
  /** 当前工作台模式（深链解析结果）；融合后 Design/Flow 是壳内视图，由这里推给壳。 */
  mode?: WorkbenchMode;
  active?: boolean;
  onOpenManagement?: (target: ManagementTarget) => void;
  availableModes?: WorkbenchModes;
  canvasId?: string;
  /** 管理文档转来的新任务意图；id 变化时推送一次（壳负责建草稿）。 */
  newTaskRequest?: { id: number; prompt: string; executionMode: ExecutionMode };
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // 本地实例的主人即当前用户（DEC-20 免账户）：bootstrap 带给 Code 壳，
  // 侧栏底部显示用户而不是「连接使用」。
  const { instance: localInstance } = useLocalInstance();
  const [activePanel, setActivePanel] = useState<PluginPanelEntry | null>(null);
  // 壳层应用挂载前，由父页这一屏盖住 iframe：启动链路自始至终只有一张加载屏。
  const [shellMounted, setShellMounted] = useState(false);
  const {
    panels,
    refresh: refreshPanels,
    error: panelError,
  } = usePluginPanels(null, "sidebar", "code");
  // 壳层挂了或信号丢了，都不能把用户永久关在加载屏后面：到点放行，露出壳层自己的状态。
  // 15s 是一次性兜底常量（非运行可调治理项），远大于本机冷启动实测耗时。
  useEffect(() => {
    if (shellMounted) return;
    const timer = setTimeout(() => setShellMounted(true), 15_000);
    return () => clearTimeout(timer);
  }, [shellMounted]);
  const panelRequest = useRef(0);
  useEffect(
    () => () => {
      panelRequest.current++;
    },
    [],
  );
  useEffect(() => {
    setActivePanel((current) =>
      current
        ? (panels.find((panel) => panel.id === current.id) ?? null)
        : null,
    );
  }, [panels]);
  const ready = useRef(false);
  // 壳内 React 是否已接住新任务事件（form/报告等入口）。ready 握手早于 Root 渲染，
  // 推送必须等壳内监听器就位，否则消息会丢在挂载前的窗口里。
  const [shellReady, setShellReady] = useState(false);
  const workSaves = useRef(new Map<string, Promise<void>>());
  const sentMode = useRef<WorkbenchMode | undefined>(undefined);
  const sendActivity = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      { type: "kenfutwork:workspace-activity", active },
      window.location.origin,
    );
  }, [active]);
  useEffect(sendActivity, [sendActivity]);
  const sendNavigation = useCallback(() => {
    if (!ready.current) return;
    frame.current?.contentWindow?.postMessage(
      {
        type: "kenfutwork:workbench-navigation",
        availableModes,
        ...(mode !== undefined && sentMode.current !== mode ? { mode } : {}),
        ...(canvasId
          ? { documentTarget: { resourceType: "canvas", documentId: canvasId } }
          : {}),
      },
      window.location.origin,
    );
    sentMode.current = mode;
  }, [availableModes, mode, canvasId]);
  useEffect(sendNavigation, [sendNavigation]);
  const bootstrap = useCallback(() => {
    if (!ready.current) return;
    const message: CodeUiBootstrap = {
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
      ...(onOpenManagement ? { managementAvailable: true } : {}),
      workbenchModes: availableModes,
    };
    frame.current?.contentWindow?.postMessage(message, window.location.origin);
  }, [onOpenManagement, availableModes, localInstance]);
  // 管理文档（设置页）发起的创建任务：壳就绪后按其 id 推送一次，避免重复建草稿。
  const sentTaskRequest = useRef(0);
  useEffect(() => {
    if (!shellReady || !newTaskRequest || sentTaskRequest.current === newTaskRequest.id)
      return;
    sentTaskRequest.current = newTaskRequest.id;
    const message: HostNewTaskRequest = {
      type: "kenfutwork:host-new-task",
      prompt: newTaskRequest.prompt,
      executionMode: newTaskRequest.executionMode,
    };
    frame.current?.contentWindow?.postMessage(message, window.location.origin);
  }, [shellReady, newTaskRequest]);
  /**
   * 外观主题桥：设置 → 外观（next-themes，默认跟随系统）解析后的结果同步给 Code iframe
   * （zai 主题口径 zai-light/zai-dark）——没有这座桥，外观切深色时 Code 工作台仍是浅色。
   * 握手响应后立即推一次（iframe 的监听器这时才就位），之后主题变化实时推。
   */
  const { resolvedTheme, setTheme } = useTheme();
  const themeRef = useRef<"zai-dark" | "zai-light">("zai-light");
  const postTheme = useCallback((theme: "zai-dark" | "zai-light") => {
    themeRef.current = theme;
    localStorage.setItem("zcode-theme", theme);
    frame.current?.contentWindow?.postMessage(
      { type: "kenfutwork:code-theme", theme },
      window.location.origin,
    );
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      const parsed = codeUiParentRequestSchema.safeParse(event.data);
      if (!parsed.success) return;
      if (parsed.data.type === "kenfutwork:work-save") {
        const { saveId, fileName, mimeType, bytes } = parsed.data;
        if (workSaves.current.has(saveId)) return;
        const delivery = (async () => {
          let error: string | null = null;
          let path: string | null = null;
          try {
            path = await triggerDownload(
              fileName,
              new Blob([bytes], {
                type: mimeType ?? "application/octet-stream",
              }),
              { browserFallback: false },
            );
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
          frame.current?.contentWindow?.postMessage(
            {
              type: "kenfutwork:work-save-result",
              saveId,
              ok: !error,
              error,
              path,
            },
            window.location.origin,
          );
        })();
        workSaves.current.set(saveId, delivery);
        void delivery;
      } else if (parsed.data.type === "kenfutwork:code-theme-change") {
        setTheme(toNextTheme(parsed.data.theme));
      } else if (parsed.data.type === "kenfutwork:open-management") {
        if (active) onOpenManagement?.(parsed.data.target);
      } else if (parsed.data.type === "kenfutwork:code-plugins-changed")
        window.dispatchEvent(new Event(PLUGIN_INVENTORY_CHANGED_EVENT));
      else if (parsed.data.type === "kenfutwork:code-open-plugin") {
        if (!active) return;
        const { pluginId, entryId } = parsed.data;
        const current = ++panelRequest.current;
        // 聚焦的并发读可使本次读取过期；仅补读库存，不重复写入。
        void refreshPanels()
          .then((entries) =>
            current === panelRequest.current
              ? (entries ?? refreshPanels())
              : null,
          )
          .then((entries) => {
            if (current !== panelRequest.current) return;
            setActivePanel(
              entries?.find(
                (entry) =>
                  entry.pluginId === pluginId && entry.entryId === entryId,
              ) ?? null,
            );
          });
      } else if (parsed.data.type === "kenfutwork:code-access-lost")
        window.dispatchEvent(new Event(LOCAL_ACCESS_LOST_EVENT));
      else if (parsed.data.type === "kenfutwork:code-mounted")
        setShellMounted(true);
      else if (parsed.data.type === "kenfutwork:code-ready") {
        ready.current = true;
        setShellReady(true);
        bootstrap();
        // iframe 的主题监听器这时才就位，补推当前外观主题
        postTheme(themeRef.current);
        sendActivity();
        sendNavigation();
      }
    };
    window.addEventListener("message", receive);
    bootstrap();
    return () => {
      window.removeEventListener("message", receive);
    };
  }, [
    bootstrap,
    refreshPanels,
    active,
    sendActivity,
    onOpenManagement,
    sendNavigation,
    postTheme,
    setTheme,
  ]);
  useEffect(() => {
    const zcodeTheme = resolvedTheme === "dark" ? "zai-dark" : "zai-light";
    postTheme(zcodeTheme);
  }, [postTheme, resolvedTheme]);
  return (
    <>
      <iframe
        ref={frame}
        src="/code-ui/index.html"
        title="Code 工作台"
        className="block h-dvh w-full border-0"
        inert={!active}
        tabIndex={active ? 0 : -1}
      />
      {!shellMounted ? <LoadingScreen /> : null}
      {panelError ? (
        <p
          role="alert"
          className="fixed bottom-14 right-3 text-sm text-destructive"
        >
          {panelError}
        </p>
      ) : null}
      <PluginPanelOverlay
        panel={activePanel}
        active={active}
        onClose={() => {
          panelRequest.current++;
          setActivePanel(null);
        }}
      />
    </>
  );
}
