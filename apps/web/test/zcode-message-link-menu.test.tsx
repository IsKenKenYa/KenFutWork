import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MessageResponse } from "@zui/components/ai-elements/message.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { afterEach, expect, it } from "vitest";

afterEach(cleanup);

it("剪贴板不可用时报告失败，不打开链接", async () => {
  expect(navigator.clipboard).toBeUndefined();
  const opened: string[] = [];
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <MessageResponse
        theme="light"
        onOpenExternalUrl={(href) => opened.push(href)}
      >
        {"[Link](https://example.com/docs?q=one#part)"}
      </MessageResponse>
    </ZCodeIntlProvider>,
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: "Link" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "复制链接" }));
  expect(screen.getByRole("status").textContent).toBe("请检查剪贴板权限后重试");
  expect(opened).toEqual([]);
});

it.each([
  ["zh-CN", "在工作台中打开", "在浏览器中打开", "复制链接"],
  ["en-US", "Open in workbench", "Open in browser", "Copy link"],
] as const)(
  "%s 的消息链接菜单区分打开与复制",
  async (locale, internal, external, copy) => {
    const url = "https://example.com/docs?q=one%20two#part";
    const opened: string[] = [];
    render(
      <ZCodeIntlProvider initialLocale={locale}>
        <MessageResponse
          theme="light"
          onOpenExternalUrl={(href) => opened.push(href)}
        >
          {`[Link](${url})`}
        </MessageResponse>
      </ZCodeIntlProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Link" }));
    const menu = within(await screen.findByRole("menu"));
    expect(
      menu.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([internal, external, copy]);
    expect(menu.getAllByRole("separator")).toHaveLength(1);
    fireEvent.click(menu.getByRole("menuitem", { name: internal }));
    expect(opened).toEqual([url]);
  },
);
