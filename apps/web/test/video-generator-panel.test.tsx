import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoGeneratorPanel } from "../src/components/canvas/video-generator-panel";
import { ToastProvider } from "../src/components/toast";
import type { VideoGeneratorData } from "../src/lib/canvas-video-generator";

// Excalidraw 是外部编辑器边界；保留生成器状态并应用场景更新。
function createGeneratorApi(elementId: string, data: VideoGeneratorData) {
  let elements = [
    { id: elementId, version: 1, isDeleted: false, customData: data },
  ];
  return {
    getSceneElements: () => elements.filter((element) => !element.isDeleted),
    updateScene: (update: { elements: typeof elements }) => {
      elements = update.elements;
    },
  } as unknown as ExcalidrawImperativeAPI;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function frameUploadResponse(
  url: string,
  init?: RequestInit,
): Response | undefined {
  if (url.endsWith("/api/uploads") && init?.body instanceof FormData) {
    const file = init.body.get("file");
    const assetId =
      file instanceof File && file.name === "last.png"
        ? "ffffffff-1111-4111-8111-111111111111"
        : "eeeeeeee-1111-4111-8111-111111111111";
    return Response.json(
      { asset: { id: assetId }, url: `https://assets.example/${assetId}.png` },
      { status: 201 },
    );
  }
  const assetId = url.match(/\/api\/uploads\/([^/]+)\/url$/)?.[1];
  if (assetId)
    return Response.json({ url: `https://assets.example/${assetId}.png` });
  return undefined;
}

it("参考视频上传为素材引用并按模型恢复，生成请求实际发送inputVideo", async () => {
  const firstModel = "11111111-1111-4111-8111-111111111111:kwaivgi/kling-o1";
  const unknownModel = "11111111-1111-4111-8111-111111111111:custom-video";
  const unsupportedModel = "11111111-1111-4111-8111-111111111111:text-video";
  const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
  const assetId = "eeeeeeee-1111-4111-8111-111111111111";
  const uploaded: Array<{
    filename: string;
    projectId: FormDataEntryValue | null;
  }> = [];
  const requests: Array<{ url: string; method: string }> = [];
  let submitted: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    if (String(url).endsWith("/api/video-models"))
      return Response.json({
        models: [
          {
            id: firstModel,
            displayName: "视频编辑",
            provider: "供应商",
            capabilities: { videoToVideo: true, imageToVideo: false },
          },
          { id: unknownModel, displayName: "自定义视频", provider: "供应商" },
          {
            id: unsupportedModel,
            displayName: "文字视频",
            provider: "供应商",
            capabilities: { videoToVideo: false },
          },
        ],
      });
    if (
      String(url).endsWith("/api/uploads") &&
      init?.body instanceof FormData
    ) {
      const file = init.body.get("file");
      if (!(file instanceof File)) throw new Error("缺少上传视频");
      uploaded.push({
        filename: file.name,
        projectId: init.body.get("projectId"),
      });
      return Response.json(
        {
          asset: { id: assetId },
          url: "https://assets.example/upload/source.mp4",
        },
        { status: 201 },
      );
    }
    if (String(url).endsWith(`/api/uploads/${assetId}/url`))
      return Response.json({ url: "https://assets.example/signed/source.mp4" });
    submitted = JSON.parse(String(init?.body));
    return Response.json(
      {
        request_id: "cccccccc-1111-4111-8111-111111111111",
        jobs: [
          { job_id: "dddddddd-1111-4111-8111-111111111111", status: "queued" },
        ],
      },
      { status: 202 },
    );
  });
  const data: VideoGeneratorData = {
    type: "video-generator",
    status: "idle",
    prompt: "把背景改成雪山",
    model: firstModel,
  };
  let elements = [
    {
      id: "generator",
      x: 0,
      y: 0,
      width: 400,
      height: 225,
      version: 1,
      customData: data,
    },
  ];
  const api = {
    getSceneElements: () => elements,
    updateScene: (update: { elements: typeof elements }) => {
      elements = update.elements;
    },
  } as unknown as ExcalidrawImperativeAPI;
  render(
    <ToastProvider>
      <VideoGeneratorPanel
        canvasId="aaaaaaaa-1111-4111-8111-111111111111"
        projectId={projectId}
        prepare={async () => "1"}
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 225 }}
        data={data}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
      />
    </ToastProvider>,
  );
  await screen.findByText("视频编辑");
  fireEvent.change(screen.getByLabelText("参考视频文件"), {
    target: {
      files: [new File(["video"], "source.mp4", { type: "video/mp4" })],
    },
  });
  await waitFor(() =>
    expect(uploaded).toEqual([{ filename: "source.mp4", projectId }]),
  );
  await waitFor(() =>
    expect(elements[0]?.customData).toMatchObject({
      inputVideo: `asset://${assetId}`,
      modelDrafts: { [firstModel]: { inputVideo: `asset://${assetId}` } },
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("参考视频预览").getAttribute("src")).toBe(
      "https://assets.example/signed/source.mp4",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "视频编辑" }));
  fireEvent.click(screen.getByRole("button", { name: "自定义视频" }));
  expect(screen.getByLabelText("参考视频文件").getAttribute("type")).toBe(
    "file",
  );
  expect(screen.queryByLabelText("参考视频预览")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "自定义视频" }));
  fireEvent.click(screen.getByRole("button", { name: "文字视频" }));
  expect(screen.queryByLabelText("参考视频文件")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "文字视频" }));
  fireEvent.click(screen.getByRole("button", { name: "视频编辑" }));
  await waitFor(() =>
    expect(screen.getByLabelText("参考视频预览").getAttribute("src")).toBe(
      "https://assets.example/signed/source.mp4",
    ),
  );
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(submitted).toMatchObject({
      model: "kwaivgi/kling-o1",
      inputVideo: `asset://${assetId}`,
    }),
  );
  expect(JSON.stringify(elements[0]?.customData)).not.toMatch(
    /data:video|https:\/\/assets\.example/,
  );
  expect(requests.some((request) => request.method === "DELETE")).toBe(false);
});

