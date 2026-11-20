import { renderHook, waitFor } from "@testing-library/react";
import { useExecutionModeController } from "@zui/host/ExecutionModeChip.js";
import { afterEach, expect, it, vi } from "vitest";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

it("草稿带 initialMode 时显示创造方式，创建会话后写入该会话而不是退回自主", async () => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") return json({ mode: "creative" });
      if (url.includes("/api/execution-modes/"))
        return json({ mode: "creative" });
      return json({
        modes: [
          { id: "agent", label: "自主" },
          { id: "creative", label: "创造" },
        ],
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const { result, rerender } = renderHook(
    ({ sessionId }: { sessionId: string | null }) =>
      useExecutionModeController({
        sessionId,
        ...(sessionId ? {} : { initialMode: "creative" as const }),
      }),
    { initialProps: { sessionId: null as string | null } },
  );
  await waitFor(() => expect(result.current.mode).toBe("creative"));
  rerender({ sessionId: "session-1" });
  await waitFor(() => expect(result.current.mode).toBe("creative"));
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/api/execution-modes/session-1"),
    expect.objectContaining({ method: "PUT" }),
  );
});
