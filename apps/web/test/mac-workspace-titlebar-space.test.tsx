import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MacWorkspaceTitlebarSpace } from "../src/components/workbench/zcode/host/MacWorkspaceTitlebarSpace";

it("macOS 右侧没有会话标题时保留整行窗口拖动区域", () => {
  const html = renderToStaticMarkup(<MacWorkspaceTitlebarSpace />);
  const page = new DOMParser().parseFromString(html, "text/html");
  const region = page.body.firstElementChild;
  expect(region?.classList.contains("[app-region:drag]")).toBe(true);
  expect(region?.classList.contains("w-full")).toBe(true);
  expect(
    region?.classList.contains("h-[var(--workspace-mac-titlebar-height)]"),
  ).toBe(true);
  expect(region?.getAttribute("aria-hidden")).toBe("true");
  expect(region?.hasAttribute("tabindex")).toBe(false);
});

it("已有会话标题时只留窗口边距，全屏时不占用主区", () => {
  const html = renderToStaticMarkup(<MacWorkspaceTitlebarSpace hasHeader />);
  const page = new DOMParser().parseFromString(html, "text/html");
  expect(page.body.firstElementChild?.classList.contains("h-1")).toBe(true);
  expect(renderToStaticMarkup(<MacWorkspaceTitlebarSpace fullscreen />)).toBe(
    "",
  );
});
