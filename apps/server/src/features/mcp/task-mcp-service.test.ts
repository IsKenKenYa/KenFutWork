import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createToolCatalogueMiddleware } from "../tool-catalog/catalogue.js";
import { deferred, type stdioSandbox } from "./test-stdio-process.js";
import { taskMcpFixture } from "./test-task-mcp-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const fixture = (options: Parameters<typeof stdioSandbox>[0] = {}) =>
  taskMcpFixture(options, (cleanup) => {
    cleanups.push(cleanup);
  });

it("Code创建绑定真实Task工作域、只发显式env，动态发现经共同审批执行且跨Run不重复起进程", async () => {
  vi.stubEnv("OPENAI_API_KEY", "server-provider-secret");
  const f = await fixture();
  const created = await f.service.create(
    {
      name: "local",
      path: "server.mjs",
      env: { USER_TOKEN: "current-task-key" },
    },
    f.context,
  );
  expect(created).toMatchObject({
    status: "connected",
    taskId: f.scope.taskId,
    envKeys: ["USER_TOKEN"],
  });
  expect(JSON.stringify(created)).not.toContain("current-task-key");
  expect(f.calls[0]).toMatchObject({
    scope: f.scope,
    agentId: "main",
    argv: { executable: "node", args: [join(f.root, "server.mjs")] },
    env: { USER_TOKEN: "current-task-key" },
    background: true,
    timeoutMs: null,
  });
  expect(JSON.stringify(f.calls)).not.toContain("server-provider-secret");
  const imported = f.registry
    .resolveRunTools(f.resolution())
    .find((tool) => created.toolNames.includes(tool.name));
  if (!imported) throw new Error("Task MCP工具未进入共同registry动态发现。");
  expect(imported.access).toBe("execute");
  expect(imported.scope).toBe("code");
  expect(imported.name).toMatch(/^mcp__task_/);
  const next = {
    ...f.context,
    runId: "run-2",
    toolCallId: "invoke-2",
    taskWorkContext: { ...f.work, runId: "run-2" },
  };
  expect(
    await f.registry.executeDefinition(imported, { text: "跨Run😀" }, next),
  ).toMatchObject({ content: [{ text: "跨Run😀" }] });
  expect(f.calls).toHaveLength(1);
});

it("同Task同名配置并发/重放只有一个真实连接，不同配置需明确卸载", async () => {
  const f = await fixture();
  const input = {
    name: "explicit",
    command: "node",
    args: ["server.mjs"],
    env: { TOKEN: "write-only" },
  };
  const statuses = await Promise.all([
    f.service.install(input, f.context),
    f.service.install(input, { ...f.context, toolCallId: "replay" }),
  ]);
  expect(statuses[0]).toEqual(statuses[1]);
  expect(f.calls).toHaveLength(1);
  await expect(
    f.service.install({ ...input, env: { TOKEN: "different" } }, f.context),
  ).rejects.toMatchObject({ code: "mcp_config_conflict" });
});

it("导入工具Task namespace稳定，跨Task/分支不能借旧定义执行；未知MCP不进readonly角色", async () => {
  const f = await fixture();
  const status = await f.service.install(
    { name: "explicit", command: "node" },
    f.context,
  );
  const [tool] = f.registry.resolveRunTools(f.resolution());
  if (!tool) throw new Error("MCP未发现。");
  await expect(
    tool.execute(
      { text: "foreign" },
      {
        ...f.context,
        taskWorkContext: { ...f.work, branchGeneration: 2 },
      },
    ),
  ).rejects.toThrow(/分支|身份/);
  const readonly = f.handle.derive("explore", "reader");
  expect(
    f.registry.resolveRunTools({ ...f.resolution(), scopeHandle: readonly }),
  ).toHaveLength(0);
  await expect(
    tool.execute({ text: "readonly" }, { ...f.context, scopeHandle: readonly }),
  ).rejects.toThrow(/只读|角色/);
  expect(status.toolNames).toContain(tool.name);
  const foreign = await fixture();
  const foreignStatus = await foreign.service.install(
    { name: "explicit", command: "node" },
    foreign.context,
  );
  expect(foreignStatus.toolNames).not.toEqual(status.toolNames);
  expect(
    f.registry.resolveRunTools({
      ...f.resolution(),
      scopeHandle: foreign.handle,
    }),
  ).toHaveLength(0);
  await expect(
    tool.execute({ text: "foreign-task" }, foreign.context),
  ).rejects.toThrow(/Task|身份|不属于/);
});

it("未绑定Task的创建与symlink越界脚本均fail loud且不spawn", async () => {
  const f = await fixture();
  await expect(
    f.service.create({ name: "missing", path: "server.mjs" }, {}),
  ).rejects.toThrow(/Task|身份/);
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-mcp-outside-")),
  );
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "outside.mjs"), "// outside\n");
  await symlink(join(outside, "outside.mjs"), join(f.root, "escape.mjs"));
  await expect(
    f.service.create({ name: "escape", path: "escape.mjs" }, f.context),
  ).rejects.toThrow(/授权|目录|越界/);
  expect(f.calls).toHaveLength(0);
});

