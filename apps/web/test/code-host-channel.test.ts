import type { CodeUiViewerScope } from "@kenfutwork/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceChannels } from "../../../packages/zcode-shared/dist/channels.js";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { codeHostNotificationResponse } from "./setup/code-host-http";

afterEach(() => vi.unstubAllGlobals());
function clientWith(result: unknown = { content: "read" }) {
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith("/events"))
        return codeHostNotificationResponse(options.signal ?? undefined);
      requests.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ result }));
    }),
  );
  return {
    client: new CodeHttpChannelClient({
      apiBase: "http://host.test",
    }),
    requests,
  };
}
describe("Code human viewer channel", () => {
  it("通知连接换代把生命周期送达各自的工作域监听，不能被路由过滤掉", async () => {
    let disconnect!: () => void;
    let connections = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (!url.endsWith("/events"))
          return new Response(JSON.stringify({ result: {} }));
        const generation = ++connections;
        let close!: () => void;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            close = () => {
              if (!closed) {
                closed = true;
                controller.close();
              }
            };
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ event: "ready", hello: { connectionId: `connection-${generation}` }, reconnectDelayMs: 10 })}\n\n`,
              ),
            );
          },
        });
        if (generation === 1) disconnect = close;
        options.signal?.addEventListener("abort", close, { once: true });
        return new Response(body);
      }),
    );
    const client = new CodeHttpChannelClient({ apiBase: "http://host.test" });
    const targets = [
      { workspacePath: "/same", workspaceIdentity: '["project-a","/same"]' },
      { workspacePath: "/same", workspaceIdentity: '["project-b","/same"]' },
      { workspacePath: "/path-only" },
    ];
    const seen = targets.map(
      () =>
        [] as Array<{ state: string; runtimeIdentity: { identity: string } }>,
    );
    const restarts = targets.map(() => [] as unknown[]);
    const channel = client.getChannel(ServiceChannels.ZCodeAgent);
    const listeners = targets.flatMap((target, index) => [
      channel.listen<{ state: string; runtimeIdentity: { identity: string } }>(
        "onAgentRuntimeLifecycle",
        target,
      )((event) => seen[index]!.push(event)),
      channel.listen(
        "onAgentRuntimeRestarted",
        target,
      )((event) => restarts[index]!.push(event)),
    ]);
    try {
      await client.connect();
      disconnect();
      await expect.poll(() => connections).toBe(2);
      await expect
        .poll(() => seen.map((events) => events.map((event) => event.state)))
        .toEqual(targets.map(() => ["unavailable", "available"]));
      expect(
        seen.map((events) => events.at(-1)?.runtimeIdentity.identity),
      ).toEqual(targets.map(() => "connection-2"));
      expect(restarts.map((events) => events.length)).toEqual([1, 1, 1]);
    } finally {
      listeners.forEach((listener) => {
        listener.dispose();
      });
      client.dispose();
    }
  });
  it("终端归属只来自本客户端真实创建回执，不由相同Task或路径猜测", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (url.endsWith("/events"))
          return codeHostNotificationResponse(options.signal ?? undefined);
        return new Response(
          JSON.stringify({
            result: {
              id: url.includes("left.test")
                ? "left-terminal"
                : "right-terminal",
            },
          }),
        );
      }),
    );
    const left = new CodeHttpChannelClient({ apiBase: "http://left.test" });
    const right = new CodeHttpChannelClient({ apiBase: "http://right.test" });
    for (const client of [left, right])
      client.setViewerContextResolver(() => ({
        kind: "task",
        taskId: "same-task",
      }));
    try {
      const a = await left.services.terminalService.create({
        cols: 80,
        rows: 24,
        cwd: "/same",
      });
      const b = await right.services.terminalService.create({
        cols: 80,
        rows: 24,
        cwd: "/same",
      });
      expect(left.ownsTerminal(a.id)).toBe(true);
      expect(left.ownsTerminal(b.id)).toBe(false);
      expect(right.ownsTerminal(a.id)).toBe(false);
      expect(right.ownsTerminal(b.id)).toBe(true);
      left.dispose();
      expect(left.ownsTerminal(a.id)).toBe(false);
    } finally {
      left.dispose();
      right.dispose();
    }
  });
  it("真实通知换代后迟到的创建回执被拒绝，旧终端身份不进入本客户端归属", async () => {
    let disconnect!: () => void;
    let release!: (response: Response) => void;
    let received!: () => void;
    const admitted = new Promise<void>((resolve) => {
      received = resolve;
    });
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let connections = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (url.endsWith("/events")) {
          let close!: () => void;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              let closed = false;
              close = () => {
                if (closed) return;
                closed = true;
                controller.close();
              };
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ event: "ready", hello: { connectionId: `connection-${++connections}` }, reconnectDelayMs: 10 })}\n\n`,
                ),
              );
            },
          });
          disconnect = close;
          options.signal?.addEventListener("abort", close, {
            once: true,
          });
          return new Response(body);
        }
        const request = JSON.parse(String(options.body));
        if (request.method === "create") {
          received();
          return held;
        }
        return new Response(JSON.stringify({ result: null }));
      }),
    );
    const client = new CodeHttpChannelClient({ apiBase: "http://host.test" });
    client.setViewerContextResolver(() => ({ kind: "task", taskId: "task" }));
    let changed = 0;
    const unlisten = client.subscribeServices(() => {
      changed += 1;
    });
    try {
      const pending = client.services.terminalService.create({
        cols: 80,
        rows: 24,
      });
      const outcome = Promise.allSettled([pending]);
      await admitted;
      disconnect();
      await vi.waitFor(() => expect(changed).toBe(1));
      release(
        new Response(JSON.stringify({ result: { id: "late-terminal" } })),
      );
      const result = (await outcome)[0];
      expect(result).toMatchObject({
        status: "rejected",
        reason: { message: "终端启动期间通知连接已改变，请重新打开终端。" },
      });
      expect(client.ownsTerminal("late-terminal")).toBe(false);
    } finally {
      unlisten();
      client.dispose();
    }
  });
  it("原终端void销毁的取消被观察，显式await仍拒绝且不向关闭连接发送请求", async () => {
    const { client, requests } = clientWith(null);
    await client.connect();
    client.dispose();
    // 对齐原TerminalSession的销毁消费方式；未观察的拒绝会使Vitest整次检查失败。
    void client.services.terminalService.dispose({ id: "closed-terminal" });
    await expect(
      client.services.terminalService.dispose({ id: "closed-terminal" }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(requests).toEqual([]);
  });
  it("原Git/watch请求保留Project viewer hint，本机技能不借用Task身份", async () => {
    const { client, requests } = clientWith({
      id: "watcher",
      skills: [],
      diagnostics: [],
      capability: { userScopeAvailable: true },
    });
    client.setViewerContextResolver(() => ({
      kind: "project",
      projectId: "project",
    }));
    await client.services.gitService.getRepositorySummary({
      workspacePath: "/same",
    });
    await client.services.skillsService.list({ workspacePath: "/same" });
    await client.services.fileWatcherService.watch({
      path: "/same/subdir",
      recursive: true,
    });
    expect(requests.map((request) => request.args)).toEqual([
      [
        {
          workspacePath: "/same",
          viewerScope: { kind: "project", projectId: "project" },
        },
      ],
      [{ workspacePath: "/same" }],
      [
        {
          path: "/same/subdir",
          recursive: true,
          viewerScope: { kind: "project", projectId: "project" },
        },
      ],
    ]);
    expect(
      requests.every(
        (request) => !JSON.stringify(request.args).includes("taskId"),
      ),
    ).toBe(true);
    client.dispose();
  });
  it("原file-watcher动态监听按ID分发，同目录的两watcher不串事件", async () => {
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const send = (value: unknown) =>
      stream.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        });
        options.signal?.addEventListener("abort", () => stream.close(), {
          once: true,
        });
        send({ event: "ready", hello: { connectionId: "connection" } });
        return new Response(body);
      }),
    );
    const client = new CodeHttpChannelClient({ apiBase: "http://host.test" });
    try {
      await client.connect();
      const a: unknown[] = [];
      const b: unknown[] = [];
      client.services.fileWatcherService.onDynamicChange("a")((data) =>
        a.push(data),
      );
      client.services.fileWatcherService.onDynamicChange("b")((data) =>
        b.push(data),
      );
      send({
        event: "service",
        service: "file-watcher",
        name: "onDynamicChange",
        watcherId: "a",
        data: { dirPath: "/same" },
      });
      send({
        event: "service",
        service: "file-watcher",
        name: "onDynamicChange",
        watcherId: "b",
        data: { dirPath: "/same", changedPath: "/same/file" },
      });
      await expect.poll(() => b.length).toBe(1);
      expect(a).toEqual([{ dirPath: "/same" }]);
      expect(b).toEqual([{ dirPath: "/same", changedPath: "/same/file" }]);
    } finally {
      client.dispose();
    }
  });
  it("原终端以当前Task创建，data与exit监听就绪后激活，动态ID隔离快速输出", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const send = (value: unknown) =>
      stream.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    let creates = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (url.endsWith("/events")) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          });
          options.signal?.addEventListener("abort", () => stream.close(), {
            once: true,
          });
          send({ event: "ready", hello: { connectionId: "connection" } });
          return new Response(body);
        }
        const request = JSON.parse(String(options.body));
        requests.push(request);
        if (request.method === "create")
          return new Response(
            JSON.stringify({
              result: {
                id: `terminal-${++creates}`,
                shell: "/bin/sh",
                fontFamily: "",
                fontFamilySource: "fallback",
              },
            }),
          );
        if (request.method === "activate") {
          const terminalId = request.args[0].id;
          send({
            event: "service",
            service: "terminal",
            name: "onDynamicData",
            terminalId,
            data: terminalId === "terminal-1" ? "FIRST" : "SECOND",
          });
          send({
            event: "service",
            service: "terminal",
            name: "onDynamicExit",
            terminalId,
            data: 0,
          });
        }
        return new Response(JSON.stringify({ result: null }));
      }),
    );
    const client = new CodeHttpChannelClient({ apiBase: "http://host.test" });
    try {
      await client.connect();
      client.setViewerContextResolver(() => ({
        kind: "project",
        projectId: "project",
      }));
      await expect(
        client.services.terminalService.create({
          cols: 80,
          rows: 24,
          cwd: "/same",
        }),
      ).rejects.toThrow("Task");
      let taskId = "first-task";
      client.setViewerContextResolver(() => ({ kind: "task", taskId }));
      const first = await client.services.terminalService.create({
        cols: 80,
        rows: 24,
        cwd: "/same",
      });
      taskId = "second-task";
      const second = await client.services.terminalService.create({
        cols: 80,
        rows: 24,
        cwd: "/same",
      });
      const firstData: string[] = [];
      const secondData: string[] = [];
      const exits: number[] = [];
      client.services.terminalService.onDynamicData(first.id)((data) =>
        firstData.push(data),
      );
      expect(
        requests.filter((request) => request.method === "activate"),
      ).toHaveLength(0);
      client.services.terminalService.onDynamicExit(first.id)((exit) =>
        exits.push(exit),
      );
      client.services.terminalService.onDynamicData(second.id)((data) =>
        secondData.push(data),
      );
      client.services.terminalService.onDynamicExit(second.id)((exit) =>
        exits.push(exit),
      );
      await expect.poll(() => exits).toEqual([0, 0]);
      expect(firstData).toEqual(["FIRST"]);
      expect(secondData).toEqual(["SECOND"]);
      expect(
        requests
          .filter((request) => request.method === "create")
          .map((request) => request.args),
      ).toEqual([
        [{ cols: 80, rows: 24, cwd: "/same", taskId: "first-task" }],
        [{ cols: 80, rows: 24, cwd: "/same", taskId: "second-task" }],
      ]);
      expect(
        requests.filter((request) => request.method === "activate"),
      ).toHaveLength(2);
    } finally {
      client.dispose();
    }
  });
  it("文件请求携带当前Task身份；换Task后不按目录猜身份", async () => {
    const { client, requests } = clientWith();
    let viewer: CodeUiViewerScope = { kind: "task", taskId: "first" };
    client.setViewerContextResolver(() => viewer);
    await client.services.fileService.readTextFile({ path: "/work/a.txt" });
    viewer = { kind: "task", taskId: "second" };
    await client.services.fileService.readTextFile({ path: "/work/a.txt" });
    expect(requests[0]?.args).toEqual([
      { path: "/work/a.txt", viewerScope: { kind: "task", taskId: "first" } },
    ]);
    expect(requests[1]?.args).toEqual([
      { path: "/work/a.txt", viewerScope: { kind: "task", taskId: "second" } },
    ]);
    expect(requests[0]).not.toHaveProperty("canvasId");
    client.dispose();
  });
  it("草稿项目使用明确readonly project viewer；无选择时不发送读取", async () => {
    const { client, requests } = clientWith();
    await expect(
      client.services.fileService.readTextFile({ path: "/work/a.txt" }),
    ).rejects.toThrow("先选择");
    expect(requests).toHaveLength(0);
    client.setViewerContextResolver(() => ({
      kind: "project",
      projectId: "project",
    }));
    await client.services.fileService.stat({ path: "/work" });
    expect(requests[0]?.args).toEqual([
      { path: "/work", viewerScope: { kind: "project", projectId: "project" } },
    ]);
    client.dispose();
  });
  it("Human目录选择metadata与当前Task权限分别传输", async () => {
    const { client, requests } = clientWith([]);
    client.setViewerContextResolver(() => ({ kind: "task", taskId: "task" }));
    await client
      .directoryServices()
      .fileService.readdir({ path: "/human-selected", includeHidden: true });
    expect(requests[0]?.args).toEqual([
      {
        path: "/human-selected",
        includeHidden: true,
        humanPurpose: "directory-picker",
      },
    ]);
    client.dispose();
  });
  it("显式打开项目注册canonical身份，byte range保持Uint8Array", async () => {
    const workspace = {
      projectId: "project",
      name: "代码",
      path: "/canonical",
      additionalDirectories: [],
    };
    const opened = clientWith(workspace);
    expect(await opened.client.openWorkspace("/alias")).toEqual(workspace);
    expect(opened.client.projectForPath("/canonical")).toEqual(workspace);
    expect(opened.requests[0]).toMatchObject({
      service: "workspace",
      method: "open",
      args: [{ path: "/alias" }],
    });
    opened.client.dispose();
    const bytes = clientWith({ encoding: "base64", data: "AP+A" });
    bytes.client.setViewerContextResolver(() => ({
      kind: "task",
      taskId: "task",
    }));
    expect(
      await bytes.client.services.fileService.readFileRange({
        path: "/work/binary",
        offset: 0,
        length: 3,
      }),
    ).toEqual(new Uint8Array([0, 255, 128]));
    bytes.client.dispose();
  });
  it("共享目录新Task按选择Project UUID，既有Task RPC按其真实Project/固定目录", async () => {
    const { client, requests } = clientWith([]);
    client.registerWorkspaces([
      {
        projectId: "first",
        name: "一",
        path: "/shared",
        additionalDirectories: [],
      },
      {
        projectId: "second",
        name: "二",
        path: "/shared",
        additionalDirectories: [],
      },
    ]);
    client.workspaces.registerTask({
      taskId: "old-task",
      projectId: "second",
      workspacePath: "/old",
    });
    client.workspaces.selectProject("second");
    const envelope = {
      clientId: "client",
      commandId: "new",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "/shared" },
      issuedAt: 1,
    };
    await client
      .getChannel(ServiceChannels.ZCodeAgent)
      .call("sendConversationCommandV4", [
        { workspacePath: "/shared", envelope },
      ]);
    expect(requests[0]?.args).toEqual([
      {
        workspacePath: "/shared",
        projectId: "second",
        envelope: { ...envelope, payload: { workspaceId: "second" } },
      },
    ]);
    await client
      .getChannel(ServiceChannels.ZCodeTask)
      .call("getTaskMeta", [{ workspacePath: "/shared", taskId: "old-task" }]);
    expect(requests[1]?.args).toEqual([
      { workspacePath: "/old", taskId: "old-task", projectId: "second" },
    ]);
    await client
      .getChannel(ServiceChannels.ZCodeSession)
      .call("readWorkspacePresentation", [{ workspacePath: "/shared" }]);
    expect(requests[2]?.args).toEqual([
      { workspacePath: "/shared", projectId: "second" },
    ]);
    client.dispose();
  });
});

