import { useZCodeIntl as original } from "@zui-original/i18n/IntlProvider.js";
import { useMemo } from "react";

export type { IntlInstance } from "@zui-original/i18n/IntlProvider.js";
export { ZCodeIntlProvider } from "@zui-original/i18n/IntlProvider.js";

const labels: Record<string, [string, string]> = {
  "kenfutwork.cua.screenshot": ["截取画面", "Capture image"],
  "kenfutwork.cua.focusWindow": ["激活窗口", "Focus window"],
  "kenfutwork.cua.listDisplays": ["查看显示器", "List displays"],
  "kenfutwork.cua.listBackends": ["查看控制后端", "List control backends"],
  "kenfutwork.cua.selectBackend": ["切换控制后端", "Switch control backend"],
  "kenfutwork.message.openBrowserFailed": [
    "请检查系统默认浏览器后重试",
    "Check the system default browser and try again",
  ],
  "kenfutwork.message.browserSettingUnreadable": [
    "浏览器设置无法读取，请右键选择打开方式",
    "Browser setting unavailable. Right-click to choose how to open the link.",
  ],
};

/** 宿主扩展动作的短标签；原语言状态与其它翻译继续使用原Provider。 */
export function useZCodeIntl(): ReturnType<typeof original> {
  const context = original();
  const intl = useMemo(
    () => ({
      formatMessage: (...args: Parameters<typeof context.intl.formatMessage>) =>
        labels[args[0].id]?.[context.locale === "zh-CN" ? 0 : 1] ??
        context.intl.formatMessage(...args),
    }),
    [context.intl, context.locale],
  );
  return { ...context, intl };
}
