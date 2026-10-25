"use client";

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkHostEntry } from "../src/hooks/use-work-host";

/**
 * `useWorkHostEntry` 的发布纪律（同 useFlowHostEntry，真机踩过）：两路探针
 * （插件安装态 + 宿主状态）**都落定后一次性发布**；中途的「插件已答、状态未答」
 * 不得给出 available=false 的中间态——父页兜底会据此把 ?mode=work 错误回落成 code。
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
  registeredEditors: 12,
  reasons: [],
};

function Harness() {
  const { entry } = useWorkHostEntry();
  return (
    <span data-testid="entry">
      {entry === null ? "loading" : entry.available ? "available" : "blocked"}
    </span>
  );
}

describe("useWorkHostEntry", () => {
  it("两路探针未全部落定前保持 loading（插件先答、状态未答不给 blocked 中间态）", async () => {
    const status = deferred();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/plugins"))
        return Response.json({
          plugins: [
            { name: "kenfutwork-work", installed: true, enabled: true },
          ],
        });
      if (url.includes("/api/work/host/status")) return await status.promise;
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

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

  it("work 插件未安装 → blocked（入口纪律：不摆空壳）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/plugins")) return Response.json({ plugins: [] });
        if (url.includes("/api/work/host/status"))
          return Response.json(READY_STATUS);
        return Response.json({});
      }),
    );
    const view = render(<Harness />);
    await waitFor(() =>
      expect(view.getByTestId("entry").textContent).toBe("blocked"),
    );
  });

  it("插件已装已启用 + 探针可用 → available；探针 404 按不可用处理", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/plugins"))
          return Response.json({
            plugins: [
              { name: "kenfutwork-work", installed: true, enabled: true },
            ],
          });
        if (url.includes("/api/work/host/status"))
          return new Response("not found", { status: 404 });
        return Response.json({});
      }),
    );
    const view = render(<Harness />);
    await waitFor(() =>
      expect(view.getByTestId("entry").textContent).toBe("blocked"),
    );
  });
});
