import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MacWorkspaceTitlebarSpace } from "../src/components/workbench/zcode/host/MacWorkspaceTitlebarSpace";

it("macOS 右侧无会话时只保留可拖动的面板边缘", () => {
  const html = renderToStaticMarkup(<MacWorkspaceTitlebarSpace />);
  const page = new DOMParser().parseFromString(html, "text/html");
  const region = page.body.firstElementChild;
  expect(region?.classList.contains("[app-region:drag]")).toBe(true);
  expect(region?.classList.contains("w-full")).toBe(true);
  expect(region?.classList.contains("h-1")).toBe(true);
  expect(region?.getAttribute("aria-hidden")).toBe("true");
  expect(region?.hasAttribute("tabindex")).toBe(false);
});

it("无宿主顶栏的视图只在需要给悬浮窗控让位时预留一行", () => {
  const html = renderToStaticMarkup(
    <MacWorkspaceTitlebarSpace reserveOverlay />,
  );
  const page = new DOMParser().parseFromString(html, "text/html");
  expect(page.body.firstElementChild?.classList.contains("h-13")).toBe(true);
});

it("全屏时不占用主区", () => {
  expect(renderToStaticMarkup(<MacWorkspaceTitlebarSpace fullscreen />)).toBe(
    "",
  );
});
