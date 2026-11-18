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
import { ImageGeneratorPanel } from "../src/components/canvas/image-generator-panel";
import { ToastProvider } from "../src/components/toast";
import type { ImageGeneratorData } from "../src/lib/canvas-image-generator";

// Excalidraw 是外部编辑器边界；保留生成器状态并应用场景更新。
function createGeneratorApi(elementId: string, data: ImageGeneratorData) {
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

it("新建生成器自动选择配置中的模型，不提交旧内置默认名", async () => {
  let submitted: unknown;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/image-models"))
      return Response.json({
        models: [
          {
            id: "11111111-1111-4111-8111-111111111111:custom-image",
            displayName: "我的图片模型",
            provider: "我的供应商",
          },
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
  const data: ImageGeneratorData = {
    type: "image-generator",
    status: "idle",
    prompt: "猫",
    model: "google/nano-banana-2",
    aspectRatio: "1:1",
    quality: "hd",
  };
  const api = createGeneratorApi("new-generator", data);
  render(
    <ToastProvider>
      <ImageGeneratorPanel
        canvasId="aaaaaaaa-1111-4111-8111-111111111111"
        projectId="bbbbbbbb-1111-4111-8111-111111111111"
        prepare={async () => "1"}
        elementId="new-generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
        data={data}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
      />
    </ToastProvider>,
  );
  await screen.findByText("我的图片模型");
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(submitted).toMatchObject({
      providerInstanceId: "11111111-1111-4111-8111-111111111111",
      model: "custom-image",
    }),
  );
  for (const field of [
    "aspectRatio",
    "quality",
    "width",
    "height",
    "outputFormat",
  ]) {
    expect(submitted).not.toHaveProperty(field);
  }
});

it("现有图片面板发送用户添加的参考图", async () => {
  let submitted: { inputImages?: string[] } | undefined;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/image-models"))
      return Response.json({
        models: [
          {
            id: "11111111-1111-4111-8111-111111111111:gpt-image-1",
            displayName: "图片模型",
            provider: "我的供应商",
          },
        ],
      });
    if (String(url).endsWith("/api/uploads"))
      return Response.json(
        {
          asset: { id: "eeeeeeee-1111-4111-8111-111111111111" },
          url: "https://assets.example/reference.png",
        },
        { status: 201 },
      );
    if (String(url).includes("/api/uploads/") && String(url).endsWith("/url"))
      return Response.json({ url: "https://assets.example/reference.png" });
    submitted = JSON.parse(String(init?.body));
    return Response.json(
      { error: { code: "test_rejection", message: "测试停止" } },
      { status: 502 },
    );
  });
  // Excalidraw 是外部编辑器边界；测试只提供此工作流消费的接口。
  const data: ImageGeneratorData = {
    type: "image-generator",
    prompt: "一只猫",
    model: "11111111-1111-4111-8111-111111111111:gpt-image-1",
    aspectRatio: "1:1",
    quality: "hd",
    status: "idle",
  };
  const api = createGeneratorApi("generator", data);
  render(
    <ToastProvider>
      <ImageGeneratorPanel
        canvasId="aaaaaaaa-1111-4111-8111-111111111111"
        projectId="bbbbbbbb-1111-4111-8111-111111111111"
        prepare={async () => "1"}
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
        data={data}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
      />
    </ToastProvider>,
  );
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("参考图入口未渲染");
  fireEvent.change(input, {
    target: {
      files: [new File(["image"], "reference.png", { type: "image/png" })],
    },
  });
  await screen.findByAltText("ref");
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(submitted?.inputImages).toEqual([
      "asset://eeeeeeee-1111-4111-8111-111111111111",
    ]),
  );
});

