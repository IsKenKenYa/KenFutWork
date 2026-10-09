"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  clearHistory,
  loadHistory,
  parseImportedHistory,
  saveHistory,
} from "@/lib/browser-history";
import {
  type BrowserOpenTarget,
  getBrowserOpenTarget,
  setBrowserOpenTarget,
} from "@/lib/browser-panel";
import {
  type CdpStatusView,
  connectCdp,
  disconnectCdp,
  fetchCdpStatus,
  fetchPermissionSettings,
  updatePermissionSettings,
} from "@/lib/server-api";
import {
  SETTINGS_CONTROL_WIDTH,
  SETTINGS_ROW_MIN_HEIGHT,
  SETTINGS_SECTION_GAP,
  SETTINGS_TITLE,
} from "@/lib/settings-layout";

/**
 * 浏览器设置（R5-4 按参考图分区：内置浏览器 / 外部浏览器 / 通用）。
 *
 * **连接到 Chrome 走 CDP**（不是浏览器扩展）：服务端用调试端口启动一个**独立 profile**
 * 的浏览器实例并连上它，于是能拿到真实渲染后的 DOM、截图、点击与输入。这里把边界写清楚：
 * 连的是新开的窗口，不动你日常那个浏览器，也拿不到你已登录的会话。
 *
 * 仍然如实说明：右栏浏览器是跨源 iframe，站点 cookie / 缓存读不到也清不掉——
 * 「清除 / 导入」操作的是**本面板自己的历史**（打开过的地址）。
 */
interface BrowserSettings {
  searchEngine: "google" | "bing" | "duckduckgo" | "baidu";
}

const STORAGE_KEY = "workbench:browser-settings";

const DEFAULT_SETTINGS: BrowserSettings = {
  searchEngine: "google",
};

const SEARCH_ENGINES: Array<{
  value: BrowserSettings["searchEngine"];
  label: string;
}> = [
  { value: "google", label: "Google" },
  { value: "bing", label: "Bing" },
  { value: "duckduckgo", label: "DuckDuckGo" },
  { value: "baidu", label: "百度" },
];

const OPEN_TARGETS: Array<{ value: BrowserOpenTarget; label: string }> = [
  { value: "panel", label: "内置浏览器" },
  { value: "system", label: "外部浏览器" },
];

function loadSettings(): BrowserSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as BrowserSettings) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: BrowserSettings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 存储失败不阻塞设置
  }
}

/**
 * 单个开关行：标签 + 开关。**没有副标题**——复述标签的副标题按 2026-09-27 口径一律不写；
 * 时机这类一句话事实走操作回执（`setMessage`），不常驻在行里。
 */
function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center justify-between gap-4 px-3 py-2 ${SETTINGS_ROW_MIN_HEIGHT}`}
    >
      <span className="text-sm">
        {label}
        {disabled ? (
          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            暂不可用
          </span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted-foreground/30"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
            checked ? "left-[1.125rem]" : "left-0.5"
          }`}
        />
      </button>
    </label>
  );
}

