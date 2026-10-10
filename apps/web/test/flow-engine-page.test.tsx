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
 * 「引擎」页停止/卸载（FORM-11 生命周期）与承载方式（双 Provider）：
 *  - 已就绪时点「停止引擎」先亮出「停止并保留数据 / 停止并删除数据」两个选项；
 *  - 选择全删才 POST /engine/stop `{ deleteData: true }`（§9.1③ 显式选择才动数据）；
 *  - 安装中点「取消安装」→ `{ deleteData: false }`（取消保数据）；
 *  - WSL2 就绪时给「本机容器 / WSL2 · <发行版>」选择，安装按所选目标下发；
 *  - WSL2 不可用（探测说不行）时不摆选择。
 */
function stubInfo(
  running: boolean,
  options: { wsl?: boolean; runtime?: { kind: string; distro?: string } } = {},
) {
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
            ...(options.wsl
              ? [
                  {
                    id: "wsl2",
                    label: "WSL2",
                    available: true,
                    distro: "Ubuntu",
                    detail:
                      "发行版 Ubuntu（WSL2，Running；Docker Engine 27.3.1）",
                  },
                ]
              : []),
          ],
          recommended: options.wsl ? "wsl2" : "container",
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
        runtime: options.runtime ?? { kind: "host" },
        addresses: {
          frontendUrl: "http://127.0.0.1:8090",
          hostIdentityUrl: "http://127.0.0.1:3301/api/flow/host/identity",
          composeFile: "D:/repo/dify/docker-compose.dify.yml",
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

it("WSL2 就绪：默认选中推荐目标，安装按 wsl2 下发（点名发行版）", async () => {
  vi.stubGlobal("fetch", stubInfo(false, { wsl: true }));
  const onInstall = vi.fn(async () => {});
  render(
    <FlowEnginePage
      engineState="idle"
      engineNotice={null}
      onInstall={onInstall}
      onStop={async () => {}}
    />,
  );
  // 选择器出现，推荐（wsl2）为按下态
  const wslChip = await screen.findByRole("button", { name: /WSL2 · Ubuntu/ });
  expect(wslChip).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(screen.getByRole("button", { name: "安装引擎栈" }));
  await waitFor(() =>
    expect(onInstall).toHaveBeenCalledWith({ kind: "wsl2", distro: "Ubuntu" }),
  );
});

it("WSL2 就绪：改选本机容器后安装按 host 下发", async () => {
  vi.stubGlobal("fetch", stubInfo(false, { wsl: true }));
  const onInstall = vi.fn(async () => {});
  render(
    <FlowEnginePage
      engineState="idle"
      engineNotice={null}
      onInstall={onInstall}
      onStop={async () => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "本机容器" }));
  fireEvent.click(screen.getByRole("button", { name: "安装引擎栈" }));
  await waitFor(() => expect(onInstall).toHaveBeenCalledWith({ kind: "host" }));
});

it("WSL2 不可用：不摆承载选择（探测说不行就不给假选项）", async () => {
  vi.stubGlobal("fetch", stubInfo(false, { wsl: false }));
  render(
    <FlowEnginePage
      engineState="idle"
      engineNotice={null}
      onInstall={async () => {}}
      onStop={async () => {}}
    />,
  );
  await screen.findByRole("button", { name: "安装引擎栈" });
  expect(screen.queryByRole("button", { name: /WSL2/ })).toBeNull();
});

it("已就绪：副标题显示当前承载目标（落盘记录）", async () => {
  vi.stubGlobal(
    "fetch",
    stubInfo(true, { runtime: { kind: "wsl2", distro: "Ubuntu" } }),
  );
  render(
    <FlowEnginePage
      engineState="ready"
      engineNotice={null}
      onInstall={async () => {}}
      onStop={async () => {}}
    />,
  );
  expect(await screen.findByText(/承载 WSL2 · Ubuntu/)).toBeInTheDocument();
});
