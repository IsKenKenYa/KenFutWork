"use client";

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOpenDesignHostEntry } from "../src/hooks/use-open-design-host";

/**
 * `useOpenDesignHostEntry` 的门控纪律（与 flow 同一套，走共用 `usePluginHostEntry`）：
 * 两路探针都落定后一次性发布；未安装插件、插件停用、服务不可达都必须 blocked 并给出理由
 * （fail loud，不摆空壳入口）。
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Deferred {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
}

function deferred(): Deferred {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const READY_STATUS = {
  enabled: true,
  frontendUrl: "http://127.0.0.1:7456",
  reasons: [],
};

function Harness() {
  const { entry } = useOpenDesignHostEntry();
  return (
    <span data-testid="entry">
      {entry === null ? "loading" : entry.available ? "available" : "blocked"}
    </span>
  );
}

function stubFetch(options: {
  plugins: Array<{ name: string; installed: boolean; enabled: boolean }>;
  status: () => Promise<Response>;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/plugins"))
      return Response.json({ plugins: options.plugins });
    if (url.includes("/api/open-design/host/status")) return options.status();
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("useOpenDesignHostEntry", () => {
  it("两路探针未全部落定前保持 loading（插件先答、状态未答不给 blocked 中间态）", async () => {
    const status = deferred();
    const fetchMock = stubFetch({
      plugins: [
        { name: "kenfutwork-open-design", installed: true, enabled: true },
      ],
      status: () => status.promise,
    });

    const view = render(<Harness />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.getByTestId("entry").textContent).toBe("loading");

    await act(async () => {
      status.resolve(Response.json(READY_STATUS));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(view.getByTestId("entry").textContent).toBe("available"),
    );
  });

  it("未安装插件 → blocked（入口不出现，理由点名插件市场可装）", async () => {
    stubFetch({
      plugins: [
        { name: "kenfutwork-open-design", installed: false, enabled: false },
      ],
      status: async () => Response.json(READY_STATUS),
    });

    const view = render(<Harness />);
    await waitFor(() =>
      expect(view.getByTestId("entry").textContent).toBe("blocked"),
    );
  });

  it("插件已装但服务不可达 → blocked（理由是服务不通，不是插件缺失）", async () => {
    stubFetch({
      plugins: [
        { name: "kenfutwork-open-design", installed: true, enabled: true },
      ],
      status: async () =>
        Response.json({
          enabled: false,
          frontendUrl: "http://127.0.0.1:7456",
          reasons: ["OpenDesign 服务不可达：connect ECONNREFUSED。"],
        }),
    });

    const view = render(<Harness />);
    await waitFor(() =>
      expect(view.getByTestId("entry").textContent).toBe("blocked"),
    );
  });

  it("状态探针请求失败（HTTP 500）→ blocked（不猜「也许能用」）", async () => {
    stubFetch({
      plugins: [
        { name: "kenfutwork-open-design", installed: true, enabled: true },
      ],
      status: async () => new Response("", { status: 500 }),
    });

    const view = render(<Harness />);
    await waitFor(() =>
      expect(view.getByTestId("entry").textContent).toBe("blocked"),
    );
  });
});
