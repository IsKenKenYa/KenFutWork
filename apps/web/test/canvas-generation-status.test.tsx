import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type {
  ExcalidrawImperativeAPI,
  SceneData,
} from "@excalidraw/excalidraw/types";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { CanvasToolMenu } from "../src/components/canvas-tool-menu";
import { createImageGeneratorElement } from "../src/lib/canvas-image-generator";

function generationScene(requestId: string, jobId: string) {
  let elements: NonNullable<SceneData["elements"]> = [];
  const api = {
    getSceneElements: () => elements,
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => ({
      activeTool: { type: "selection" },
      zoom: { value: 1 },
      selectedElementIds: {},
      width: 600,
      height: 600,
      scrollX: 0,
      scrollY: 0,
    }),
    onChange: () => () => {},
    updateScene: (
      update: Parameters<ExcalidrawImperativeAPI["updateScene"]>[0],
    ) => {
      if (update.elements) elements = update.elements;
    },
  } as unknown as ExcalidrawImperativeAPI;
  const generatorId = createImageGeneratorElement(api, { aspectRatio: "1:1" });
  elements = elements.map((element) =>
    element.id === generatorId
      ? {
          ...element,
          customData: {
            ...element.customData,
            status: "generating",
            requestId,
            jobIds: [jobId],
          },
        }
      : element,
  );
  return { api, generatorId };
}

it.each(["查询", "同步"])(
  "%s异常时提示并自动恢复，换画布后忽略迟到错误",
  async (issue) => {
    const canvasId = "aaaaaaaa-1111-4111-8111-111111111111";
    const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
    const requestId = "cccccccc-1111-4111-8111-111111111111";
    const jobId = "dddddddd-1111-4111-8111-111111111111";
    const message =
      issue === "查询"
        ? "暂时无法读取生成进度 · 将继续查询"
        : "暂时无法同步生成结果 · 将继续同步";
    const paths: string[] = [];
    let holdReply: (response: ServerResponse) => void;
    const held = new Promise<ServerResponse>((resolve) => {
      holdReply = resolve;
    });
    let unavailable = true;
    let hold = false;
    const { api, generatorId } = generationScene(requestId, jobId);
    let assetId = "asset-a";
    const server = createServer((request, response) => {
      paths.push(`${request.method} ${request.url}`);
      if (request.url === "/result") {
        response.writeHead(unavailable ? 503 : 204).end();
        return;
      }
      if (hold) {
        holdReply(response);
        return;
      }
      const readFailed = issue === "查询" && unavailable;
      response
        .writeHead(readFailed ? 503 : 200, {
          "content-type": "application/json",
        })
        .end(
          readFailed
            ? JSON.stringify({
                error: { code: "job_query_failed", message: "内部诊断原文" },
              })
            : JSON.stringify({
                jobs: [
                  {
                    id: jobId,
                    canvas_id: canvasId,
                    project_id: projectId,
                    status: "running",
                    payload: { generator_id: generatorId, requested_count: 2 },
                    result: issue === "同步" ? { asset_id: assetId } : null,
                  },
                ],
              }),
        );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const oldBase = process.env.NEXT_PUBLIC_SERVER_BASE_URL;
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("进度查询测试监听失败");
      process.env.NEXT_PUBLIC_SERVER_BASE_URL = `http://127.0.0.1:${address.port}`;

      const elements = api.getSceneElements();
      const renderCanvas = (
        id: string,
        api: ExcalidrawImperativeAPI | null,
      ) => (
        <CanvasToolMenu
          canvasId={id}
          projectId={projectId}
          accessToken={null}
          excalidrawApi={api}
          prepare={async () => null}
          refresh={async () => {
            const response = await fetch(
              `http://127.0.0.1:${address.port}/result`,
            );
            if (!response.ok) throw new Error("读取生成文件失败");
          }}
        />
      );
      const view = render(renderCanvas(canvasId, api));
      const region = screen.getByRole("status");
      expect(await screen.findByText(message)).toBe(region.firstElementChild);
      expect(screen.queryByText("内部诊断原文")).toBeNull();
      expect(api.getSceneElements()).toEqual(elements);

      unavailable = false;
      await waitFor(() => expect(region.textContent).toBe(""));
      const lastScene = api.getSceneElements();
      expect(lastScene[0]?.customData).toMatchObject({
        status: "generating",
        requestId,
        jobIds: [jobId],
      });
      unavailable = true;
      assetId = "asset-b";
      await screen.findByText(message);
      hold = true;
      const reply = await held;
      view.rerender(renderCanvas("other-canvas", null));
      expect(screen.getByRole("status").textContent).toBe("");
      reply.writeHead(503).end();
      expect(screen.getByRole("status").textContent).toBe("");
      expect(api.getSceneElements()).toEqual(lastScene);
      expect(paths.filter((path) => path.startsWith("GET /api/jobs?"))).toEqual(
        Array.from(
          { length: 4 },
          () => `GET /api/jobs?request_id=${requestId}`,
        ),
      );
      expect(paths.every((path) => path.startsWith("GET "))).toBe(true);
      expect(paths.filter((path) => path === "GET /result")).toHaveLength(
        issue === "同步" ? 3 : 0,
      );
    } finally {
      cleanup();
      if (oldBase === undefined) delete process.env.NEXT_PUBLIC_SERVER_BASE_URL;
      else process.env.NEXT_PUBLIC_SERVER_BASE_URL = oldBase;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
