// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { FlowEnginePage } from "../src/components/workbench/flow-engine-page";

/**
 * 「引擎」页停止/卸载（FORM-11 生命周期）：
 *  - 已就绪时点「停止引擎」先亮出「停止并保留数据 / 停止并删除数据」两个选项；
 *  - 选择全删才 POST /engine/stop `{ deleteData: true }`（§9.1③ 显式选择才动数据）；
 *  - 安装中点「取消安装」→ `{ deleteData: false }`（取消保数据）。
 */
function stubInfo(running: boolean) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/flow/host/engine/info")) {
      return Response.json({
        install: { state: running ? "ready" : "idle", logTail: [] },
        probe: {
          platform: "win32",
          paths: [
            {
              id: "container",
              label: "本机容器",
              available: true,
              detail: "Docker 29.6.2",
            },
          ],
          recommended: "container",
        },
        stack: {
          containers: running
            ? [
                {
                  service: "dify-api",
                  name: "dify-api-1",
                  state: "running",
                  health: "healthy",
                  ports: ["127.0.0.1:15001->5001/tcp"],
                },
              ]
            : [],
        },
        addresses: {
          frontendUrl: "http://127.0.0.1:8090",
          hostIdentityUrl: "http://127.0.0.1:3301/api/flow/host/identity",
          composeFile: "D:/repo/docker-compose.dify.yml",
          dataDir: "D:/repo/.kenfutwork-data",
        },
      });
    }
    if (url.endsWith("/api/flow/host/engine/stop")) {
      return Response.json({ state: "idle", logTail: [] });
    }
    return Response.json({});
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("已就绪：停止前先问保留/全删，选择全删才 deleteData:true", async () => {
  vi.stubGlobal("fetch", stubInfo(true));
  const onStop = vi.fn(async () => {});
  render(
    <FlowEnginePage
      engineState="ready"
      engineNotice={null}
      onInstall={async () => {}}
      onStop={onStop}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "停止引擎" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "停止并删除数据" }),
  );
  await waitFor(() =>
    expect(onStop).toHaveBeenCalledWith({ deleteData: true }),
  );
  expect(screen.queryByRole("button", { name: "停止并删除数据" })).toBeNull();
});

it("安装中：取消安装走保数据（deleteData:false）", async () => {
  vi.stubGlobal("fetch", stubInfo(false));
  const onStop = vi.fn(async () => {});
  render(
    <FlowEnginePage
      engineState="installing"
      engineNotice={null}
      onInstall={async () => {}}
      onStop={onStop}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "取消安装" }));
  await waitFor(() =>
    expect(onStop).toHaveBeenCalledWith({ deleteData: false }),
  );
});