it.each(["gateway", "invalid_json", "prepare"])(
  "%s失败按是否发出生成请求保留跟踪",
  async (failure) => {
    const data = {
      type: "image-generator" as const,
      status: "idle" as const,
      prompt: "猫",
      model: "11111111-1111-4111-8111-111111111111:custom-image",
      aspectRatio: "1:1",
      quality: "hd",
    };
    let elements = [{ id: "generator", version: 1, customData: data }];
    const post = vi.fn(async () =>
      failure === "gateway"
        ? new Response("Gateway timeout", { status: 504 })
        : new Response("truncated", { status: 202 }),
    );
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).endsWith("/api/image-models")
        ? Response.json({
            models: [
              { id: data.model, displayName: "图片模型", provider: "供应商" },
            ],
          })
        : post(),
    );
    const api = {
      getSceneElements: () => elements,
      updateScene: (update: { elements: typeof elements }) => {
        elements = update.elements;
      },
    } as unknown as ExcalidrawImperativeAPI;
    render(
      <ToastProvider>
        <ImageGeneratorPanel
          canvasId="aaaaaaaa-1111-4111-8111-111111111111"
          projectId="bbbbbbbb-1111-4111-8111-111111111111"
          prepare={async () => {
            if (failure === "prepare") throw new TypeError("Network error");
            return "1";
          }}
          elementId="generator"
          elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
          data={data}
          excalidrawApi={api}
          accessToken={null}
          canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        />
      </ToastProvider>,
    );
    await screen.findByText("图片模型");
    fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
      key: "Enter",
    });
    if (failure === "prepare") {
      await waitFor(() => expect(elements[0]?.customData.status).toBe("error"));
      expect(post).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(post).toHaveBeenCalledOnce());
      await screen.findByText(/提交结果待确认/);
      expect(elements[0]?.customData.status).toBe("generating");
    }
  },
);

