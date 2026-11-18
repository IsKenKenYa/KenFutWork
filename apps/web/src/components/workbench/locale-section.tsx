"use client";

import { useEffect, useState } from "react";
import { SETTINGS_ROW, SETTINGS_TITLE } from "@/lib/settings-layout";

/**
 * 设置 → 通用 → 界面语言。
 *
 * 语言偏好的唯一属主是 zcode UI 的 i18n（localStorage 键 `zcode-locale-preference`，
 * "system" / "zh-CN" / "en-US"）。这里只写同一个键并派发同源 storage 事件——
 * zcode IntlProvider 监听该事件实时切换；KenFutWork 外壳自身是中文单语，
 * 切到 English 只影响 zcode 工作台内的文案。
 */
const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";
type LocalePreference = "system" | "zh-CN" | "en-US";

function isLocalePreference(value: string | null): value is LocalePreference {
  return value === "system" || value === "zh-CN" || value === "en-US";
}

/** 同源 storage 事件只在「别的窗口」派发；同窗口内的 iframe 收不到，手动补发一次。 */
function notifySameWindowFrames(newValue: LocalePreference) {
  window.dispatchEvent(
    new StorageEvent("storage", { key: LOCALE_PREFERENCE_KEY, newValue }),
  );
}

export function LocaleSection() {
  const [mounted, setMounted] = useState(false);
  const [pref, setPref] = useState<LocalePreference>("system");

  useEffect(() => {
    const raw = window.localStorage.getItem(LOCALE_PREFERENCE_KEY);
    if (isLocalePreference(raw)) setPref(raw);
    setMounted(true);
  }, []);

  const update = (value: LocalePreference) => {
    window.localStorage.setItem(LOCALE_PREFERENCE_KEY, value);
    setPref(value);
    notifySameWindowFrames(value);
  };

  const options = [
    { value: "system", label: "跟随系统" },
    { value: "zh-CN", label: "中文简体" },
    { value: "en-US", label: "English" },
  ] as const;

  return (
    <section aria-label="界面语言设置">
      <h3 className={SETTINGS_TITLE}>界面语言</h3>
      <fieldset className="grid gap-2 sm:grid-cols-3">
        <legend className="sr-only">界面语言</legend>
        {options.map(({ value, label }) => {
          const active = mounted && pref === value;
          return (
            <label
              key={value}
              data-active={active}
              className={`${SETTINGS_ROW} cursor-pointer transition-colors hover:bg-muted/60 data-[active=true]:border-foreground/40 data-[active=true]:bg-muted`}
            >
              <input
                type="radio"
                name="ui-locale"
                value={value}
                checked={active}
                onChange={() => update(value)}
                className="sr-only"
              />
              <span>{label}</span>
            </label>
          );
        })}
      </fieldset>
    </section>
  );
}
