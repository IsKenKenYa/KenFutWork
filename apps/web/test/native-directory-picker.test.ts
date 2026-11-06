// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServerDirectoryPicker,
  NativeDirectoryPickerUnavailableError,
} from "../src/components/workbench/zcode/host/directoryPicker";
import { openFolderFromWorkspaceEntry } from "../src/components/workbench/zcode/root/openWorkspaceFolderEntry";

vi.mock("@zui/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("openFolderFromWorkspaceEntry 用系统文件夹选择器", () => {
  it("选中路径后直接绑定项目，不再打开自定义目录浏览器", async () => {
    const onSelectProject = vi.fn();
    const openDirectoryBrowser = vi.fn();

    await openFolderFromWorkspaceEntry({
      selectDirectory: async () => "D:/work/demo",
      openDirectoryBrowser,
      onSelectProject,
    });

    expect(onSelectProject).toHaveBeenCalledWith("D:/work/demo");
    expect(openDirectoryBrowser).not.toHaveBeenCalled();
  });

  it("只有原生对话框不可用时才回落目录浏览器", async () => {
    const onSelectProject = vi.fn();
    const openDirectoryBrowser = vi.fn();

    await openFolderFromWorkspaceEntry({
      selectDirectory: async () => {
        throw new NativeDirectoryPickerUnavailableError("no native dialog");
      },
      openDirectoryBrowser,
      onSelectProject,
    });

    expect(openDirectoryBrowser).toHaveBeenCalledTimes(1);
    expect(onSelectProject).not.toHaveBeenCalled();
  });

  it("用户取消是正常操作：不降级、不绑定", async () => {
    const onSelectProject = vi.fn();
    const openDirectoryBrowser = vi.fn();

    await openFolderFromWorkspaceEntry({
      selectDirectory: async () => null,
      openDirectoryBrowser,
      onSelectProject,
    });

    expect(onSelectProject).not.toHaveBeenCalled();
    expect(openDirectoryBrowser).not.toHaveBeenCalled();
  });
});

describe("createServerDirectoryPicker", () => {
  it("先探测可用性，选中后返回绝对路径", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ available: true }))
      .mockResolvedValueOnce(
        Response.json({ status: "picked", path: "D:/work/demo" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createServerDirectoryPicker()()).resolves.toBe(
      "D:/work/demo",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/api/system/pick-directory",
    );
  });

  it("服务端报告不可用时抛出可降级错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ available: false, reason: "no native dialog" }),
        ),
    );

    await expect(createServerDirectoryPicker()()).rejects.toBeInstanceOf(
      NativeDirectoryPickerUnavailableError,
    );
  });

  it("取消返回 null，不抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ available: true }))
        .mockResolvedValueOnce(Response.json({ status: "cancelled" })),
    );

    await expect(createServerDirectoryPicker()()).resolves.toBeNull();
  });
});
