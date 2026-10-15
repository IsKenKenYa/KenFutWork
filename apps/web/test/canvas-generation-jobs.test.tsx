import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BackgroundJob } from "@kenfutwork/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageGeneratorPanel } from "../src/components/canvas/image-generator-panel";
import { VideoGeneratorPanel } from "../src/components/canvas/video-generator-panel";
import { CanvasToolMenu } from "../src/components/canvas-tool-menu";
import { ToastProvider } from "../src/components/toast";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function generationJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: "dddddddd-1111-4111-8111-111111111111",
    instance_id: "eeeeeeee-1111-4111-8111-111111111111",
    canvas_id: "aaaaaaaa-1111-4111-8111-111111111111",
    project_id: "bbbbbbbb-1111-4111-8111-111111111111",
    session_id: null,
    thread_id: null,
    queue_name: "image_generation",
    job_type: "image_generation",
    payload: { generator_id: "generator", requested_count: 1 },
    status: "running",
    provider_job_id: "provider-job",
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by_client_id: null,
    created_at: "2026-10-15T00:00:00.000Z",
    updated_at: "2026-10-15T00:00:00.000Z",
    started_at: "2026-10-15T00:00:00.000Z",
    completed_at: null,
    failed_at: null,
    canceled_at: null,
    ...overrides,
  };
}

it.each(["单图", "视频"])(
  "已受理%s点击停止保存取消意图，关闭面板后只取消原 Job",
  async (media) => {
    const canvasId = "aaaaaaaa-1111-4111-8111-111111111111";
    const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
    const requestId = "cccccccc-1111-4111-8111-111111111111";
    const jobId = "dddddddd-1111-4111-8111-111111111111";
    const video = media === "视频";
    const modelName = video ? "视频模型" : "图片模型";
    const data = {
      type: "image-generator" as const,
      status: "generating" as const,
      prompt: "猫",
      model: "11111111-1111-4111-8111-111111111111:image-model",
      aspectRatio: "",
      quality: "",
      count: 1,
      requestId,
      jobIds: [jobId],
    };
    let elements = [
      {
        id: "generator",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        version: 1,
        isDeleted: false,
        customData: video
          ? { ...data, type: "video-generator" as const }
          : data,
      },
    ];
    const job = generationJob({
      id: jobId,
      canvas_id: canvasId,
      project_id: projectId,
      queue_name: video ? "video_generation" : "image_generation",
      job_type: video ? "video_generation" : "image_generation",
    });
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET" });
      if (
        String(url).endsWith(video ? "/api/video-models" : "/api/image-models")
      )
        return Response.json({
          models: [
            { id: data.model, displayName: modelName, provider: "供应商" },
          ],
        });
      if (String(url).endsWith(`/api/jobs/${jobId}/cancel`))
        return Response.json({
          job: {
            ...job,
            status: "canceled",
            payload: {
              ...job.payload,
              _generation_cancel: { state: "pending" },
            },
          },
        });
      return Response.json({ jobs: [job] });
    });
    const api = {
      getSceneElements: () => elements.filter((element) => !element.isDeleted),
      getSceneElementsIncludingDeleted: () => elements,
      getAppState: () => ({
        zoom: { value: 1 },
        selectedElementIds: {},
        activeTool: { type: "selection" },
      }),
      onChange: () => () => {},
      updateScene: (update: { elements: typeof elements }) => {
        elements = update.elements;
      },
    } as unknown as ExcalidrawImperativeAPI;
    const view = (panelOpen: boolean) => (
      <ToastProvider>
        <CanvasToolMenu
          canvasId={canvasId}
          projectId={projectId}
          prepare={async () => "1"}
          refresh={async () => {}}
          accessToken={null}
          excalidrawApi={api}
        />
        {panelOpen && video && (
          <VideoGeneratorPanel
            canvasId={canvasId}
            projectId={projectId}
            prepare={async () => "1"}
            elementId="generator"
            elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
            data={{ ...data, type: "video-generator" }}
            excalidrawApi={api}
            accessToken={null}
            canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
          />
        )}
        {panelOpen && !video && (
          <ImageGeneratorPanel
            canvasId={canvasId}
            projectId={projectId}
            prepare={async () => "1"}
            elementId="generator"
            elementBounds={{ x: 0, y: 0, width: 400, height: 400 }}
            data={data}
            excalidrawApi={api}
            accessToken={null}
            canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
          />
        )}
      </ToastProvider>
    );
    const rendered = render(view(true));
    await screen.findByText(modelName);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(elements[0]?.customData).toMatchObject({
      cancelRequested: true,
      status: "generating",
      requestId,
    });
    rendered.rerender(view(false));
    await waitFor(
      () =>
        expect(requests.filter((request) => request.method === "POST")).toEqual(
          [
            {
              url: expect.stringContaining(`/api/jobs/${jobId}/cancel`),
              method: "POST",
            },
          ],
        ),
      { timeout: 3500 },
    );
  },
);