describe("Code 宿主语音转写通道", () => {
  it("multipart POST /api/voice/transcribe：cookie 认证、不手写 content-type、原样返回文本", async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ text: "你好" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const client = new CodeHttpChannelClient({ apiBase: "http://host.test/" });
    try {
      await expect(
        client.transcribeVoice(new Uint8Array([1, 2, 3])),
      ).resolves.toBe("你好");
      expect(calls[0]?.url).toBe("http://host.test/api/voice/transcribe");
      expect(calls[0]?.options.method).toBe("POST");
      expect(calls[0]?.options.credentials).toBe("include");
      expect(calls[0]?.options.body).toBeInstanceOf(FormData);
      // content-type 必须交给浏览器生成（boundary），手写会破坏 multipart 解析
      const headerNames = Object.keys(
        (calls[0]?.options.headers ?? {}) as Record<string, string>,
      ).map((name) => name.toLowerCase());
      expect(headerNames).not.toContain("content-type");
    } finally {
      client.dispose();
    }
  });

  it("服务端失败原因原样透出（设置页那类可读提示不吞成通用错误）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message:
                  "未选择「听」模型。到「设置 → 语音」选一个（内置模型需先下载）。",
              },
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = new CodeHttpChannelClient({ apiBase: "http://host.test" });
    try {
      await expect(
        client.transcribeVoice(new Uint8Array(4)),
      ).rejects.toMatchObject({
        status: 422,
        message:
          "未选择「听」模型。到「设置 → 语音」选一个（内置模型需先下载）。",
      });
    } finally {
      client.dispose();
    }
  });
});
