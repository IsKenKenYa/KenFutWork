import { act, cleanup, render, screen } from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { Root } from "@zui/Root";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import {
  installCodeRootBrowser,
  restoreCodeRootBrowser,
} from "./setup/code-root-host-browser";
import {
  codeRootNativeSessionSnapshot,
  createCodeRootHostFetch,
} from "./setup/code-root-host-http";

const clients: CodeHttpChannelClient[] = [];
const taskId = "550e8400-e29b-41d4-a716-446655440101";
const title = "原会话真实标题 🌟";
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.dispose();
  vi.unstubAllGlobals();
  restoreCodeRootBrowser();
  localStorage.clear();
});

async function openRoot(metadata: () => Promise<Response>, native = false) {
  installCodeRootBrowser();
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const fallback = createCodeRootHostFetch(calls, { rejectOpen: false });
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (!url.endsWith("/events")) {
      const call = JSON.parse(String(options?.body));
      if (call.service === "zcode-task" && call.method === "getTaskMeta") {
        calls.push(call);
        return metadata();
      }
      if (
        native &&
        call.service === "zcode-session" &&
        call.method === "readSession"
      ) {
        calls.push(call);
        return Response.json({
          result: codeRootNativeSessionSnapshot(taskId, "原协议标题"),
        });
      }
    }
    return fallback(url, options);
  });
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  clients.push(client);
  await client.connect();
  const platform = createCodePlatform(client);
  if (native) delete platform.sessionMetadataSource;
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <Root
        services={client.services}
        platform={platform}
        initialWorkspaceAbsPath="/code"
        initialTaskId={taskId}
        restoreSession={false}
        allowRemoteWorkspace={false}
        preferDirectoryBrowser
      />
    </ZCodeIntlProvider>,
  );
  return calls;
}

function metadataResponse() {
  return Response.json({
    result: {
      taskId,
      traceId: taskId,
      workspacePath: "/code",
      title,
      createdAt: 1,
      updatedAt: 2,
      provider: "glm",
      mode: "build",
      status: "completed",
    },
  });
}

it("原Root主标题读取真实轻量元信息，不因未接旧session/readSession显示新建任务", async () => {
  const calls = await openRoot(async () => metadataResponse());
  expect(await screen.findByRole("heading", { name: title })).not.toBeNull();
  expect(
    calls.filter(
      (call) =>
        call.service === "zcode-session" && call.method === "readSession",
    ),
  ).toEqual([]);
  expect(calls.find((call) => call.method === "getTaskMeta")?.args).toEqual([
    { workspacePath: "/code", taskId },
  ]);
});

it("未声明元信息读面时保留原协议session snapshot及原标题投影", async () => {
  const calls = await openRoot(async () => metadataResponse(), true);
  expect(
    await screen.findByRole("heading", { name: "原协议标题" }),
  ).not.toBeNull();
  expect(calls.filter((call) => call.method === "getTaskMeta")).toEqual([]);
  expect(calls.find((call) => call.method === "readSession")?.args).toEqual([
    { workspacePath: "/code", sessionId: taskId, messageLimit: 1 },
  ]);
});

it.each([200, 404])(
  "元信息不存在或已删除时使用原空标题且不回退旧消息读取（%s）",
  async (status) => {
    let completeRead = () => {};
    const readFinished = new Promise<void>((resolve) => {
      completeRead = resolve;
    });
    const calls = await openRoot(async () => {
      const response =
        status === 200
          ? Response.json({ result: null })
          : Response.json({ error: { message: "任务已删除" } }, { status });
      const parse = response.json.bind(response);
      response.json = async () => {
        const value = await parse();
        completeRead();
        return value;
      };
      return response;
    });
    await act(async () => {
      await readFinished;
    });
    expect(
      await screen.findByRole("heading", { name: "新建任务" }),
    ).not.toBeNull();
    expect(
      calls.filter(
        (call) =>
          call.service === "zcode-session" && call.method === "readSession",
      ),
    ).toEqual([]);
  },
);
