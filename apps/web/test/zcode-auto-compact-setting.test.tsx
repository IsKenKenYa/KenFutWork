// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostInstanceAutoCompactSetting } from "../src/components/workbench/zcode/host/InstanceAutoCompactSetting";

/**
 * ZCode 设置 → 通用：上下文自动压缩（宿主件，T4）。
 *
 * 数据面是服务端实例设置缝（instance_settings.autoCompactEnabled）：
 * 读 GET /api/instance/settings、写 PATCH 同端点，失败回滚——与旧设置弹窗
 * 「模型」页同一字段，不造第二份真相。
 */

function stubInstanceSettings({
  autoCompactEnabled = true,
  patchError,
}: {
  autoCompactEnabled?: boolean;
  patchError?: string;
} = {}) {
  const requests: Array<{ method: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ method, body });
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (path !== "/api/instance/settings")
        return json({ error: { message: "not found" } }, 404);
      if (method === "PATCH") {
        if (patchError) return json({ error: { message: patchError } }, 400);
        return json({
          settings: {
            autoCompactEnabled: (body as { autoCompactEnabled: boolean })
              .autoCompactEnabled,
          },
        });
      }
      return json({
        settings: {
          terminalShell: "auto",
          defaultModel: "",
          autoCompactEnabled,
        },
      });
    }),
  );
  return requests;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("通用分区：上下文自动压缩（服务端实例设置缝）", () => {
  it("读服务端真值呈现；点开关 PATCH 只送这一个字段", async () => {
    const requests = stubInstanceSettings({ autoCompactEnabled: true });
    render(<HostInstanceAutoCompactSetting />);
    const user = userEvent.setup();

    const toggle = await screen.findByRole("switch", {
      name: "上下文自动压缩",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);
    await waitFor(() =>
      expect(requests).toContainEqual({
        method: "PATCH",
        body: { autoCompactEnabled: false },
      }),
    );
    expect(
      screen.getByRole("switch", { name: "上下文自动压缩" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("写入失败回滚开关，服务端原因原样透出", async () => {
    stubInstanceSettings({ autoCompactEnabled: true, patchError: "写入失败" });
    render(<HostInstanceAutoCompactSetting />);
    const user = userEvent.setup();

    const toggle = await screen.findByRole("switch", {
      name: "上下文自动压缩",
    });
    await user.click(toggle);

    expect(
      await screen.findByRole("switch", { name: "上下文自动压缩" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByText("写入失败")).toBeVisible();
  });

  it("读取期间开关禁用（不摆可点的假开关）", async () => {
    stubInstanceSettings();
    render(<HostInstanceAutoCompactSetting />);
    expect(
      screen.getByRole("switch", { name: "上下文自动压缩" }),
    ).toBeDisabled();
    // 服务端真值到达后放行
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "上下文自动压缩" }),
      ).not.toBeDisabled(),
    );
  });
});