it("图片参数跟随模型声明，切回模型恢复原参数并原样提交", async () => {
  const firstModel = "11111111-1111-4111-8111-111111111111:image-a";
  const secondModel = "11111111-1111-4111-8111-111111111111:image-b";
  let submitted: unknown;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/image-models"))
      return Response.json({
        models: [
          {
            id: firstModel,
            displayName: "图片 A",
            provider: "供应商",
            imageGeneration: {
              qualities: ["low", "high"],
              sizes: ["1024x1024", "1024x1536"],
              outputFormats: ["png", "webp"],
              aspectRatios: ["1:1", "2:3"],
            },
          },
          {
            id: secondModel,
            displayName: "图片 B",
            provider: "供应商",
            imageGeneration: {
              qualities: ["standard"],
              sizes: ["512x512"],
              outputFormats: ["jpg"],
              aspectRatios: ["1:1"],
            },
          },
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
  const data: ImageGeneratorData = {
    type: "image-generator",
    status: "idle",
    prompt: "猫",
    model: firstModel,
    aspectRatio: "1:1",
    quality: "low",
  };
  const api = createGeneratorApi("generator", data);
  render(
    <ToastProvider>
      <ImageGeneratorPanel
        canvasId="aaaaaaaa-1111-4111-8111-111111111111"
        projectId="bbbbbbbb-1111-4111-8111-111111111111"
        prepare={async () => "1"}
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
        data={data}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
      />
    </ToastProvider>,
  );
  await screen.findByText("图片 A");
  fireEvent.change(screen.getByLabelText("质量"), {
    target: { value: "high" },
  });
  expect((screen.getByLabelText("质量") as HTMLSelectElement).value).toBe(
    "high",
  );
  expect(api.getSceneElements()[0]?.customData).toMatchObject({
    quality: "high",
    modelDrafts: { [firstModel]: { quality: "high" } },
  });
  fireEvent.change(screen.getByLabelText("尺寸"), {
    target: { value: "1024x1536" },
  });
  expect(api.getSceneElements()[0]?.customData).toMatchObject({
    quality: "high",
    size: "1024x1536",
    modelDrafts: {
      [firstModel]: { quality: "high", size: "1024x1536" },
    },
  });
  fireEvent.change(screen.getByLabelText("格式"), {
    target: { value: "webp" },
  });
  expect(api.getSceneElements()[0]?.customData).toMatchObject({
    quality: "high",
    size: "1024x1536",
    outputFormat: "webp",
    modelDrafts: {
      [firstModel]: {
        quality: "high",
        size: "1024x1536",
        outputFormat: "webp",
      },
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "图片 A" }));
  fireEvent.click(screen.getByRole("button", { name: "图片 B" }));
  expect((screen.getByLabelText("质量") as HTMLSelectElement).value).toBe(
    "standard",
  );
  expect(screen.queryByRole("option", { name: "high" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "图片 B" }));
  fireEvent.click(screen.getByRole("button", { name: "图片 A" }));
  expect((screen.getByLabelText("质量") as HTMLSelectElement).value).toBe(
    "high",
  );
  expect((screen.getByLabelText("尺寸") as HTMLSelectElement).value).toBe(
    "1024x1536",
  );
  expect((screen.getByLabelText("格式") as HTMLSelectElement).value).toBe(
    "webp",
  );
  expect(screen.queryByText("2K")).toBeNull();
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(submitted).toMatchObject({
      model: "image-a",
      quality: "high",
      width: 1024,
      height: 1536,
      outputFormat: "webp",
    }),
  );
});

it("目录载入后立即编辑的图片参数不会被旧参数规范化覆盖", async () => {
  const firstModel = "11111111-1111-4111-8111-111111111111:image-a";
  const secondModel = "11111111-1111-4111-8111-111111111111:image-b";
  vi.stubGlobal("fetch", async () =>
    Response.json({
      models: [
        {
          id: firstModel,
          displayName: "图片 A",
          provider: "供应商",
          imageGeneration: {
            qualities: ["low", "high"],
            sizes: ["1024x1024"],
          },
        },
        {
          id: secondModel,
          displayName: "图片 B",
          provider: "供应商",
          imageGeneration: { qualities: ["standard"] },
        },
      ],
    }),
  );
  const data: ImageGeneratorData = {
    type: "image-generator",
    status: "idle",
    prompt: "猫",
    model: firstModel,
    aspectRatio: "1:1",
    quality: "low",
  };
  const api = createGeneratorApi("generator", data);
  let edited = false;
  let editedSnapshot: unknown;
  render(
    <ToastProvider>
      <Profiler
        id="catalog-ready-input"
        onRender={() => {
          const quality = screen.queryByLabelText("质量");
          if (edited || !(quality instanceof HTMLSelectElement)) return;
          // 在目录对应的控件提交后、被动规范化之前输入，固定真实输入与加载交错。
          edited = true;
          quality.value = "high";
          quality.dispatchEvent(new Event("change", { bubbles: true }));
          editedSnapshot = api.getSceneElements()[0]?.customData;
        }}
      >
        <ImageGeneratorPanel
          canvasId="aaaaaaaa-1111-4111-8111-111111111111"
          projectId="bbbbbbbb-1111-4111-8111-111111111111"
          prepare={async () => "1"}
          elementId="generator"
          elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
          data={data}
          excalidrawApi={api}
          accessToken={null}
          canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        />
      </Profiler>
    </ToastProvider>,
  );
  await screen.findByText("图片 A");
  expect(edited).toBe(true);
  expect(editedSnapshot).toMatchObject({ quality: "high" });
  expect((screen.getByLabelText("质量") as HTMLSelectElement).value).toBe(
    "high",
  );
  expect(api.getSceneElements()[0]?.customData).toMatchObject({
    quality: "high",
    size: "1024x1024",
    modelDrafts: { [firstModel]: { quality: "high", size: "1024x1024" } },
  });
  fireEvent.click(screen.getByRole("button", { name: "图片 A" }));
  fireEvent.click(screen.getByRole("button", { name: "图片 B" }));
  fireEvent.click(screen.getByRole("button", { name: "图片 B" }));
  fireEvent.click(screen.getByRole("button", { name: "图片 A" }));
  expect((screen.getByLabelText("质量") as HTMLSelectElement).value).toBe(
    "high",
  );
});

it("模型明确不支持的参数不展示或提交，其他模型草稿仍保留", async () => {
  const firstModel = "11111111-1111-4111-8111-111111111111:image-a";
  const secondModel = "11111111-1111-4111-8111-111111111111:image-b";
  let submitted: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/image-models"))
      return Response.json({
        models: [
          {
            id: firstModel,
            displayName: "图片 A",
            provider: "供应商",
            imageGeneration: {
              qualities: ["high"],
              sizes: ["1024x1536"],
              outputFormats: ["webp"],
            },
          },
          {
            id: secondModel,
            displayName: "图片 B",
            provider: "供应商",
            imageGeneration: {
              qualities: [],
              sizes: [],
              outputFormats: [],
              aspectRatios: [],
            },
          },
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
  const data: ImageGeneratorData = {
    type: "image-generator",
    status: "idle",
    prompt: "猫",
    model: firstModel,
    aspectRatio: "1:1",
    quality: "high",
  };
  const api = createGeneratorApi("generator", data);
  render(
    <ToastProvider>
      <ImageGeneratorPanel
        canvasId="aaaaaaaa-1111-4111-8111-111111111111"
        projectId="bbbbbbbb-1111-4111-8111-111111111111"
        prepare={async () => "1"}
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
        data={data}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
      />
    </ToastProvider>,
  );
  await screen.findByText("图片 A");
  fireEvent.click(screen.getByRole("button", { name: "图片 A" }));
  fireEvent.click(screen.getByRole("button", { name: "图片 B" }));
  for (const label of ["画幅", "质量", "尺寸", "格式"])
    expect(screen.queryByLabelText(label)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "图片 B" }));
  fireEvent.click(screen.getByRole("button", { name: "图片 A" }));
  expect((screen.getByLabelText("质量") as HTMLSelectElement).value).toBe(
    "high",
  );
  expect((screen.getByLabelText("尺寸") as HTMLSelectElement).value).toBe(
    "1024x1536",
  );
  expect((screen.getByLabelText("格式") as HTMLSelectElement).value).toBe(
    "webp",
  );
  fireEvent.click(screen.getByRole("button", { name: "图片 A" }));
  fireEvent.click(screen.getByRole("button", { name: "图片 B" }));
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() => expect(submitted?.model).toBe("image-b"));
  for (const field of [
    "aspectRatio",
    "quality",
    "width",
    "height",
    "outputFormat",
  ])
    expect(submitted).not.toHaveProperty(field);
});

it("添加参考图先保存素材，生成器草稿只保存资产引用", async () => {
  const model = "11111111-1111-4111-8111-111111111111:custom-image";
  const assetId = "eeeeeeee-1111-4111-8111-111111111111";
  const uploadBodies: FormData[] = [];
  let previewRequests = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/image-models"))
      return Response.json({
        models: [
          { id: model, displayName: "图片模型", provider: "供应商" },
          {
            id: "11111111-1111-4111-8111-111111111111:other-image",
            displayName: "其他模型",
            provider: "供应商",
          },
        ],
      });
    if (String(url).endsWith("/api/uploads")) {
      uploadBodies.push(init?.body as FormData);
      return Response.json(
        { asset: { id: assetId }, url: "https://assets.example/reference.png" },
        { status: 201 },
      );
    }
    if (String(url).endsWith(`/api/uploads/${assetId}/url`)) {
      previewRequests += 1;
      return Response.json({
        url: "https://assets.example/refreshed-reference.png",
      });
    }
    throw new Error(`非预期请求 ${String(url)}`);
  });
  const data = {
    type: "image-generator" as const,
    status: "idle" as const,
    prompt: "猫",
    model,
    aspectRatio: "",
    quality: "",
  };
  let elements = [{ id: "generator", version: 1, customData: data }];
  const api = {
    getSceneElements: () => elements,
    updateScene: (update: { elements: typeof elements }) => {
      elements = update.elements;
    },
  } as unknown as ExcalidrawImperativeAPI;
  const show = (currentData: typeof data) =>
    render(
      <ToastProvider>
        <ImageGeneratorPanel
          canvasId="aaaaaaaa-1111-4111-8111-111111111111"
          projectId="bbbbbbbb-1111-4111-8111-111111111111"
          prepare={async () => "1"}
          elementId="generator"
          elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
          data={currentData}
          excalidrawApi={api}
          accessToken={null}
          canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        />
      </ToastProvider>,
    );
  const displayed = show(data);
  await screen.findByText("图片模型");
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("参考图入口未渲染");
  fireEvent.change(input, {
    target: {
      files: [
        new File(["reference bytes"], "reference.png", { type: "image/png" }),
      ],
    },
  });
  await waitFor(() =>
    expect(elements[0]?.customData).toMatchObject({
      inputImages: [`asset://${assetId}`],
      modelDrafts: { [model]: { inputImages: [`asset://${assetId}`] } },
    }),
  );
  expect(uploadBodies).toHaveLength(1);
  expect(uploadBodies[0]?.get("projectId")).toBe(
    "bbbbbbbb-1111-4111-8111-111111111111",
  );
  expect(JSON.stringify(elements)).not.toContain("data:image/");
  fireEvent.click(screen.getByRole("button", { name: "图片模型" }));
  fireEvent.click(screen.getByRole("button", { name: "其他模型" }));
  expect(screen.queryByAltText("ref")).toBeNull();
  expect(
    JSON.parse(JSON.stringify(elements[0]?.customData)),
  ).not.toHaveProperty("inputImages");
  fireEvent.click(screen.getByRole("button", { name: "其他模型" }));
  fireEvent.click(screen.getByRole("button", { name: "图片模型" }));
  await waitFor(() =>
    expect(screen.getByAltText("ref").getAttribute("src")).toBe(
      "https://assets.example/refreshed-reference.png",
    ),
  );
  const snapshot = elements[0]?.customData;
  if (!snapshot) throw new Error("生成器草稿未保存");
  const requestsBeforeReopen = previewRequests;
  displayed.unmount();
  show(snapshot);
  await waitFor(() =>
    expect(previewRequests).toBeGreaterThan(requestsBeforeReopen),
  );
  await waitFor(() =>
    expect(screen.getByAltText("ref").getAttribute("src")).toBe(
      "https://assets.example/refreshed-reference.png",
    ),
  );
  expect(JSON.stringify(elements)).not.toContain("data:image/");
  expect(uploadBodies).toHaveLength(1);
});

