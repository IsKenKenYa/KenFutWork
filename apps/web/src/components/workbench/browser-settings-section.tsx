"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** 浏览器设置：Agent 浏览器行为偏好（本机持久化，workbench 专属）。 */
interface BrowserSettings {
  searchEngine: "google" | "bing" | "duckduckgo" | "baidu";
  allowAgentControl: boolean;
  headless: boolean;
}

const STORAGE_KEY = "workbench:browser-settings";

const DEFAULT_SETTINGS: BrowserSettings = {
  searchEngine: "google",
  allowAgentControl: false,
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
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-3">
      <span>
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted-foreground/30"
        }`}
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

export function BrowserSettingsSection() {
  const [settings, setSettings] = useState<BrowserSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  const update = (patch: Partial<BrowserSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };

  return (
    <section aria-label="浏览器设置">
      <h3 className="mb-1 text-base font-medium">浏览器</h3>
      <p className="mb-2 text-sm text-muted-foreground">
        控制 Agent 使用浏览器的方式（搜索、自动化与运行形态）。
      </p>

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
              update({ searchEngine: next as BrowserSettings["searchEngine"] });
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

      <div className="divide-y">
        <Toggle
          label="允许 Agent 控制浏览器"
          hint="开启后 Agent 可以代你点击、输入与滚动页面"
          checked={settings.allowAgentControl}
          onChange={(allowAgentControl) => update({ allowAgentControl })}
        />
        <Toggle
          label="无头浏览器"
          hint="在后台无界面运行浏览器，不打断当前操作"
          checked={settings.headless}
          onChange={(headless) => update({ headless })}
        />
      </div>
    </section>
  );
}