it.each([
  ["requested", "已请求云端取消"],
  ["local_only", "已本地停止"],
  ["unknown", "取消结果待确认，请到供应商确认。"],
])("已开面板同步同一生成器的取消进展与%s状态", async (state, message) => {
  const canvasId = "aaaaaaaa-1111-4111-8111-111111111111";
  const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
  const requestId = "cccccccc-1111-4111-8111-111111111111";
  const data = {
    type: "image-generator" as const,
    status: "generating" as const,
    prompt: "猫",
    model: "11111111-1111-4111-8111-111111111111:image-model",
    aspectRatio: "",
    quality: "",
    count: 1,
    requestId,
    cancelRequested: true,
  };
  let elements = [
    {
      id: "generator",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      version: 1,
      isDeleted: false,
      customData: data,
    },
  ];
  const appState = {
    zoom: { value: 1 },
    selectedElementIds: { generator: true },
    activeTool: { type: "selection" },
  };
  let notify = () => {};
  const api = {
    getSceneElements: () => elements.filter((element) => !element.isDeleted),
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => appState,
    onChange: (
      callback: (scene: typeof elements, state: typeof appState) => void,
    ) => {
      notify = () => callback(elements, appState);
      return () => {};
    },
    updateScene: (update: { elements: typeof elements }) => {
      elements = update.elements;
      notify();
    },
  } as unknown as ExcalidrawImperativeAPI;
  let firstReply: (response: Response) => void = () => {};
  let reads = 0;
  const posts: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/image-models"))
      return Response.json({
        models: [
          { id: data.model, displayName: "图片模型", provider: "供应商" },
        ],
      });
    if (init?.method === "POST") {
      posts.push(String(url));
      return Response.json({
        job: generationJob({
          status: "canceled",
          payload: {
            generator_id: "generator",
            _generation_cancel: { state: "pending" },
          },
        }),
      });
    }
    reads++;
    if (reads === 1)
      return await new Promise<Response>((resolve) => {
        firstReply = resolve;
      });
    return Response.json({
      jobs: [
        generationJob({
          status: "canceled",
          payload: { generator_id: "generator", _generation_cancel: { state } },
        }),
      ],
    });
  });
  render(
    <ToastProvider>
      <CanvasToolMenu
        canvasId={canvasId}
        projectId={projectId}
        prepare={async () => "1"}
        refresh={async () => {}}
        accessToken={null}
        excalidrawApi={api}
      />
    </ToastProvider>,
  );
  act(() => notify());
  await screen.findByText("图片模型");
  firstReply(Response.json({ jobs: [generationJob()] }));
  await screen.findByText("停止中", { selector: "div" });
  await waitFor(
    () => expect(screen.getByText(`已生成0/1张 · ${message}`)).toBeTruthy(),
    { timeout: 3500 },
  );
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(posts).toEqual([
    expect.stringContaining(
      "/api/jobs/dddddddd-1111-4111-8111-111111111111/cancel",
    ),
  ]);
});

