// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingScreen } from "../src/components/loading-screen";
import { RootStartupLoading } from "../src/components/workbench/zcode/root/RootStartupLoading";
import { InstanceThemeSync } from "../src/lib/instance-theme";

const host = vi.hoisted(() => ({
  theme: "system",
  instance: {},
  unstableSetTheme: false,
  setTheme: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    theme: host.theme,
    setTheme: host.unstableSetTheme
      ? (value: string) => host.setTheme(value)
      : host.setTheme,
  }),
}));
vi.mock("../src/lib/local-instance-context", () => ({
  useLocalInstance: () => ({ instance: host.instance }),
}));
vi.mock("../src/lib/server-api", () => ({
  fetchInstanceSettings: host.fetchSettings,
  updateInstanceSettings: host.updateSettings,
}));

afterEach(() => {
  cleanup();
  host.theme = "system";
  host.unstableSetTheme = false;
  host.setTheme.mockReset();
  host.fetchSettings.mockReset();
  host.updateSettings.mockReset();
  localStorage.clear();
});

describe("InstanceThemeSync", () => {
  it("从实例设置恢复主题并写首屏缓存，不回写同值", async () => {
    host.fetchSettings.mockResolvedValue({ settings: { theme: "zai-dark" } });
    const view = render(<InstanceThemeSync />);

    await waitFor(() => expect(host.setTheme).toHaveBeenCalledWith("dark"));
    act(() => {
      host.theme = "dark";
      view.rerender(<InstanceThemeSync />);
    });
    expect(localStorage.getItem("zcode-theme")).toBe("zai-dark");
    expect(host.updateSettings).not.toHaveBeenCalled();
  });

  it("慢读取不覆盖读取期间的用户新选择，按新选择写回", async () => {
    let finish: ((value: { settings: { theme: string } }) => void) | undefined;
    host.fetchSettings.mockImplementation(
      () =>
        new Promise<{ settings: { theme: string } }>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<InstanceThemeSync />);
    act(() => {
      host.theme = "dark";
      view.rerender(<InstanceThemeSync />);
    });
    await act(async () => finish?.({ settings: { theme: "zai-light" } }));
    view.rerender(<InstanceThemeSync />);

    await waitFor(() =>
      expect(host.updateSettings).toHaveBeenCalledWith(null, {
        theme: "zai-dark",
      }),
    );
    expect(host.setTheme).not.toHaveBeenCalled();
  });

  it("setTheme 引用变化不重新水合并覆盖用户选择", async () => {
    host.unstableSetTheme = true;
    host.fetchSettings.mockResolvedValue({ settings: { theme: "system" } });
    host.updateSettings.mockResolvedValue({ settings: { theme: "zai-dark" } });
    const view = render(<InstanceThemeSync />);
    await waitFor(() => expect(host.fetchSettings).toHaveBeenCalledTimes(1));

    act(() => {
      host.theme = "dark";
      view.rerender(<InstanceThemeSync />);
    });
    await waitFor(() =>
      expect(host.updateSettings).toHaveBeenCalledWith(null, {
        theme: "zai-dark",
      }),
    );
    expect(host.fetchSettings).toHaveBeenCalledTimes(1);
  });

  it("连续切换串行写入，后一档不会被先一档的迟到响应覆盖", async () => {
    host.fetchSettings.mockResolvedValue({ settings: { theme: "system" } });
    const completions: Array<() => void> = [];
    host.updateSettings.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          completions.push(resolve);
        }),
    );
    const view = render(<InstanceThemeSync />);
    await waitFor(() => expect(host.fetchSettings).toHaveBeenCalledTimes(1));

    act(() => {
      host.theme = "dark";
      view.rerender(<InstanceThemeSync />);
    });
    await waitFor(() => expect(host.updateSettings).toHaveBeenCalledTimes(1));
    act(() => {
      host.theme = "light";
      view.rerender(<InstanceThemeSync />);
    });
    expect(host.updateSettings).toHaveBeenCalledTimes(1);

    act(() => completions[0]?.());
    await waitFor(() => expect(host.updateSettings).toHaveBeenCalledTimes(2));
    act(() => completions[1]?.());
    await waitFor(() =>
      expect(localStorage.getItem("zcode-theme")).toBe("zai-light"),
    );
    expect(host.updateSettings.mock.calls.map((call) => call[1])).toEqual([
      { theme: "zai-dark" },
      { theme: "zai-light" },
    ]);
  });

  it("读取失败保留当前外观且不擅自覆盖未知库值", async () => {
    host.fetchSettings.mockRejectedValue(new Error("offline"));
    render(<InstanceThemeSync />);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("主题读取失败"),
    );
    expect(host.updateSettings).not.toHaveBeenCalled();
    expect(host.setTheme).not.toHaveBeenCalled();
  });

  it("保存失败给出可读错误", async () => {
    host.fetchSettings.mockResolvedValue({ settings: { theme: "system" } });
    host.updateSettings.mockRejectedValue(new Error("read only"));
    const view = render(<InstanceThemeSync />);
    await waitFor(() => expect(host.fetchSettings).toHaveBeenCalledTimes(1));
    act(() => {
      host.theme = "dark";
      view.rerender(<InstanceThemeSync />);
    });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("主题保存失败"),
    );
  });

  it("暗色加载图标换品牌色剪影，旋转圈使用语义前景而非固定黑色", () => {
    const { container } = render(
      <>
        <LoadingScreen />
        <RootStartupLoading label="加载" />
      </>,
    );
    for (const image of container.querySelectorAll("img")) {
      expect(image.className).toContain("brand-mark");
    }
    for (const spinner of container.querySelectorAll(".animate-spin")) {
      expect(spinner.getAttribute("style")).toBeNull();
      expect(spinner.className).toContain("border-");
    }
  });
});