it("本地首尾帧上传后只持久素材引用，重开与切模型恢复签名预览", async () => {
  const firstModel = "11111111-1111-4111-8111-111111111111:video-a";
  const secondModel = "11111111-1111-4111-8111-111111111111:video-b";
  const firstAsset = "eeeeeeee-1111-4111-8111-111111111111";
  const lastAsset = "ffffffff-1111-4111-8111-111111111111";
  const otherAsset = "99999999-1111-4111-8111-111111111111";
  const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
  const uploaded: Array<{
    filename: string;
    projectId: FormDataEntryValue | null;
  }> = [];
  const requests: Array<{ url: string; method: string }> = [];
  let submitted: { inputImages?: string[] } | undefined;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    if (String(url).endsWith("/api/video-models"))
      return Response.json({
        models: [
          {
            id: firstModel,
            displayName: "视频 A",
            provider: "供应商",
            videoGeneration: { firstLastFrame: true, referenceImages: 2 },
          },
          {
            id: secondModel,
            displayName: "视频 B",
            provider: "供应商",
            videoGeneration: { firstLastFrame: true, referenceImages: 2 },
          },
        ],
      });
    if (
      String(url).endsWith("/api/uploads") &&
      init?.body instanceof FormData
    ) {
      const file = init.body.get("file");
      if (!(file instanceof File)) throw new Error("缺少上传文件");
      uploaded.push({
        filename: file.name,
        projectId: init.body.get("projectId"),
      });
      const assetId = file.name === "first.png" ? firstAsset : lastAsset;
      return Response.json(
        {
          asset: { id: assetId },
          url: `https://assets.example/upload/${assetId}.png`,
        },
        { status: 201 },
      );
    }
    const assetId = String(url).match(/\/api\/uploads\/([^/]+)\/url$/)?.[1];
    if (assetId)
      return Response.json({
        url: `https://assets.example/preview/${assetId}.png`,
      });
    submitted = JSON.parse(String(init?.body));
    return Response.json(
      {
        request_id: "cccccccc-1111-4111-8111-111111111111",
        jobs: [
          { job_id: "dddddddd-1111-4111-8111-111111111111", status: "queued" },
        ],
      },
      { status: 202 },
    );
  });
  const data: VideoGeneratorData = {
    type: "video-generator",
    status: "idle",
    prompt: "猫",
    model: firstModel,
    modelDrafts: { [secondModel]: { firstFrame: `asset://${otherAsset}` } },
  };
  let elements = [
    {
      id: "generator",
      x: 0,
      y: 0,
      width: 400,
      height: 225,
      version: 1,
      customData: data,
    },
  ];
  const api = {
    getSceneElements: () => elements,
    updateScene: (update: { elements: typeof elements }) => {
      elements = update.elements;
    },
  } as unknown as ExcalidrawImperativeAPI;
  const panel = (saved: VideoGeneratorData) => (
    <ToastProvider>
      <VideoGeneratorPanel
        canvasId="aaaaaaaa-1111-4111-8111-111111111111"
        projectId={projectId}
        prepare={async () => "1"}
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 225 }}
        data={saved}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
      />
    </ToastProvider>
  );
  const firstRender = render(panel(data));
  await screen.findByText("视频 A");
  fireEvent.change(screen.getByLabelText("首帧"), {
    target: {
      files: [new File(["first"], "first.png", { type: "image/png" })],
    },
  });
  fireEvent.change(screen.getByLabelText("尾帧"), {
    target: { files: [new File(["last"], "last.png", { type: "image/png" })] },
  });
  await waitFor(() =>
    expect(uploaded).toEqual([
      { filename: "first.png", projectId },
      { filename: "last.png", projectId },
    ]),
  );
  await waitFor(() =>
    expect(elements[0]?.customData).toMatchObject({
      firstFrame: `asset://${firstAsset}`,
      lastFrame: `asset://${lastAsset}`,
      modelDrafts: {
        [firstModel]: {
          firstFrame: `asset://${firstAsset}`,
          lastFrame: `asset://${lastAsset}`,
        },
      },
    }),
  );
  firstRender.unmount();
  const saved = elements[0]?.customData;
  if (!saved) throw new Error("生成器未保存");
  render(panel(saved));
  await screen.findByText("视频 A");
  await waitFor(() =>
    expect(screen.getByAltText("首帧").getAttribute("src")).toBe(
      `https://assets.example/preview/${firstAsset}.png`,
    ),
  );
  expect(screen.getByAltText("尾帧").getAttribute("src")).toBe(
    `https://assets.example/preview/${lastAsset}.png`,
  );
  fireEvent.click(screen.getByRole("button", { name: "视频 A" }));
  fireEvent.click(screen.getByRole("button", { name: "视频 B" }));
  await waitFor(() =>
    expect(screen.getByAltText("首帧").getAttribute("src")).toBe(
      `https://assets.example/preview/${otherAsset}.png`,
    ),
  );
  expect(screen.queryByAltText("尾帧")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "视频 B" }));
  fireEvent.click(screen.getByRole("button", { name: "视频 A" }));
  await waitFor(() =>
    expect(screen.getByAltText("首帧").getAttribute("src")).toBe(
      `https://assets.example/preview/${firstAsset}.png`,
    ),
  );
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(submitted?.inputImages).toEqual([
      `asset://${firstAsset}`,
      `asset://${lastAsset}`,
    ]),
  );
  expect(JSON.stringify(elements[0]?.customData)).not.toMatch(
    /data:image|https:\/\/assets\.example/,
  );
  expect(requests.some((request) => request.method === "DELETE")).toBe(false);
});