it.each(["单图", "视频"])(
  "%s取消后新请求不被旧成功回执覆盖，新回执仍可正常接回",
  async (media) => {
    const canvasId = "aaaaaaaa-1111-4111-8111-111111111111";
    const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
    const video = media === "视频";
    const modelName = video ? "视频模型" : "图片模型";
    let elements = [
      {
        id: "generator",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        version: 1,
        isDeleted: false,
        customData: {
          type: video ? "video-generator" : "image-generator",
          status: "idle",
          prompt: "猫",
          model: "11111111-1111-4111-8111-111111111111:media-model",
          aspectRatio: "",
          quality: "",
          count: 1,
          requestId: "",
          jobIds: [] as string[],
          cancelRequested: false,
          errorMessage: "",
        },
      },
    ];
    const appState = {
      zoom: { value: 1 },
      selectedElementIds: { generator: true },
      activeTool: { type: "selection" },
    };
    let notify = () => {};
    const api = {
      getSceneElements: () => elements.filter((element) => !element.isDeleted),
      getSceneElementsIncludingDeleted: () => elements,
      getAppState: () => appState,
      onChange: (
        callback: (scene: typeof elements, state: typeof appState) => void,
      ) => {
        notify = () => callback(elements, appState);
        return () => {};
      },
      updateScene: (update: { elements: typeof elements }) => {
        elements = update.elements;
        notify();
      },
    } as unknown as ExcalidrawImperativeAPI;
    const firstJob = generationJob({
      job_type: video ? "video_generation" : "image_generation",
      queue_name: video ? "video_generation" : "image_generation",
    });
    const secondJobId = "ffffffff-1111-4111-8111-111111111111";
    const submissions: Array<{
      requestId: string;
      reply: (response: Response) => void;
    }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith(video ? "/api/video-models" : "/api/image-models"))
        return Response.json({
          models: [
            {
              id: elements[0]?.customData.model,
              displayName: modelName,
              provider: "供应商",
            },
          ],
        });
      if (path.endsWith(`/api/jobs/${firstJob.id}/cancel`))
        return Response.json({
          job: {
            ...firstJob,
            status: "canceled",
            payload: {
              ...firstJob.payload,
              _generation_cancel: { state: "local_only" },
            },
          },
        });
      if (
        path.endsWith(
          video ? "/api/agent/generate-video" : "/api/agent/generate-image",
        )
      ) {
        const body = JSON.parse(String(init?.body));
        return new Promise<Response>((resolve) => {
          submissions.push({ requestId: body.requestId, reply: resolve });
        });
      }
      const requestId = new URL(path, "http://localhost").searchParams.get(
        "request_id",
      );
      return Response.json({
        jobs: requestId === submissions[0]?.requestId ? [firstJob] : [],
      });
    });
    render(
      <ToastProvider>
        <CanvasToolMenu
          canvasId={canvasId}
          projectId={projectId}
          prepare={async () => "1"}
          refresh={async () => {}}
          accessToken={null}
          excalidrawApi={api}
        />
      </ToastProvider>,
    );
    act(() => notify());
    await screen.findByText(modelName);
    const submit = () =>
      fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
        key: "Enter",
      });
    submit();
    await waitFor(() => expect(submissions).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await screen.findByText(
      `已生成0/1${video ? "段" : "张"} · 已本地停止`,
      {},
      { timeout: 3500 },
    );
    submit();
    await waitFor(() => expect(submissions).toHaveLength(2));
    const first = submissions[0];
    const second = submissions[1];
    if (!first || !second) throw new Error("缺少两次生成请求");
    expect(first.requestId).not.toBe(second.requestId);
    const currentRequest = { ...elements[0]?.customData };
    await act(async () => {
      first.reply(
        Response.json(
          {
            request_id: first.requestId,
            jobs: [{ job_id: firstJob.id, status: "queued" }],
          },
          { status: 202 },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(elements[0]?.customData).toEqual(currentRequest);
    await act(async () => {
      second.reply(
        Response.json(
          {
            request_id: second.requestId,
            jobs: [{ job_id: secondJobId, status: "queued" }],
          },
          { status: 202 },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(elements[0]?.customData).toMatchObject({
      requestId: second.requestId,
      jobIds: [secondJobId],
      status: "generating",
      cancelRequested: false,
    });
    expect(submissions).toHaveLength(2);
  },
);

it("重开画布从持久请求恢复完成状态，只同步服务器成果并保留删除记录", async () => {
  const canvasId = "aaaaaaaa-1111-4111-8111-111111111111";
  const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
  const requestId = "cccccccc-1111-4111-8111-111111111111";
  let elements = [
    {
      id: "generator",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      version: 1,
      isDeleted: false,
      customData: { type: "image-generator", status: "generating", requestId },
    },
    {
      id: "old-deleted",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      version: 1,
      isDeleted: true,
      customData: {},
    },
  ];
  vi.stubGlobal("fetch", async () =>
    Response.json({
      jobs: [
        {
          id: "job",
          canvas_id: canvasId,
          project_id: projectId,
          payload: { generator_id: "generator" },
          status: "succeeded",
          result: {
            element_id: "server-image",
            asset_id: "eeeeeeee-1111-4111-8111-111111111111",
          },
        },
      ],
    }),
  );
  const addFiles = vi.fn();
  const api = {
    getSceneElements: () => elements.filter((element) => !element.isDeleted),
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => ({
      zoom: { value: 1 },
      viewBackgroundColor: "#ffffff",
      selectedElementIds: {},
      activeTool: { type: "selection" },
    }),
    onChange: () => () => {},
    updateScene: (update: { elements: typeof elements }) => {
      elements = update.elements;
    },
    addFiles,
  } as unknown as ExcalidrawImperativeAPI;
  const refresh = async () => {
    if (!elements.some((element) => element.id === "server-image"))
      elements.push({
        id: "server-image",
        type: "image",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        version: 1,
        isDeleted: false,
        customData: {},
      });
  };
  render(
    <CanvasToolMenu
      canvasId={canvasId}
      projectId={projectId}
      prepare={async () => "1"}
      refresh={refresh}
      accessToken={null}
      excalidrawApi={api}
    />,
  );
  await waitFor(() =>
    expect(
      elements.find((element) => element.id === "generator")?.isDeleted,
    ).toBe(true),
  );
  expect(
    elements.filter((element) => element.id === "server-image"),
  ).toHaveLength(1);
  expect(
    elements.find((element) => element.id === "old-deleted")?.isDeleted,
  ).toBe(true);
  expect(addFiles).not.toHaveBeenCalled();
});

it("查询在途时删除的生成器不会被迟到状态复活", async () => {
  const canvasId = "aaaaaaaa-1111-4111-8111-111111111111";
  const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
  const requestId = "cccccccc-1111-4111-8111-111111111111";
  let elements = [
    {
      id: "generator",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      version: 1,
      isDeleted: false,
      customData: { type: "image-generator", status: "generating", requestId },
    },
  ];
  let reply: (response: Response) => void = () => {};
  const fetched = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        reply = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetched);
  const api = {
    getSceneElements: () => elements.filter((element) => !element.isDeleted),
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => ({
      zoom: { value: 1 },
      selectedElementIds: {},
      activeTool: { type: "selection" },
    }),
    onChange: () => () => {},
    updateScene: (update: { elements: typeof elements }) => {
      elements = update.elements;
    },
  } as unknown as ExcalidrawImperativeAPI;
  render(
    <CanvasToolMenu
      canvasId={canvasId}
      projectId={projectId}
      prepare={async () => "1"}
      refresh={async () => {}}
      accessToken={null}
      excalidrawApi={api}
    />,
  );
  await waitFor(() => expect(fetched).toHaveBeenCalled());
  elements = elements.map((element) => ({ ...element, isDeleted: true }));
  reply(
    Response.json({
      jobs: [
        {
          id: "job",
          canvas_id: canvasId,
          project_id: projectId,
          payload: { generator_id: "generator" },
          status: "running",
        },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(elements[0]?.isDeleted).toBe(true);
});

it.each(["succeeded", "dead_letter"])(
  "%s部分产物刷新画布并保留生成器如实显示数量，不重发生成",
  async (status) => {
    const canvasId = "aaaaaaaa-1111-4111-8111-111111111111";
    const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
    const requestId = "cccccccc-1111-4111-8111-111111111111";
    let elements = [
      {
        id: "generator",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        version: 1,
        isDeleted: false,
        customData: {
          type: "image-generator",
          status: "generating",
          requestId,
          count: 9,
        },
      },
    ];
    const requests: Array<{ method: string }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET" });
      return Response.json({
        jobs: [
          {
            id: "job",
            canvas_id: canvasId,
            project_id: projectId,
            payload: { generator_id: "generator", requested_count: 3 },
            status,
            error_message:
              status === "succeeded" ? "旧限流重试消息" : "第三张被供应商拒绝",
            result: {
              outputs: [
                {
                  asset_id: "eeeeeeee-1111-4111-8111-111111111111",
                  element_id: "server-image-1",
                },
                {
                  asset_id: "ffffffff-1111-4111-8111-111111111111",
                  element_id: "server-image-2",
                },
                {
                  asset_id: "eeeeeeee-1111-4111-8111-111111111111",
                  element_id: "duplicate-output",
                },
              ],
            },
          },
        ],
      });
    });
    const api = {
      getSceneElements: () => elements.filter((element) => !element.isDeleted),
      getSceneElementsIncludingDeleted: () => elements,
      getAppState: () => ({
        zoom: { value: 1 },
        selectedElementIds: {},
        activeTool: { type: "selection" },
      }),
      onChange: () => () => {},
      updateScene: (update: { elements: typeof elements }) => {
        elements = update.elements;
      },
    } as unknown as ExcalidrawImperativeAPI;
    const refresh = vi.fn(async () => {});
    render(
      <CanvasToolMenu
        canvasId={canvasId}
        projectId={projectId}
        prepare={async () => "1"}
        refresh={refresh}
        accessToken={null}
        excalidrawApi={api}
      />,
    );
    await waitFor(() =>
      expect(elements[0]?.customData).toMatchObject({
        status: "error",
        errorMessage: expect.stringContaining("已生成2/3张"),
      }),
    );
    expect(elements[0]?.isDeleted).toBe(false);
    expect(elements[0]?.customData).toMatchObject({
      errorMessage: expect.stringContaining(
        status === "succeeded" ? "返回数量不足" : "第三张被供应商拒绝",
      ),
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  },
);

it("多图取消尚待确认时立即同步已成功成果与数量，继续查询且不重发生成", async () => {
  const canvasId = "aaaaaaaa-1111-4111-8111-111111111111";
  const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
  const requestId = "cccccccc-1111-4111-8111-111111111111";
  let elements = [
    {
      id: "generator",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      version: 1,
      isDeleted: false,
      customData: {
        type: "image-generator",
        status: "generating",
        prompt: "猫",
        model: "11111111-1111-4111-8111-111111111111:image-model",
        aspectRatio: "",
        quality: "",
        count: 2,
        requestId,
        cancelRequested: true,
      },
    },
  ];
  const appState = {
    zoom: { value: 1 },
    selectedElementIds: { generator: true },
    activeTool: { type: "selection" },
  };
  let notify = () => {};
  const api = {
    getSceneElements: () => elements.filter((element) => !element.isDeleted),
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => appState,
    onChange: (
      callback: (scene: typeof elements, state: typeof appState) => void,
    ) => {
      notify = () => callback(elements, appState);
      return () => {};
    },
    updateScene: (update: { elements: typeof elements }) => {
      elements = update.elements;
      notify();
    },
  } as unknown as ExcalidrawImperativeAPI;
  let reads = 0;
  let cancellationConfirmed = false;
  const posts: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/image-models"))
      return Response.json({
        models: [
          {
            id: elements[0]?.customData.model,
            displayName: "图片模型",
            provider: "供应商",
          },
        ],
      });
    if (init?.method === "POST") posts.push(String(url));
    reads++;
    return Response.json({
      jobs: [
        generationJob({
          status: "succeeded",
          payload: { generator_id: "generator", requested_count: 2 },
          result: {
            outputs: [
              {
                asset_id: "eeeeeeee-1111-4111-8111-111111111111",
                element_id: "server-image",
                object_path: "generated/image.png",
                signed_url: "https://assets.example/image.png",
                mime_type: "image/png",
              },
            ],
          },
        }),
        generationJob({
          id: "ffffffff-1111-4111-8111-111111111111",
          status: "canceled",
          payload: {
            generator_id: "generator",
            requested_count: 2,
            _generation_cancel: {
              state: cancellationConfirmed ? "local_only" : "pending",
            },
          },
        }),
      ],
    });
  });
  const refresh = vi.fn(async () => {});
  render(
    <ToastProvider>
      <CanvasToolMenu
        canvasId={canvasId}
        projectId={projectId}
        prepare={async () => "1"}
        refresh={refresh}
        accessToken={null}
        excalidrawApi={api}
      />
    </ToastProvider>,
  );
  act(() => notify());
  await screen.findByText("图片模型");
  await screen.findByText("已生成1/2张 · 停止中");
  expect(elements[0]?.customData.status).toBe("generating");
  expect(elements[0]?.isDeleted).toBe(false);
  expect(refresh).toHaveBeenCalledOnce();
  await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2), {
    timeout: 3500,
  });
  expect(refresh).toHaveBeenCalledOnce();
  cancellationConfirmed = true;
  await screen.findByText("已生成1/2张 · 已本地停止", {}, { timeout: 3500 });
  expect(elements[0]?.customData.status).toBe("error");
  expect(refresh).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});

it.each([
  ["单图", "网络错误"],
  ["视频", "网络错误"],
  ["单图", "400错误"],
  ["视频", "400错误"],
])("%s迟到提交%s保留已确认的取消状态", async (media, failure) => {
  const canvasId = "aaaaaaaa-1111-4111-8111-111111111111";
  const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
  const video = media === "视频";
  const modelName = video ? "视频模型" : "图片模型";
  let elements = [
    {
      id: "generator",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      version: 1,
      isDeleted: false,
      customData: {
        type: video ? "video-generator" : "image-generator",
        status: "idle",
        prompt: "猫",
        model: "11111111-1111-4111-8111-111111111111:media-model",
        aspectRatio: "",
        quality: "",
        count: 1,
        requestId: "",
        jobIds: [] as string[],
        cancelRequested: false,
        errorMessage: "",
      },
    },
  ];
  const appState = {
    zoom: { value: 1 },
    selectedElementIds: { generator: true },
    activeTool: { type: "selection" },
  };
  let notify = () => {};
  const api = {
    getSceneElements: () => elements.filter((element) => !element.isDeleted),
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => appState,
    onChange: (
      callback: (scene: typeof elements, state: typeof appState) => void,
    ) => {
      notify = () => callback(elements, appState);
      return () => {};
    },
    updateScene: (update: { elements: typeof elements }) => {
      elements = update.elements;
      notify();
    },
  } as unknown as ExcalidrawImperativeAPI;
  const job = generationJob({
    job_type: video ? "video_generation" : "image_generation",
    queue_name: video ? "video_generation" : "image_generation",
  });
  let finishPost = () => {};
  const requests: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = String(url);
    requests.push({ url: path, method: init?.method ?? "GET" });
    if (path.endsWith(video ? "/api/video-models" : "/api/image-models"))
      return Response.json({
        models: [
          {
            id: elements[0]?.customData.model,
            displayName: modelName,
            provider: "供应商",
          },
        ],
      });
    if (path.endsWith(`/api/jobs/${job.id}/cancel`))
      return Response.json({
        job: {
          ...job,
          status: "canceled",
          payload: {
            ...job.payload,
            _generation_cancel: { state: "local_only" },
          },
        },
      });
    if (
      path.endsWith(
        video ? "/api/agent/generate-video" : "/api/agent/generate-image",
      )
    )
      return new Promise<Response>((resolve, reject) => {
        finishPost = () => {
          if (failure === "400错误")
            resolve(
              Response.json(
                {
                  error: {
                    code: "invalid_request",
                    message: "迟到的提交失败",
                  },
                },
                { status: 400 },
              ),
            );
          else reject(new TypeError("Network error"));
        };
      });
    return Response.json({ jobs: [job] });
  });
  render(
    <ToastProvider>
      <CanvasToolMenu
        canvasId={canvasId}
        projectId={projectId}
        prepare={async () => "1"}
        refresh={async () => {}}
        accessToken={null}
        excalidrawApi={api}
      />
    </ToastProvider>,
  );
  act(() => notify());
  await screen.findByText(modelName);
  fireEvent.keyDown(screen.getByPlaceholderText("今天我们要创作什么"), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(
      requests.filter((request) =>
        request.url.includes("/api/agent/generate-"),
      ),
    ).toHaveLength(1),
  );
  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  const message = `已生成0/1${video ? "段" : "张"} · 已本地停止`;
  await screen.findByText(message, {}, { timeout: 3500 });
  const confirmed = { ...elements[0]?.customData };
  await act(async () => {
    finishPost();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.queryByText("提交结果待确认")).toBeNull();
  expect(screen.queryByText("迟到的提交失败")).toBeNull();
  expect(elements[0]?.customData).toEqual(confirmed);
  expect(requests.filter((request) => request.method === "POST")).toEqual([
    {
      url: expect.stringContaining(
        video ? "/api/agent/generate-video" : "/api/agent/generate-image",
      ),
      method: "POST",
    },
    {
      url: expect.stringContaining(`/api/jobs/${job.id}/cancel`),
      method: "POST",
    },
  ]);
});