it("数量独立于单次上游上限，随模型草稿恢复并提交", async () => {
  const firstModel = "11111111-1111-4111-8111-111111111111:image-a";
  const secondModel = "11111111-1111-4111-8111-111111111111:image-b";
  let submitted: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/image-models"))
      return Response.json({
        models: [
          {
            id: firstModel,
            displayName: "图片 A",
            provider: "供应商",
            imageGeneration: { maxOutputs: 1 },
          },
          {
            id: secondModel,
            displayName: "图片 B",
            provider: "供应商",
            imageGeneration: { maxOutputs: 2 },
          },
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
    type: "image-generator" as const,
    status: "idle" as const,
    prompt: "猫",
    model: firstModel,
    aspectRatio: "",
    quality: "",
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
      <ImageGeneratorPanel
        canvasId="aaaaaaaa-1111-4111-8111-111111111111"
        projectId="bbbbbbbb-1111-4111-8111-111111111111"
        prepare={async () => "1"}
        elementId="generator"
        elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
        data={data}
        excalidrawApi={api}
        accessToken={null}
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
      />
    </ToastProvider>,
  );
  await screen.findByText("图片 A");
  expect((screen.getByLabelText("数量") as HTMLInputElement).value).toBe("1");
  fireEvent.change(screen.getByLabelText("数量"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "图片 A" }));
  fireEvent.click(screen.getByRole("button", { name: "图片 B" }));
  expect((screen.getByLabelText("数量") as HTMLInputElement).value).toBe("1");
  fireEvent.change(screen.getByLabelText("数量"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "图片 B" }));
  fireEvent.click(screen.getByRole("button", { name: "图片 A" }));
  expect((screen.getByLabelText("数量") as HTMLInputElement).value).toBe("3");
  expect(elements[0]?.customData).toMatchObject({
    count: 3,
    modelDrafts: { [firstModel]: { count: 3 }, [secondModel]: { count: 2 } },
  });
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(submitted).toMatchObject({ model: "image-a", count: 3 }),
  );
});