it("未声明模型分辨率不等于仅支持720p", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      models: [
        {
          id: "11111111-1111-4111-8111-111111111111:custom-video",
          displayName: "视频模型",
          provider: "我的供应商",
        },
      ],
    }),
  );
  const data: VideoGeneratorData = {
    type: "video-generator",
    prompt: "一只猫",
    model: "11111111-1111-4111-8111-111111111111:custom-video",
    aspectRatio: "16:9",
    duration: 5,
    resolution: "720p",
    status: "idle",
  };
  const api = createGeneratorApi("generator", data);
  render(
    <ToastProvider>
      <VideoGeneratorPanel
        canvasId="aaaaaaaa-1111-4111-8111-111111111111"
        projectId="bbbbbbbb-1111-4111-8111-111111111111"
        prepare={async () => "1"}
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 225 }}
        data={data}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
      />
    </ToastProvider>,
  );
  await screen.findByText("视频模型");
  fireEvent.click(screen.getByRole("button", { name: /16:9.*5s/ }));
  fireEvent.change(screen.getByLabelText("分辨率"), {
    target: { value: "1080p" },
  });
  expect(
    screen.getByRole("button", { name: /16:9.*5s/ }).textContent,
  ).toContain("1080");
});

it("视频参数与首尾帧随模型恢复，音频和参数实际提交", async () => {
  const firstModel = "11111111-1111-4111-8111-111111111111:video-a";
  const secondModel = "11111111-1111-4111-8111-111111111111:video-b";
  let submitted: unknown;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/video-models"))
      return Response.json({
        models: [
          {
            id: firstModel,
            displayName: "视频 A",
            provider: "供应商",
            videoGeneration: {
              durations: [5, 10],
              aspectRatios: ["16:9", "4:3"],
              resolutions: ["720p", "1080p"],
              firstLastFrame: true,
              referenceImages: 2,
              audio: true,
            },
          },
          {
            id: secondModel,
            displayName: "视频 B",
            provider: "供应商",
            videoGeneration: {
              durations: [4],
              aspectRatios: ["1:1"],
              resolutions: ["480p"],
              firstLastFrame: false,
              referenceImages: 0,
              audio: false,
            },
          },
        ],
      });
    const upload = frameUploadResponse(String(url), init);
    if (upload) return upload;
    submitted = JSON.parse(String(init?.body));
    return Response.json(
      {
        request_id: "cccccccc-1111-4111-8111-111111111111",
        jobs: [
          { job_id: "dddddddd-1111-4111-8111-111111111111", status: "queued" },
        ],
      },
      { status: 202 },
    );
  });
  const data: VideoGeneratorData = {
    type: "video-generator",
    status: "idle",
    prompt: "猫",
    model: firstModel,
    aspectRatio: "16:9",
    duration: 5,
    resolution: "720p",
  };
  const api = createGeneratorApi("generator", data);
  render(
    <ToastProvider>
      <VideoGeneratorPanel
        canvasId="aaaaaaaa-1111-4111-8111-111111111111"
        projectId="bbbbbbbb-1111-4111-8111-111111111111"
        prepare={async () => "1"}
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 225 }}
        data={data}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
      />
    </ToastProvider>,
  );
  await screen.findByText("视频 A");
  fireEvent.click(screen.getByRole("button", { name: /16:9.*5s/ }));
  fireEvent.change(screen.getByLabelText("画幅"), { target: { value: "4:3" } });
  fireEvent.change(screen.getByLabelText("时长"), { target: { value: "10" } });
  fireEvent.change(screen.getByLabelText("分辨率"), {
    target: { value: "1080p" },
  });
  fireEvent.click(screen.getByLabelText("音频"));
  fireEvent.change(screen.getByLabelText("首帧"), {
    target: {
      files: [new File(["first"], "first.png", { type: "image/png" })],
    },
  });
  fireEvent.change(screen.getByLabelText("尾帧"), {
    target: { files: [new File(["last"], "last.png", { type: "image/png" })] },
  });
  await screen.findByAltText("首帧");
  await screen.findByAltText("尾帧");
  fireEvent.click(screen.getByRole("button", { name: "视频 A" }));
  fireEvent.click(screen.getByRole("button", { name: "视频 B" }));
  expect((screen.getByLabelText("音频") as HTMLInputElement).disabled).toBe(
    true,
  );
  expect((screen.getByLabelText("时长") as HTMLSelectElement).value).toBe("4");
  expect(screen.queryByAltText("首帧")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "视频 B" }));
  fireEvent.click(screen.getByRole("button", { name: "视频 A" }));
  expect((screen.getByLabelText("时长") as HTMLSelectElement).value).toBe("10");
  expect((screen.getByLabelText("画幅") as HTMLSelectElement).value).toBe(
    "4:3",
  );
  expect((screen.getByLabelText("分辨率") as HTMLSelectElement).value).toBe(
    "1080p",
  );
  expect((screen.getByLabelText("音频") as HTMLInputElement).checked).toBe(
    true,
  );
  expect(screen.getByAltText("首帧")).toBeTruthy();
  expect(screen.getByAltText("尾帧")).toBeTruthy();
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(submitted).toMatchObject({
      model: "video-a",
      duration: 10,
      aspectRatio: "4:3",
      resolution: "1080p",
      enableAudio: true,
      inputImages: [
        "asset://eeeeeeee-1111-4111-8111-111111111111",
        "asset://ffffffff-1111-4111-8111-111111111111",
      ],
    }),
  );
});

