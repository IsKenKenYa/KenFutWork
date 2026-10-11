import { act, cleanup, render, screen } from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { CuaScreenshotSection } from "@zui/ToolCallBlocks/renderers/CuaScreenshotSection.js";
import { afterEach, expect, it, vi } from "vitest";
import { CuaSnapshotReader } from "../src/components/workbench/zcode/host/cuaScreenshotSectionAdapter";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";

const uri =
  "/api/computer-use/snapshots?taskId=00000000-0000-4000-8000-000000000000&digest=" +
  "a".repeat(64);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("图片沿宿主API地址与当前认证取得，凭据不进入图片地址，卸载释放Blob", async () => {
  const fetcher = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response("png-bytes", { headers: { "content-type": "image/png" } }),
  );
  vi.stubGlobal("fetch", fetcher);
  const create = vi.fn((_blob: Blob) => "blob:actual-screenshot");
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const client = new CodeHttpChannelClient({
    apiBase: "https://host.example/",
    accessToken: "fixture-only",
  });
  const read = client.readCuaSnapshot.bind(client);
  const view = render(
    <CuaSnapshotReader value={read}>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <CuaScreenshotSection
          screenshot={{
            dataUrl: uri,
            width: 512,
            height: 512,
            mimeType: "image/png",
            fullScreen: false,
            zoom: false,
            region: null,
            clamped: false,
          }}
        />
      </ZCodeIntlProvider>
    </CuaSnapshotReader>,
  );
  const image = await screen.findByRole("img");
  expect(image.getAttribute("src")).toBe("blob:actual-screenshot");
  expect(view.container.innerHTML).not.toContain("fixture-only");
  expect(fetcher.mock.calls[0]).toEqual([
    `https://host.example${uri}`,
    expect.objectContaining({
      credentials: "include",
      headers: { authorization: "Bearer fixture-only" },
      redirect: "error",
      cache: "no-store",
    }),
  ]);
  expect(await create.mock.calls[0]?.[0]?.text()).toBe("png-bytes");
  view.unmount();
  expect(revoke).toHaveBeenCalledWith("blob:actual-screenshot");
  client.dispose();
});

it("拒绝外部引用和未认证/非PNG响应，宿主关闭取消在途读取", async () => {
  const fetcher = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response("denied", { status: 401 }),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  const controller = new AbortController();
  await expect(
    client.readCuaSnapshot(
      `https://untrusted.example${uri}`,
      controller.signal,
    ),
  ).rejects.toThrow("截图引用无效");
  expect(fetcher).not.toHaveBeenCalled();
  await expect(client.readCuaSnapshot(uri, controller.signal)).rejects.toThrow(
    "截图已不可用",
  );
  fetcher.mockResolvedValueOnce(
    new Response("html", { headers: { "content-type": "text/html" } }),
  );
  await expect(client.readCuaSnapshot(uri, controller.signal)).rejects.toThrow(
    "截图已不可用",
  );
  const request = fetcher.mock.calls[0]?.[1];
  expect(request?.signal?.aborted).toBe(false);
  client.dispose();
  expect(request?.signal?.aborted).toBe(true);
});

it("切换截图时取消旧读取，迟到回包不能覆盖新图", async () => {
  const pending: Array<{ signal: AbortSignal; resolve: (blob: Blob) => void }> =
    [];
  const read = (_uri: string, signal: AbortSignal) =>
    new Promise<Blob>((resolve) => pending.push({ signal, resolve }));
  const create = vi.fn(() => "blob:new-shot");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    },
  );
  const content = (dataUrl: string) => (
    <CuaSnapshotReader value={read}>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <CuaScreenshotSection
          screenshot={{
            dataUrl,
            width: 512,
            height: 512,
            mimeType: "image/png",
            fullScreen: false,
            zoom: false,
            region: null,
            clamped: false,
          }}
        />
      </ZCodeIntlProvider>
    </CuaSnapshotReader>
  );
  const view = render(content(uri));
  view.rerender(content(uri.replace("a".repeat(64), "b".repeat(64))));
  expect(pending[0]?.signal.aborted).toBe(true);
  await act(async () => {
    pending[1]?.resolve(new Blob(["new"]));
    pending[0]?.resolve(new Blob(["old"]));
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("img").getAttribute("src")).toBe("blob:new-shot");
});
