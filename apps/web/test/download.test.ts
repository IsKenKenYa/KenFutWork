// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { triggerDownload } from "../src/lib/download";

/**
 * 统一下载入口的形态分流。
 *
 * 历史 bug：桌面壳的内核是 WKWebView，`<a download>` 点了毫无反应——图片灯箱 /
 * 视频面板 / 画布文件 / 插件导出四处各自内联锚点下载，在桌面形态集体失灵。
 * 这里锁死：桌面形态走 `save_file` + `reveal_path`（落系统下载目录并定位），
 * 浏览器形态维持对象 URL 锚点下载，落盘失败退回锚点。
 */
describe("triggerDownload（统一下载入口）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI__");
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  const installTauri = (
    impl?: (command: string, args?: unknown) => unknown,
  ) => {
    const invoke = vi.fn(impl ?? (async () => undefined));
    Reflect.set(window, "__TAURI__", { core: { invoke } });
    return invoke;
  };

  it("浏览器形态：对象 URL + 锚点下载（不走 save_file）", async () => {
    // 不装 Tauri 全局：isDesktopShell() 为 false，走浏览器分支
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    // jsdom 30.1 自带 createObjectURL（读 jsdom Blob 的内部槽），与 Node 领域的
    // Blob 跨 realm 不兼容——测试里一并 stub，断言只关心「走了对象 URL 这条路」
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => "blob:mock");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});

    await triggerDownload("a.png", new Blob(["x"]));

    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("a.png");
    expect(anchor.href).toMatch(/^blob:/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalled();
  });

  it("桌面形态：save_file 落盘成功 → reveal_path 定位，不创建锚点", async () => {
    const invoke = installTauri(async (command: string) =>
      command === "save_file" ? "/Users/me/Downloads/a.png" : undefined,
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    await triggerDownload("a.png", new Blob(["x"]));

    expect(invoke).toHaveBeenNthCalledWith(1, "save_file", {
      name: "a.png",
      dataBase64: "eA==",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "reveal_path", {
      path: "/Users/me/Downloads/a.png",
    });
    expect(click).not.toHaveBeenCalled();
  });

  it("桌面形态：落盘失败退回锚点下载，不让点击毫无反馈", async () => {
    installTauri(async () => {
      throw new Error("写入下载文件失败");
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await triggerDownload("a.png", new Blob(["x"]));

    expect(click).toHaveBeenCalledTimes(1);
  });
});
