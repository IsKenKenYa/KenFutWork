import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useClientScenesResource } from "../src/components/workbench/zcode/hooks/useClientScenesResource";

type ClientScenesService = Parameters<typeof useClientScenesResource>[0];

const originalVisibility = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "visibilityState",
);

afterEach(() => {
  cleanup();
  if (originalVisibility) {
    Object.defineProperty(
      Document.prototype,
      "visibilityState",
      originalVisibility,
    );
  }
  vi.unstubAllGlobals();
});

function Probe({ service }: { service: ClientScenesService }) {
  const { scenes, error } = useClientScenesResource(service);
  return (
    <div>
      <span data-testid="scenes">{scenes.length}</span>
      <span data-testid="error">{error ? error.name : "none"}</span>
    </div>
  );
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(Document.prototype, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

it("宿主返回业务失败后不再响应 focus 与可见性恢复重验", async () => {
  const list = vi.fn(async () => ({
    code: 501,
    msg: "本机实例未提供客户端场景目录",
    data: [],
  }));
  const service = { list } as unknown as ClientScenesService;

  render(<Probe service={service} />);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.getByTestId("error").textContent).toBe(
      "ClientScenesBusinessError",
    ),
  );
  expect(screen.getByTestId("scenes").textContent).toBe("0");

  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(list).toHaveBeenCalledTimes(1);

  act(() => {
    setVisibility("hidden");
    setVisibility("visible");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(list).toHaveBeenCalledTimes(1);
});