it("目录载入后立即编辑的视频参数不会被旧参数规范化覆盖", async () => {
  const firstModel = "11111111-1111-4111-8111-111111111111:video-a";
  const secondModel = "11111111-1111-4111-8111-111111111111:video-b";
  vi.stubGlobal("fetch", async () =>
    Response.json({
      models: [
        {
          id: firstModel,
          displayName: "视频 A",
          provider: "供应商",
          videoGeneration: { durations: [5, 10], resolutions: ["720p"] },
        },
        {
          id: secondModel,
          displayName: "视频 B",
          provider: "供应商",
          videoGeneration: { durations: [4] },
        },
      ],
    }),
  );
  const data: VideoGeneratorData = {
    type: "video-generator",
    status: "idle",
    prompt: "猫",
    model: firstModel,
    aspectRatio: "16:9",
    duration: 5,
  };
  const api = createGeneratorApi("generator", data);
  let edited = false;
  let editedSnapshot: unknown;
  render(
    <ToastProvider>
      <Profiler
        id="catalog-ready-input"
        onRender={() => {
          const duration = screen.queryByLabelText("时长");
          if (edited || !(duration instanceof HTMLSelectElement)) return;
          // 在目录对应的控件提交后、被动规范化之前输入，固定真实输入与加载交错。
          edited = true;
          duration.value = "10";
          duration.dispatchEvent(new Event("change", { bubbles: true }));
          editedSnapshot = api.getSceneElements()[0]?.customData;
        }}
      >
        <VideoGeneratorPanel
          canvasId="aaaaaaaa-1111-4111-8111-111111111111"
          projectId="bbbbbbbb-1111-4111-8111-111111111111"
          prepare={async () => "1"}
          elementId="generator"
          elementBounds={{ x: 0, y: 0, width: 400, height: 225 }}
          data={data}
          excalidrawApi={api}
          accessToken={null}
          canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        />
      </Profiler>
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /16:9.*5s/ }));
  await screen.findByText("视频 A");
  expect(edited).toBe(true);
  expect(editedSnapshot).toMatchObject({ duration: 10 });
  expect((screen.getByLabelText("时长") as HTMLSelectElement).value).toBe("10");
  expect(api.getSceneElements()[0]?.customData).toMatchObject({
    duration: 10,
    resolution: "720p",
    modelDrafts: { [firstModel]: { duration: 10, resolution: "720p" } },
  });
  fireEvent.click(screen.getByRole("button", { name: "视频 A" }));
  fireEvent.click(screen.getByRole("button", { name: "视频 B" }));
  fireEvent.click(screen.getByRole("button", { name: "视频 B" }));
  fireEvent.click(screen.getByRole("button", { name: "视频 A" }));
  expect((screen.getByLabelText("时长") as HTMLSelectElement).value).toBe("10");
});

