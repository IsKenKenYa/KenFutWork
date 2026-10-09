"use client";

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFlowHostEntry } from "../src/hooks/use-flow-host";

/**
 * `useFlowHostEntry` 的发布纪律：两路探针（插件安装态 + 宿主状态）**都落定后
 * 一次性发布**；中途的「插件已答、状态未答」不得给出 available=false 的中间态——
 * 工作台的兜底跳转会据此把 ?mode=flow 改写成 design（真机踩到：Flow 模式一秒后被弹回）。
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
  frontendUrl: "http://127.0.0.1:8090",
  reasons: [],
};

function Harness() {
  const { entry } = useFlowHostEntry();
  return (
    <span data-testid="entry">
      {entry === null ? "loading" : entry.available ? "available" : "blocked"}
    </span>
  );
}

describe("useFlowHostEntry", () => {
  it("两路探针未全部落定前保持 loading（插件先答、状态未答不给 blocked 中间态）", async () => {
    const status = deferred();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/plugins"))
        return Response.json({
          plugins: [{ name: "kenfutwork-flow", installed: true }],
        });
      if (url.includes("/api/flow/host/status")) return await status.promise;
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<Harness />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // 插件探针已答（fetch 已发），但状态探针还没落定：entry 必须仍是 loading
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

  it("状态未配齐（settled）→ blocked，理由透出（fail loud，不摆空壳）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/plugins"))
          return Response.json({
            plugins: [{ name: "kenfutwork-flow", installed: true }],
          });
        if (url.includes("/api/flow/host/status"))
          return Response.json({
            enabled: false,
            frontendUrl: null,
            reasons: ["未配置 Flow 网关共享密钥。"],
          });
        return Response.json({});
      }),
    );

    const view = render(<Harness />);
    await waitFor(() =>
      expect(view.getByTestId("entry").textContent).toBe("blocked"),
    );
  });
});
