// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installDesktopExternalLinks,
  openExternal,
  revealPath,
  saveFileToDownloads,
} from "../src/lib/desktop-system";

/**
 * 桌面壳的**系统缝**桥（下载落盘 / Finder 定位 / 外链交给系统浏览器）。
 *
 * 锁两件事：① Web 形态全部 no-op（不能因为缺 Tauri 全局就抛）；
 * ② 发给 Rust 的命令名与参数形状（`save_file` / `reveal_path` / `open_external`，
 * 字节以 base64 传递）——Rust 侧的函数名一旦对不上，桌面形态只会静默失效。
 */
describe("desktop-system（桌面系统缝桥）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI__");
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    Reflect.deleteProperty(window, "__kfwExternalLinksInstalled");
  });

  /** 装上 Tauri 全局并返回可断言的 invoke（返回值放宽成 unknown，便于按用例声明）。 */
  const installTauri = () => {
    const invoke = vi.fn(
      async (
        _command: string,
        _args?: Record<string, unknown>,
      ): Promise<unknown> => undefined,
    );
    Reflect.set(window, "__TAURI__", { core: { invoke } });
    return invoke;
  };

  it("Web 形态：全部 no-op（save 返回 null，定位/外链不抛）", async () => {
    await expect(
      saveFileToDownloads("a.png", new ArrayBuffer(2)),
    ).resolves.toBeNull();
    await expect(revealPath("/tmp/a.png")).resolves.toBeUndefined();
    await expect(openExternal("https://example.com")).resolves.toBeUndefined();
    // 外链接管不安装（没有 Tauri 全局时是纯 no-op）
    installDesktopExternalLinks();
    expect(window.__kfwExternalLinksInstalled).toBeUndefined();
  });

  it("桌面形态：save_file 带 base64 字节，成功后可定位", async () => {
    const invoke = installTauri();
    invoke.mockResolvedValueOnce("/Users/me/Downloads/hi.png");

    const data = new TextEncoder().encode("hi").buffer;
    await expect(saveFileToDownloads("hi.png", data)).resolves.toBe(
      "/Users/me/Downloads/hi.png",
    );
    expect(invoke).toHaveBeenNthCalledWith(1, "save_file", {
      name: "hi.png",
      dataBase64: "aGk=",
    });

    await revealPath("/Users/me/Downloads/hi.png");
    await openExternal("https://example.com/docs");
    expect(invoke).toHaveBeenNthCalledWith(2, "reveal_path", {
      path: "/Users/me/Downloads/hi.png",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "open_external", {
      url: "https://example.com/docs",
    });
  });

  it("外链接管：拦截 target=_blank 的 http(s) 外链，放过相对链接", async () => {
    const invoke = installTauri();
    installDesktopExternalLinks();

    const external = document.createElement("a");
    external.setAttribute("href", "https://example.com/docs");
    external.setAttribute("target", "_blank");
    document.body.append(external);
    const prevented = !external.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(prevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith("open_external", {
      url: "https://example.com/docs",
    });

    // 应用内相对链接照常走本页导航（不 preventDefault、不 invoke）
    invoke.mockClear();
    const internal = document.createElement("a");
    internal.setAttribute("href", "/workbench");
    internal.setAttribute("target", "_blank");
    document.body.append(internal);
    const internalPrevented = !internal.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(internalPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();

    // 幂等：第二次调用不再叠加监听（外链只 invoke 一次）
    invoke.mockClear();
    installDesktopExternalLinks();
    external.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
