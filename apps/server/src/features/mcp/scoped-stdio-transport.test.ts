import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, it } from "vitest";
import type { ProcessStdioSpawnRequest } from "../process-sandbox/types.js";
import { createScopedMcpTransport } from "./scoped-stdio-transport.js";
import { deferred, stdioSandbox } from "./test-stdio-process.js";

const request: ProcessStdioSpawnRequest = {
  scope: {
    instanceId: "workspace",
    projectId: "project",
    taskId: "task",
    generation: 1,
    rootDirectory: "/task",
    additionalDirectories: [],
    sandboxMode: "workspace-write",
  },
  agentId: "main",
  invocationId: "mcp:task:server",
  argv: { executable: "node", args: ["server.mjs"] },
  cwd: "/task",
  background: true,
  timeoutMs: null,
  env: { EXPLICIT_KEY: "current-task-key" },
  limits: {
    maxOutputBytes: 32,
    previewMaxChars: 16,
    yieldMs: 1,
    killGraceMs: 1,
  },
};

it("真实SDK握手/工具调用只用stdout完整流；capture截断和stderr不破坏协议", async () => {
  const fixture = stdioSandbox();
  const transport = createScopedMcpTransport({
    sandbox: fixture.sandbox,
    request,
    maxMessageBytes: 4096,
  });
  const client = new Client({ name: "Task客户端", version: "1" });
  try {
    await client.connect(transport, { timeout: 1000 });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "echo",
    ]);
    const text = "工作域😀".repeat(50);
    expect(
      await client.callTool({ name: "echo", arguments: { text } }),
    ).toMatchObject({ content: [{ text }] });
    expect(fixture.calls).toEqual([request]);
    expect(
      fixture.children[0]?.process.snapshot().discardedBytes,
    ).toBeGreaterThan(0);
  } finally {
    await client.close();
    for (const child of fixture.children) await child.process.stop("测试清理");
  }
});

it("启动中关闭禁止迟到进程留下，close等真实rangeEmpty后才通知SDK", async () => {
  const spawnGate = deferred<void>();
  const stopGate = deferred<void>();
  const fixture = stdioSandbox({
    spawnGate: spawnGate.promise,
    stopGate: stopGate.promise,
  });
  const transport = createScopedMcpTransport({
    sandbox: fixture.sandbox,
    request,
    maxMessageBytes: 4096,
  });
  let closed = false;
  transport.onclose = () => {
    closed = true;
  };
  const started = transport.start();
  void started.catch(() => {});
  const stopping = transport.stop("Task已关闭");
  spawnGate.resolve();
  await expect.poll(() => fixture.children.length).toBe(1);
  await fixture.children[0]?.stopEntered.promise;
  expect(closed).toBe(false);
  stopGate.resolve();
  await stopping;
  await expect(started).rejects.toThrow(/关闭|中断/);
  expect(closed).toBe(true);
  await expect(
    transport.send({ jsonrpc: "2.0", method: "late" }),
  ).rejects.toThrow(/关闭/);
});

it("stop未确认不宣称连接已关闭；保留失败证据并允许重试清理", async () => {
  let confirmed = false;
  const fixture = stdioSandbox({ confirmed: () => confirmed });
  const transport = createScopedMcpTransport({
    sandbox: fixture.sandbox,
    request,
    maxMessageBytes: 4096,
  });
  let closed = false;
  transport.onclose = () => {
    closed = true;
  };
  await transport.start();
  await expect(transport.stop("插件卸载")).rejects.toMatchObject({
    code: "stop_unconfirmed",
  });
  expect(closed).toBe(false);
  confirmed = true;
  await transport.stop("再次清理");
  expect(closed).toBe(true);
});

it("ProcessSandbox返回其它Task句柄时拒绝握手并真stop", async () => {
  const fixture = stdioSandbox({ ownerTaskId: "other-task" });
  const transport = createScopedMcpTransport({
    sandbox: fixture.sandbox,
    request,
    maxMessageBytes: 4096,
  });
  await expect(transport.start()).rejects.toThrow(/Task|身份/);
  expect(fixture.children[0]?.process.snapshot().exit?.rangeEmpty).toBe(true);
});
