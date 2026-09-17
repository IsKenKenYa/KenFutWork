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
  getBrowserOpenTarget,
  type BrowserOpenTarget,
  setBrowserOpenTarget,
} from "@/lib/browser-panel";
import {
  clearHistory,
  loadHistory,
  parseImportedHistory,
  saveHistory,
} from "@/lib/browser-history";
import {
  fetchPermissionSettings,
  updatePermissionSettings,
} from "@/lib/server-api";

/**
 * 浏览器设置（R5-4 按参考图分区：内置浏览器 / 外部浏览器 / 通用）。
 *
 * 三条如实说明的边界（都是「做不到就说清楚」而不是摆假开关）：
 * - **站点 cookie / 缓存**：右栏浏览器是跨源 iframe，读不到也清不掉它的存储——
 *   「清除 / 导入」操作的是**本面板自己的历史**（打开过的地址）；
 * - **外部浏览器（连接到 Chrome）**：需要浏览器扩展提供调试通道，当前未提供，
 *   这里只做状态说明，替代路径是「在系统浏览器打开」；
 * - **自动截图**：需要浏览器调试协议（CDP），服务端没有该通道，故按参考图列出来但置灰。
 */
interface BrowserSettings {
  searchEngine: "google" | "bing" | "duckduckgo" | "baidu";
  headless: boolean;
}

const STORAGE_KEY = "workbench:browser-settings";

const DEFAULT_SETTINGS: BrowserSettings = {
  searchEngine: "google",
  headless: true,
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
  { value: "panel", label: "右栏浏览器面板" },
  { value: "system", label: "系统浏览器（新标签页）" },
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

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-3">
      <span>
        <span className="block text-sm">
          {label}
          {disabled ? (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              暂不可用
            </span>
          ) : null}
        </span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
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

  useEffect(() => {
    setSettings(loadSettings());
    setOpenTarget(getBrowserOpenTarget());
    setHistoryCount(loadHistory().entries.length);
  }, []);

  // 「允许 AI 控制浏览器」是服务端开关（工具门控必须在服务端生效）
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    fetchPermissionSettings(accessToken)
      .then((view) => {
        if (!cancelled) setAgentControl(view.browserControlEnabled);
      })
      .catch(() => {
        // 读不到就保持关闭（宁严勿松）
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const update = (patch: Partial<BrowserSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };

  const toggleAgentControl = async (next: boolean) => {
    if (!accessToken) return;
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
      setMessage("导入失败：文件不是本面板导出的历史（JSON），或里面没有地址。");
      return;
    }
    saveHistory(parsed);
    setHistoryCount(parsed.entries.length);
    setMessage(`已导入 ${parsed.entries.length} 条面板历史`);
  };

  return (
    <section aria-label="浏览器设置">
      <h3 className="mb-1 text-base font-medium">内置浏览器</h3>
      <p className="mb-2 text-sm text-muted-foreground">
        右栏「浏览器」标签里那个面板（对话里点链接会开在这里）。
      </p>
      <div className="divide-y">
        <Toggle
          label="允许 AI 控制浏览器"
          hint="开启后 Agent 可以用 browser_open 读网页内容（静态快照：脚本渲染与登录态页面读不到）"
          checked={agentControl}
          onChange={(next) => void toggleAgentControl(next)}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          <span>
            <span className="block text-sm">浏览器数据</span>
            <span className="block text-xs text-muted-foreground">
              面板历史（本机保存，共 {historyCount} 条）。站点 cookie / 缓存属于跨源
              iframe，读不到也清不掉——这里只清本面板自己的记录。
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

      <h3 className="mt-5 mb-1 text-base font-medium">外部浏览器</h3>
      <p className="mb-2 text-sm text-muted-foreground">
        「连接到 Chrome」需要浏览器扩展提供调试通道（CDP）；当前版本**未提供扩展**，
        所以这里没有可点的连接键——需要外部浏览器时用右栏浏览器的「在系统浏览器打开」。
      </p>
      <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
        状态：未连接（未安装扩展）
      </div>

      <h3 className="mt-5 mb-1 text-base font-medium">通用</h3>
      <div className="divide-y">
        {/* biome-ignore lint/a11y/noLabelWithoutControl: 控件是内嵌的 Base UI SelectTrigger（自定义组件），规则无法静态识别包裹关联 */}
        <label className="flex items-center justify-between gap-4 py-3">
          <span>
            <span className="block text-sm">默认搜索引擎</span>
            <span className="block text-xs text-muted-foreground">
              Agent 联网检索时使用的搜索引擎
            </span>
          </span>
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
            <SelectTrigger aria-label="默认搜索引擎">
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
        <label className="flex items-center justify-between gap-4 py-3">
          <span>
            <span className="block text-sm">AI 任务默认浏览器</span>
            <span className="block text-xs text-muted-foreground">
              对话里的链接默认在哪里打开
            </span>
          </span>
          <Select
            value={openTarget}
            onValueChange={(next) => {
              if (typeof next !== "string") return;
              setOpenTarget(next as BrowserOpenTarget);
              setBrowserOpenTarget(next as BrowserOpenTarget);
            }}
            items={OPEN_TARGETS.map((t) => ({ value: t.value, label: t.label }))}
          >
            <SelectTrigger aria-label="AI 任务默认浏览器">
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
          hint="在后台无界面运行浏览器，不打断当前操作（本机形态未接无头通道，仅记录偏好）"
          checked={settings.headless}
          onChange={(headless) => update({ headless })}
        />
        <Toggle
          label="自动截图"
          hint="需要浏览器调试协议（CDP）才能截取页面；服务端没有该通道，故暂不可用"
          checked={false}
          disabled
        />
      </div>

      {message ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  );
}