it("实例声明的参考图能力优先于旧目录的不支持标记", async () => {
  const model = "11111111-1111-4111-8111-111111111111:custom-video";
  let submitted: { inputImages?: string[] } | undefined;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/video-models"))
      return Response.json({
        models: [
          {
            id: model,
            displayName: "实例视频模型",
            provider: "供应商",
            videoGeneration: { referenceImages: 1, firstLastFrame: false },
            capabilities: { imageToVideo: false },
            limits: {
              maxInputImages: 0,
              maxDuration: 5,
              maxResolution: "720p",
            },
          },
        ],
      });
    const upload = frameUploadResponse(String(url), init);
    if (upload) return upload;
    submitted = JSON.parse(String(init?.body));
    return Response.json(
      {
        request_id: "cccccccc-1111-4111-8111-111111111111",
        jobs: [
          { job_id: "dddddddd-1111-4111-8111-111111111111", status: "queued" },
        ],
      },
      { status: 202 },
    );
  });
  const data: VideoGeneratorData = {
    type: "video-generator",
    status: "idle",
    prompt: "猫",
    model,
    aspectRatio: "16:9",
    duration: 5,
    resolution: "720p",
  };
  const api = createGeneratorApi("generator", data);
  render(
    <ToastProvider>
      <VideoGeneratorPanel
        canvasId="aaaaaaaa-1111-4111-8111-111111111111"
        projectId="bbbbbbbb-1111-4111-8111-111111111111"
        prepare={async () => "1"}
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 225 }}
        data={data}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
      />
    </ToastProvider>,
  );
  await screen.findByText("实例视频模型");
  expect(
    (screen.getByRole("button", { name: "首帧" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.change(screen.getByLabelText("首帧"), {
    target: {
      files: [new File(["reference"], "reference.png", { type: "image/png" })],
    },
  });
  await screen.findByAltText("首帧");
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(submitted?.inputImages).toEqual([
      "asset://eeeeeeee-1111-4111-8111-111111111111",
    ]),
  );
});

it("切到未知模型不注入旧参数或帧，切回恢复已保存的模型草稿", async () => {
  const firstModel = "11111111-1111-4111-8111-111111111111:video-a";
  const secondModel = "11111111-1111-4111-8111-111111111111:unknown-video";
  let submitted: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/video-models"))
      return Response.json({
        models: [
          {
            id: firstModel,
            displayName: "视频 A",
            provider: "供应商",
            videoGeneration: {
              durations: [5],
              aspectRatios: ["16:9"],
              resolutions: ["720p"],
              audio: true,
              firstLastFrame: true,
              referenceImages: 2,
            },
          },
          { id: secondModel, displayName: "未知视频模型", provider: "供应商" },
        ],
      });
    submitted = JSON.parse(String(init?.body));
    return Response.json(
      {
        request_id: "cccccccc-1111-4111-8111-111111111111",
        jobs: [
          { job_id: "dddddddd-1111-4111-8111-111111111111", status: "queued" },
        ],
      },
      { status: 202 },
    );
  });
  const data = {
    type: "video-generator" as const,
    status: "idle" as const,
    prompt: "猫",
    model: firstModel,
    aspectRatio: "16:9",
    duration: 5,
    resolution: "720p",
    enableAudio: true,
    firstFrame: "https://assets.example/first.png",
    lastFrame: "https://assets.example/last.png",
  };
  let elements = [{ id: "generator", version: 1, customData: data }];
  const api = {
    getSceneElements: () => elements,
    updateScene: (update: { elements: typeof elements }) => {
      elements = update.elements;
    },
  } as unknown as ExcalidrawImperativeAPI;
  render(
    <ToastProvider>
      <VideoGeneratorPanel
        canvasId="aaaaaaaa-1111-4111-8111-111111111111"
        projectId="bbbbbbbb-1111-4111-8111-111111111111"
        prepare={async () => "1"}
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 225 }}
        data={data}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
      />
    </ToastProvider>,
  );
  await screen.findByText("视频 A");
  fireEvent.click(screen.getByRole("button", { name: /16:9.*5s/ }));
  fireEvent.click(screen.getByRole("button", { name: "视频 A" }));
  fireEvent.click(screen.getByRole("button", { name: "未知视频模型" }));
  expect((screen.getByLabelText("时长") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("分辨率") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("画幅") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("音频") as HTMLInputElement).disabled).toBe(
    false,
  );
  for (const field of [
    "duration",
    "resolution",
    "aspectRatio",
    "enableAudio",
    "firstFrame",
    "lastFrame",
  ])
    expect(
      JSON.parse(JSON.stringify(elements[0]?.customData)),
    ).not.toHaveProperty(field);
  fireEvent.click(screen.getByRole("button", { name: "未知视频模型" }));
  fireEvent.click(screen.getByRole("button", { name: "视频 A" }));
  expect((screen.getByLabelText("时长") as HTMLSelectElement).value).toBe("5");
  expect((screen.getByLabelText("音频") as HTMLInputElement).checked).toBe(
    true,
  );
  expect(screen.getByAltText("首帧").getAttribute("src")).toBe(
    "https://assets.example/first.png",
  );
  expect(screen.getByAltText("尾帧").getAttribute("src")).toBe(
    "https://assets.example/last.png",
  );
  fireEvent.click(screen.getByRole("button", { name: "视频 A" }));
  fireEvent.click(screen.getByRole("button", { name: "未知视频模型" }));
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() => expect(submitted?.model).toBe("unknown-video"));
  for (const field of [
    "duration",
    "resolution",
    "aspectRatio",
    "enableAudio",
    "inputImages",
  ])
    expect(submitted).not.toHaveProperty(field);
});