it.each(["click", "enter"])(
  "明确无需提示词的模型以%s提交已有参考图",
  async (action) => {
    const model = "11111111-1111-4111-8111-111111111111:reference-only";
    let submitted: unknown;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/image-models"))
        return Response.json({
          models: [
            {
              id: model,
              displayName: "参考图处理",
              provider: "供应商",
              imageGeneration: { requirePrompt: false },
            },
          ],
        });
      if (String(url).endsWith("/url"))
        return Response.json({ url: "https://assets.example/reference.png" });
      submitted = JSON.parse(String(init?.body));
      return Response.json(
        {
          request_id: "cccccccc-1111-4111-8111-111111111111",
          jobs: [
            {
              job_id: "dddddddd-1111-4111-8111-111111111111",
              status: "queued",
            },
          ],
        },
        { status: 202 },
      );
    });
    const data: ImageGeneratorData = {
      type: "image-generator",
      status: "idle",
      prompt: "  ",
      model,
      aspectRatio: "",
      quality: "",
      inputImages: ["asset://eeeeeeee-1111-4111-8111-111111111111"],
    };
    const api = createGeneratorApi("generator", data);
    render(
      <ToastProvider>
        <ImageGeneratorPanel
          canvasId="aaaaaaaa-1111-4111-8111-111111111111"
          projectId="bbbbbbbb-1111-4111-8111-111111111111"
          prepare={async () => "1"}
          elementId="generator"
          elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
          data={data}
          excalidrawApi={api}
          accessToken={null}
          canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        />
      </ToastProvider>,
    );
    await screen.findByText("参考图处理");
    if (action === "enter")
      fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
        key: "Enter",
      });
    else {
      const buttons = screen.getAllByRole("button");
      const generate = buttons.at(-1);
      if (!generate) throw new Error("生成入口未渲染");
      expect(generate.hasAttribute("disabled")).toBe(false);
      fireEvent.click(generate);
    }
    await waitFor(() =>
      expect(submitted).toMatchObject({
        prompt: "",
        model: "reference-only",
        inputImages: ["asset://eeeeeeee-1111-4111-8111-111111111111"],
      }),
    );
  },
);
