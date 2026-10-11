import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ZCodeIntlProvider, useZCodeIntl } from "@zui/i18n/IntlProvider.js";

const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";

function LocaleProbe() {
  const { locale, localePreference } = useZCodeIntl();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="preference">{localePreference}</span>
    </div>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

test("已存的用户偏好压过挂载方硬编码的 initialLocale（重挂载不闪回中文）", () => {
  window.localStorage.setItem(LOCALE_PREFERENCE_KEY, "en-US");
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <LocaleProbe />
    </ZCodeIntlProvider>,
  );
  expect(screen.getByTestId("locale").textContent).toBe("en-US");
  expect(screen.getByTestId("preference").textContent).toBe("en-US");
});

test("无已存偏好时 initialLocale 仍然生效（宿主默认中文）", () => {
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <LocaleProbe />
    </ZCodeIntlProvider>,
  );
  expect(screen.getByTestId("locale").textContent).toBe("zh-CN");
});

test("宿主弹窗写 localStorage 后同窗口 storage 事件实时切换语言", () => {
  window.localStorage.setItem(LOCALE_PREFERENCE_KEY, "zh-CN");
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <LocaleProbe />
    </ZCodeIntlProvider>,
  );
  expect(screen.getByTestId("locale").textContent).toBe("zh-CN");
  window.localStorage.setItem(LOCALE_PREFERENCE_KEY, "en-US");
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LOCALE_PREFERENCE_KEY,
        newValue: "en-US",
      }),
    );
  });
  expect(screen.getByTestId("locale").textContent).toBe("en-US");
});
