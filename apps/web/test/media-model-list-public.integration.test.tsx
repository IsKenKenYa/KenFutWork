// @vitest-environment node
import "@testing-library/jest-dom/vitest";
import { fileURLToPath } from "node:url";
import { throwPublicHttpError } from "@kenfutwork/shared";
import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { expect, it } from "vitest";
import type { MediaModelInfo } from "../src/components/workbench/zcode/host/media/MediaModelPreferencePopover.js";
import { installCodePublicHostDom } from "./setup/code-public-host-dom.js";

interface ApiFixture {
  baseUrl: string;
  origin: string;
  cookie: string;
  close(): Promise<void>;
}

const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "媒体模型目录拒绝访问时显示处理方式且只重新读取当前标签",
  async () => {
    const http: { createCodeUiHttpFixture(): Promise<ApiFixture> } =
      await import(fixturePath);
    const api = await http.createCodeUiHttpFixture();
    let releaseDom: (() => void) | undefined;
    let view: ReturnType<typeof render> | undefined;
    const reads: Array<[string, number]> = [];
    let authorizeImage = false;
    const load = (kind: "image" | "video") => async (signal?: AbortSignal) => {
      const response = await fetch(`${api.baseUrl}/api/${kind}-models`, {
        ...(signal ? { signal } : {}),
        headers: {
          origin: api.origin,
          connection: "close",
          ...(kind === "video" || authorizeImage ? { cookie: api.cookie } : {}),
        },
      });
      reads.push([kind, response.status]);
      if (!response.ok) return throwPublicHttpError(response);
      return (await response.json()) as { models: MediaModelInfo[] };
    };
    try {
      releaseDom = await installCodePublicHostDom();
      const { MediaModelPreferencePopover } = await import(
        "../src/components/workbench/zcode/host/media/MediaModelPreferencePopover.js"
      );
      const loadImages = load("image");
      const loadVideos = load("video");
      function Panel() {
        const anchor = useRef<HTMLButtonElement>(null);
        return (
          <>
            <button type="button" ref={anchor}>
              媒体模型
            </button>
            <MediaModelPreferencePopover
              open
              anchorRef={anchor}
              onClose={() => undefined}
              loadImages={loadImages}
              loadVideos={loadVideos}
            />
          </>
        );
      }
      view = render(<Panel />);
      expect(await view.findByRole("alert")).toHaveTextContent(
        "本机连接已失效，请从桌面重新打开。",
      );
      expect(view.queryByText(/bearer/i)).toBeNull();
      expect(view.getByRole("button", { name: "自动" })).toBeDisabled();
      fireEvent.click(view.getByRole("button", { name: "视频" }));
      expect(await view.findByText("请在供应商设置中添加模型")).toHaveAttribute(
        "role",
        "status",
      );
      expect(view.queryByRole("alert")).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "图像" }));
      expect(view.getByRole("alert")).toHaveTextContent("连接已失效");

      authorizeImage = true;
      fireEvent.click(view.getByRole("button", { name: "重新读取" }));
      expect(await view.findByText("请在供应商设置中添加模型")).toHaveAttribute(
        "role",
        "status",
      );
      expect(view.queryByRole("alert")).toBeNull();
      expect(view.getByRole("button", { name: "自动" })).toBeEnabled();
      expect(reads.filter(([kind]) => kind === "image")).toEqual([
        ["image", 401],
        ["image", 200],
      ]);
      expect(reads.filter(([kind]) => kind === "video")).toEqual([
        ["video", 200],
      ]);
    } finally {
      view?.unmount();
      releaseDom?.();
      await api.close();
    }
  },
  30_000,
);