export function BrowserSettingsSection({
  accessToken = null,
}: {
  accessToken?: string | null;
}) {
  const [settings, setSettings] = useState<BrowserSettings>(DEFAULT_SETTINGS);
  const [openTarget, setOpenTarget] = useState<BrowserOpenTarget>("panel");
  const [agentControl, setAgentControl] = useState(false);
  const [historyCount, setHistoryCount] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  /** CDP 连接状态（R5-4「连接到 Chrome」）。 */
  const [cdp, setCdp] = useState<CdpStatusView | null>(null);
  const [cdpBusy, setCdpBusy] = useState(false);
  const [browserAutoScreenshot, setBrowserAutoScreenshot] = useState(false);
  /**
   * 「允许 AI 读取开发者工具数据」：面板里的悬浮控制台采集到的控制台日志 / 页面报错 /
   * 网络请求，agent 能不能读（默认开，见迁移 20260918100000）。
   */
  const [browserDevtoolsRead, setBrowserDevtoolsRead] = useState(true);
  const [browserEval, setBrowserEval] = useState(false);
  const [browserHeadless, setBrowserHeadless] = useState(false);

  useEffect(() => {
    setSettings(loadSettings());
    setOpenTarget(getBrowserOpenTarget());
    setHistoryCount(loadHistory().entries.length);
  }, []);

  // 「允许 AI 控制浏览器」「自动截图」「无头」都是服务端开关（工具门控必须在服务端生效）
  useEffect(() => {

    let cancelled = false;
    fetchPermissionSettings(accessToken)
      .then((view) => {
        if (cancelled) return;
        setAgentControl(view.browserControlEnabled);
        setBrowserAutoScreenshot(view.browserAutoScreenshot ?? false);
        setBrowserDevtoolsRead(view.browserDevtoolsReadEnabled ?? true);
        setBrowserEval(view.browserEvalEnabled ?? false);
        setBrowserHeadless(view.browserHeadless ?? false);
      })
      .catch(() => {
        // 读不到就保持关闭（宁严勿松）
      });
    fetchCdpStatus(accessToken)
      .then((status) => {
        if (!cancelled) setCdp(status);
      })
      .catch(() => {
        // 读不到就显示未连接
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const cdpConnect = async () => {

    setCdpBusy(true);
    setMessage(null);
    try {
      const status = await connectCdp(accessToken);
      setCdp(status);
      setMessage(
        status.status === "connected"
          ? "已连接"
          : status.status === "error"
            ? status.message
            : "连接中…",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "连接失败");
    } finally {
      setCdpBusy(false);
    }
  };

  const cdpDisconnect = async () => {

    setCdpBusy(true);
    try {
      setCdp(await disconnectCdp(accessToken));
      setMessage("已断开");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "断开失败");
    } finally {
      setCdpBusy(false);
    }
  };

  /** 服务端开关（自动截图 / 无头 / 开发者工具数据 / 页面执行脚本）：先写库再改界面，失败回滚。 */
  const toggleServerFlag = async (
    key:
      | "browserAutoScreenshot"
      | "browserHeadless"
      | "browserDevtoolsReadEnabled"
      | "browserEvalEnabled",
    next: boolean,
  ) => {

    const setter =
      key === "browserAutoScreenshot"
        ? setBrowserAutoScreenshot
        : key === "browserHeadless"
          ? setBrowserHeadless
          : key === "browserEvalEnabled"
            ? setBrowserEval
            : setBrowserDevtoolsRead;
    setter(next);
    try {
      const view = await updatePermissionSettings(accessToken, { [key]: next });
      setBrowserAutoScreenshot(view.browserAutoScreenshot ?? false);
      setBrowserHeadless(view.browserHeadless ?? false);
      setBrowserDevtoolsRead(view.browserDevtoolsReadEnabled ?? true);
      setBrowserEval(view.browserEvalEnabled ?? false);
      setMessage(
        key === "browserAutoScreenshot"
          ? next
            ? "已开启自动截图"
            : "已关闭自动截图"
          : key === "browserHeadless"
            ? next
              ? "已设为后台运行（下次连接生效）"
              : "已设为有窗口（下次连接生效）"
            : key === "browserEvalEnabled"
              ? next
                ? "已允许 AI 在页面执行脚本"
                : "已禁止 AI 在页面执行脚本"
              : next
                ? "已允许 AI 读取开发者工具数据"
                : "已禁止 AI 读取开发者工具数据",
      );
    } catch (error) {
      setter(!next);
      setMessage(error instanceof Error ? error.message : "保存失败");
    }
  };

  const update = (patch: Partial<BrowserSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };

  const toggleAgentControl = async (next: boolean) => {

    setMessage(null);
    try {
      const view = await updatePermissionSettings(accessToken, {
        browserControlEnabled: next,
      });
      setAgentControl(view.browserControlEnabled);
      setMessage(
        view.browserControlEnabled
          ? "已允许 Agent 读网页（browser_open）"
          : "已关闭 Agent 的浏览器控制",
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    }
  };

  const handleImport = async (file: File) => {
    const text = await file.text();
    const parsed = parseImportedHistory(text);
    if (!parsed) {
      setMessage("导入失败：文件不是本面板导出的历史。");
      return;
    }
    saveHistory(parsed);
    setHistoryCount(parsed.entries.length);
    setMessage(`已导入 ${parsed.entries.length} 条面板历史`);
  };

  const cdpLabel =
    cdp === null
      ? "读取中…"
      : cdp.status === "connected"
        ? `已连接（${cdp.headless ? "后台" : "有窗口"}）`
        : cdp.status === "connecting"
          ? "连接中…"
          : cdp.status === "error"
            ? "连接失败"
            : "未连接";

  return (
    <section aria-label="浏览器设置" className={SETTINGS_SECTION_GAP}>
      <div>
        <h3 className={SETTINGS_TITLE}>内置浏览器</h3>
        <div className="divide-y rounded-lg border">
          <Toggle
            label="允许 AI 控制浏览器"
            checked={agentControl}
            onChange={(next) => void toggleAgentControl(next)}
          />
          <div
            className={`flex flex-wrap items-center justify-between gap-3 px-3 py-2 ${SETTINGS_ROW_MIN_HEIGHT}`}
          >
            <span className="flex items-center gap-2">
              <span className="text-sm">浏览器数据</span>
              <span className="text-xs text-muted-foreground">
                {historyCount} 条
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <label className="cursor-pointer rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground">
                导入…
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  aria-label="导入浏览器历史"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleImport(file);
                    event.target.value = "";
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  clearHistory();
                  setHistoryCount(0);
                  setMessage("已清除面板历史");
                }}
                className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
              >
                清除
              </button>
            </span>
          </div>
        </div>
      </div>

      <div>
        <h3 className={SETTINGS_TITLE}>外部浏览器</h3>
        <div className="rounded-lg border px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground">{cdpLabel}</span>
            <span className="flex items-center gap-2">
              {cdp?.status === "connected" ? (
                <button
                  type="button"
                  onClick={() => void cdpDisconnect()}
                  disabled={cdpBusy}
                  className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-40"
                >
                  断开
                </button>
              ) : (
                <button
                  type="button"
                  disabled={cdpBusy || !accessToken}
                  onClick={() => void cdpConnect()}
                  className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50"
                >
                  {cdpBusy ? "连接中…" : "连接到 Chrome"}
                </button>
              )}
            </span>
          </div>
          {cdp?.status === "connected" ? (
            <div className="mt-1 text-xs text-muted-foreground">
              {cdp.browser} · {cdp.tabs} 个标签
              {cdp.currentUrl && cdp.currentUrl !== "about:blank"
                ? ` · 当前 ${cdp.currentUrl}`
                : ""}
            </div>
          ) : null}
          {cdp?.status === "error" ? (
            <div className="mt-1 text-xs text-destructive">{cdp.message}</div>
          ) : null}
        </div>
      </div>

      <div>
        <h3 className={SETTINGS_TITLE}>通用</h3>
        <div className="divide-y rounded-lg border">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: 控件是内嵌的 Base UI SelectTrigger（自定义组件），规则无法静态识别包裹关联 */}
          <label
            className={`flex w-full items-center justify-between gap-4 px-3 py-2 ${SETTINGS_ROW_MIN_HEIGHT}`}
          >
            <span className="text-sm">默认搜索引擎</span>
            <Select
              value={settings.searchEngine}
              onValueChange={(next) => {
                if (typeof next === "string") {
                  update({
                    searchEngine: next as BrowserSettings["searchEngine"],
                  });
                }
              }}
              items={SEARCH_ENGINES.map((e) => ({
                value: e.value,
                label: e.label,
              }))}
            >
              <SelectTrigger
                aria-label="默认搜索引擎"
                className={SETTINGS_CONTROL_WIDTH}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEARCH_ENGINES.map((engine) => (
                  <SelectItem key={engine.value} value={engine.value}>
                    {engine.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {/* biome-ignore lint/a11y/noLabelWithoutControl: 同上一处（内嵌自定义 SelectTrigger） */}
          <label
            className={`flex w-full items-center justify-between gap-4 px-3 py-2 ${SETTINGS_ROW_MIN_HEIGHT}`}
          >
            <span className="text-sm">AI 任务默认浏览器</span>
            <Select
              value={openTarget}
              onValueChange={(next) => {
                if (typeof next !== "string") return;
                setOpenTarget(next as BrowserOpenTarget);
                setBrowserOpenTarget(next as BrowserOpenTarget);
              }}
              items={OPEN_TARGETS.map((t) => ({
                value: t.value,
                label: t.label,
              }))}
            >
              <SelectTrigger
                aria-label="AI 任务默认浏览器"
                className={SETTINGS_CONTROL_WIDTH}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPEN_TARGETS.map((target) => (
                  <SelectItem key={target.value} value={target.value}>
                    {target.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <Toggle
            label="无头浏览器"
            checked={browserHeadless}
            onChange={(next) => void toggleServerFlag("browserHeadless", next)}
          />
          <Toggle
            label="自动截图"
            checked={browserAutoScreenshot}
            onChange={(next) =>
              void toggleServerFlag("browserAutoScreenshot", next)
            }
          />
          <Toggle
            label="允许 AI 读取开发者工具数据"
            checked={browserDevtoolsRead}
            onChange={(next) =>
              void toggleServerFlag("browserDevtoolsReadEnabled", next)
            }
          />
          <Toggle
            label="允许 AI 在页面执行脚本"
            checked={browserEval}
            onChange={(next) =>
              void toggleServerFlag("browserEvalEnabled", next)
            }
          />
        </div>
      </div>

      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  );
}
