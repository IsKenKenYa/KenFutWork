/**
 * zcode 移植层宿主适配：i18n（references/zcode packages/ui/src/i18n/IntlProvider.tsx 的最小等价）。
 * 我们界面固定中文：locale 恒为 zh-CN，文案表是 zcode zh-CN locale 的整表照搬（同目录 zh-CN.ts），
 * 保证照搬组件的文案与 zcode 逐字一致。setLocale 系列为 no-op。
 */
"use client";

import zhCN from "./zh-CN";

export type Locale = "zh-CN" | "en-US";
export type LocalePreference = "system" | Locale;

/** 简易 intl 工具：根据 id 查找翻译，支持 {key} 占位符替换 */
export interface IntlInstance {
  formatMessage(
    descriptor: { id: string },
    values?: Record<string, string | number>,
  ): string;
}

const intl: IntlInstance = {
  formatMessage({ id }, values) {
    let msg = zhCN[id] ?? id;
    if (values) {
      for (const [key, val] of Object.entries(values)) {
        msg = msg.replaceAll(`{${key}}`, String(val));
      }
    }
    return msg;
  },
};

interface IntlContextValue {
  intl: IntlInstance;
  locale: Locale;
  localePreference: LocalePreference;
  setLocale: (locale: Locale) => void;
  setLocalePreference: (localePreference: LocalePreference) => void;
}

const fixedValue: IntlContextValue = {
  intl,
  locale: "zh-CN",
  localePreference: "zh-CN",
  setLocale: () => {},
  setLocalePreference: () => {},
};

/** 兼容层：zcode 组件挂在 ZCodeIntlProvider 下；这里只是透传。 */
export function ZCodeIntlProvider({ children }: { children: React.ReactNode }) {
  return children;
}

export function useZCodeIntl(): IntlContextValue {
  return fixedValue;
}
