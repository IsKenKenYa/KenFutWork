import { act, cleanup, render, screen } from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { Root } from "@zui/index";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { bindCodeWorkspaceServices } from "../src/components/workbench/zcode/host/workspaceServices";
import { createCodeWorkspaceContextResolver } from "../src/components/workbench/zcode/host/workspaceServiceController";
import {
  installCodeRootBrowser,
  restoreCodeRootBrowser,
} from "./setup/code-root-host-browser";
import {
  codeRootNativeSessionSnapshot,
  createCodeRootHostFetch,
  rootProjectId,
  rootWorkspace,
} from "./setup/code-root-host-http";

const clients: CodeHttpChannelClient[] = [];
const releases: Array<() => void> = [];
const taskId = "550e8400-e29b-41d4-a716-446655440101";
const title = "原会话真实标题 🌟";
const taskRoot = "/metadata-task-A";
const identity = JSON.stringify([rootProjectId, taskRoot]);
afterEach(() => {
  cleanup();
  for (const release of releases.splice(0)) release();
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
    if (url.endsWith("/workspaces"))
      return Response.json({
        workspaces: [{ ...rootWorkspace, path: "/new-default-B" }],
      });
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
          result: codeRootNativeSessionSnapshot(
            taskId,
            "原协议标题",
            taskRoot,
            identity,
          ),
        });
      }
    }
    return fallback(url, options);
  });
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  clients.push(client);
  await client.connect();
  client.registerWorkspaces([{ ...rootWorkspace, path: "/new-default-B" }]);
  client.workspaces.registerTask({
    taskId,
    projectId: rootProjectId,
    workspacePath: taskRoot,
  });
  releases.push(bindCodeWorkspaceServices(client));
  const platform = createCodePlatform(client);
  if (native) delete platform.sessionMetadataSource;
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <Root
        services={client.services}
        platform={platform}
        initialWorkspaceAbsPath={taskRoot}
        initialWorkspaceIdentity={identity}
        initialTaskId={taskId}
        onWorkspaceContextChange={createCodeWorkspaceContextResolver(client)}
        directoryServices={client.directoryServices()}
        workbenchGroupClientMode="web-remote-replayable"
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
      workspacePath: taskRoot,
      workspaceIdentity: identity,
      projectId: rootProjectId,
      title,
      createdAt: 1,
      updatedAt: 2,
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
    {
      workspacePath: taskRoot,
      workspaceIdentity: identity,
      projectId: rootProjectId,
      taskId,
    },
  ]);
});

it("未声明元信息读面时保留原协议session snapshot及原标题投影", async () => {
  const calls = await openRoot(async () => metadataResponse(), true);
  expect(
    await screen.findByRole("heading", { name: "原协议标题" }),
  ).not.toBeNull();
  expect(calls.filter((call) => call.method === "getTaskMeta")).toEqual([]);
  expect(calls.find((call) => call.method === "readSession")?.args).toEqual([
    {
      workspacePath: taskRoot,
      workspaceIdentity: identity,
      projectId: rootProjectId,
      sessionId: taskId,
      messageLimit: 1,
    },
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
