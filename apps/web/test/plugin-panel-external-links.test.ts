import { afterEach, describe, expect, it, vi } from "vitest";
import { installPanelExternalLinks } from "@/lib/plugin-panels";

function panelFrame(html: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const doc = frame.contentDocument;
  if (!doc) throw new Error("iframe document unavailable");
  doc.open();
  doc.write(html);
  doc.close();
  return frame;
}

describe("插件面板外链", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("target=_blank 的 http 外链交给外部打开，不留在面板内", () => {
    const frame = panelFrame(
      '<a id="oauth" href="https://example.com/oauth?x=1" target="_blank">打开授权页</a>',
    );
    const open = vi.fn();
    installPanelExternalLinks(frame, open);
    const anchor = frame.contentDocument?.getElementById("oauth");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor?.dispatchEvent(event);
    expect(open).toHaveBeenCalledWith("https://example.com/oauth?x=1");
    expect(event.defaultPrevented).toBe(true);
  });

  it("相对链接与 target=_self 不拦截；重复安装不重复触发", () => {
    const frame = panelFrame(
      '<a id="rel" href="/local">本地</a><a id="self" href="https://example.com/x">同窗</a>',
    );
    const open = vi.fn();
    installPanelExternalLinks(frame, open);
    installPanelExternalLinks(frame, open);
    const doc = frame.contentDocument;
    doc
      ?.getElementById("rel")
      ?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    doc
      ?.getElementById("self")
      ?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    expect(open).not.toHaveBeenCalled();
  });
});
