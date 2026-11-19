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

const toastMock = vi.fn();
vi.mock("@zui/components/ui/toast.js", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
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

  it("选择器失败要让用户看见：toast 出可读原因，不静默回落", async () => {
    const onSelectProject = vi.fn();
    const openDirectoryBrowser = vi.fn();

    await openFolderFromWorkspaceEntry({
      selectDirectory: async () => {
        throw new Error("HTTP 500");
      },
      openDirectoryBrowser,
      onSelectProject,
    });

    // 本机实测：dev 代理 socket hang up 回 500，旧实现只写日志，点「打开文件夹」
    // 就是没反应。失败必须出现在界面上。
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(String(toastMock.mock.calls[0]?.[0])).toContain("打开文件夹失败");
    expect(String(toastMock.mock.calls[0]?.[0])).toContain("HTTP 500");
    expect(openDirectoryBrowser).not.toHaveBeenCalled();
    expect(onSelectProject).not.toHaveBeenCalled();
  });

  it("取消与「不可用回落」都不弹错误提示", async () => {
    await openFolderFromWorkspaceEntry({
      selectDirectory: async () => null,
      onSelectProject: vi.fn(),
    });
    await openFolderFromWorkspaceEntry({
      selectDirectory: async () => {
        throw new NativeDirectoryPickerUnavailableError("no native dialog");
      },
      openDirectoryBrowser: vi.fn(),
      onSelectProject: vi.fn(),
    });

    expect(toastMock).not.toHaveBeenCalled();
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

    await expect(createServerDirectoryPicker()()).resolves.toBe("D:/work/demo");
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