it("Task关闭与迟到stdio启动竞争，rangeEmpty前不完成也不注册工具", async () => {
  const spawnGate = deferred<void>();
  const stopGate = deferred<void>();
  const f = await fixture({
    spawnGate: spawnGate.promise,
    stopGate: stopGate.promise,
  });
  const start = f.service.create(
    { name: "late", path: "server.mjs" },
    f.context,
  );
  void start.catch(() => {});
  await expect.poll(() => f.calls.length).toBe(1);
  let closed = false;
  const closing = f.service
    .closeTask(f.scope.instanceId, f.scope.taskId, "Task已关闭")
    .then(() => {
      closed = true;
    });
  spawnGate.resolve();
  await expect.poll(() => f.children.length).toBe(1);
  await f.children[0]?.stopEntered.promise;
  expect(closed).toBe(false);
  stopGate.resolve();
  await closing;
  await expect(start).rejects.toThrow(/关闭|中断/);
  expect(f.registry.resolveRunTools(f.resolution())).toHaveLength(0);
  await expect(
    f.service.install({ name: "late-replay", command: "node" }, f.context),
  ).rejects.toThrow(/关闭/);
});

it("目录收紧等待MCP真实stop，不能把metadata代际变化当进程退出", async () => {
  const stopGate = deferred<void>();
  const f = await fixture({ stopGate: stopGate.promise });
  await f.service.install({ name: "rights", command: "node" }, f.context);
  let ready = false;
  const change = f.scopes
    .updateTask(f.actor, f.scope.taskId, { sandboxMode: "read-only" })
    .then(() => {
      ready = true;
    });
  await f.children[0]?.stopEntered.promise;
  expect(ready).toBe(false);
  stopGate.resolve();
  await change;
  expect(f.children[0]?.process.snapshot().exit?.rangeEmpty).toBe(true);
  expect(f.registry.resolveRunTools(f.resolution())).toHaveLength(0);
});

it("stop未确认保留失败状态/envKeys，禁止迟到调用并能重试真正清理", async () => {
  let confirmed = false;
  const f = await fixture({ confirmed: () => confirmed });
  await f.service.install(
    { name: "uncertain", command: "node", env: { TOKEN: "private" } },
    f.context,
  );
  await expect(
    f.service.closeTask(f.scope.instanceId, f.scope.taskId, "Task已关闭"),
  ).rejects.toMatchObject({ code: "stop_unconfirmed" });
  expect((await f.service.list(f.context))[0]).toMatchObject({
    status: "error",
    envKeys: ["TOKEN"],
  });
  expect(JSON.stringify(await f.service.list(f.context))).not.toContain(
    "private",
  );
  expect(f.registry.resolveRunTools(f.resolution())).toHaveLength(0);
  confirmed = true;
  await f.service.closeTask(f.scope.instanceId, f.scope.taskId, "再次清理");
  expect(await f.service.list(f.context)).toEqual([]);
});

it("插件shutdown只在所有Task连接真stop后完成，保留Design独立能力", async () => {
  const stopGate = deferred<void>();
  const f = await fixture({ stopGate: stopGate.promise });
  await f.service.install({ name: "unload", command: "node" }, f.context);
  let done = false;
  const unloading = f.service.shutdown("MCP插件卸载").then(() => {
    done = true;
  });
  await f.children[0]?.stopEntered.promise;
  expect(done).toBe(false);
  stopGate.resolve();
  await unloading;
  expect(f.children[0]?.process.snapshot().exit?.rangeEmpty).toBe(true);
  expect(f.registry.resolveRunTools(f.resolution())).toHaveLength(0);
});

it("点/中文/长名称由公共ToolSearch找到ASCII协议alias，调用保留原MCP方法名", async () => {
  const original = "读取.长方法/😀".repeat(20);
  const f = await fixture({ toolName: original });
  const status = await f.service.install(
    { name: "native.server".repeat(10), command: "node" },
    f.context,
  );
  const [wireName] = status.toolNames;
  expect(wireName).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  const middleware = createToolCatalogueMiddleware(
    { registry: f.registry, resolution: f.resolution(), execution: f.context },
    { generation: 1, names: new Set() },
    async () => 10,
  );
  const search = middleware.tools?.find(
    (candidate) => "name" in candidate && candidate.name === "ToolSearch",
  );
  if (!search || !("invoke" in search) || typeof search.invoke !== "function")
    throw new Error("共同ToolSearch未提供SDK工具。");
  expect(await search.invoke({ query: "读取.长方法" })).toMatchObject({
    tools: [{ name: wireName }],
  });
  const imported = f.registry
    .resolveRunTools(f.resolution())
    .find((entry) => entry.name === wireName);
  if (!imported) throw new Error("已激活MCP alias未注册。");
  expect(
    await f.registry.executeDefinition(
      imported,
      { text: "原RPC名称保真" },
      { ...f.context, toolCallId: "alias-call" },
    ),
  ).toMatchObject({ content: [{ text: "原RPC名称保真" }] });
  const call = f.children[0]?.requests
    .map((line) => JSON.parse(line))
    .find((message) => message.method === "tools/call");
  expect(call?.params.name).toBe(original);
});
