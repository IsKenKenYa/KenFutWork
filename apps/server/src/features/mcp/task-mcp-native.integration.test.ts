import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceSettingsSchema } from "@kenfutwork/shared";
import { afterEach, expect, it, vi } from "vitest";
import { createProcessSandbox } from "../process-sandbox/service.js";
import type { ManagedStdioProcess } from "../process-sandbox/types.js";
import { createTaskMcpService } from "./task-mcp-service.js";
import { taskMcpFixture } from "./test-task-mcp-fixture.js";

const helper = process.env.KENFUTWORK_MCP_TEST_HELPER;
const enabled = process.env.KENFUTWORK_MCP_NATIVE_TEST === "1";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// 独立Node内建stdio JSON-RPC脚本，不复制第三方实现，不依赖Task之外的SDK/npm目录。
const script = `
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const heartbeat = join(process.cwd(), "mcp-heartbeat");
const timer = setInterval(() => appendFileSync(heartbeat, "x"), 20);
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result}) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buffer += data;
  for (let index = buffer.indexOf("\\n"); index !== -1; index = buffer.indexOf("\\n")) {
    const line = buffer.slice(0,index); buffer = buffer.slice(index+1);
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (request.method === "initialize") reply(request.id, {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"scoped-native",version:"1"}});
    else if (request.method === "tools/list") reply(request.id, {tools:[{name:"probe.工作域",description:"实际沙箱与env验证",inputSchema:{type:"object",properties:{outside:{type:"string"},text:{type:"string"}},required:["outside","text"]}}]});
    else if (request.method === "tools/call") {
      let denied = false;
      try { writeFileSync(request.params.arguments.outside, "escaped"); } catch { denied = true; }
      process.stderr.write("stderr不应破坏协议😀\\n");
      reply(request.id, {content:[{type:"text",text:JSON.stringify({text:request.params.arguments.text,denied,explicit:process.env.TASK_EXPLICIT === "current-task-marker",provider:!!process.env.OPENAI_API_KEY,pid:process.pid})}]});
    }
  }
});
process.stdin.on("end", () => { clearInterval(timer); process.exit(0); });
`;

it.skipIf(!enabled || process.platform !== "darwin")(
  "实际compiled helper：Code MCP Task工作域/无ambient provider env/跨Run/外域写拒绝/关闭后无迟到写",
  async () => {
    if (!helper)
      throw new Error(
        "请指定已构建的KENFUTWORK_MCP_TEST_HELPER；本测试不自动重新构建helper。",
      );
    vi.stubEnv("OPENAI_API_KEY", "host-provider-secret-must-not-leak");
    const f = await taskMcpFixture({}, (cleanup) => {
      cleanups.push(cleanup);
    });
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-mcp-native-outside-")),
    );
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(f.root, "native.mjs"), script);
    const children: ManagedStdioProcess[] = [];
    const sandbox = createProcessSandbox({
      helperPath: helper,
      helperExecArgv: [],
      captureRoot: join(f.root, "native-capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    cleanups.push(() => sandbox.close("测试结束"));
    const service = createTaskMcpService({
      version: "1",
      registry: f.registry,
      sandbox: {
        spawnStdio: async (request) => {
          const child = await sandbox.spawnStdio(request);
          children.push(child);
          return child;
        },
      },
      settings: {
        getWorkspaceSettings: async () =>
          workspaceSettingsSchema.parse({
            defaultModel: "fixture",
            processMaxOutputBytes: 4096,
          }),
      },
    });
    cleanups.push(() => service.shutdown("测试结束"));
    const status = await service.create(
      {
        name: "native",
        path: "native.mjs",
        env: { TASK_EXPLICIT: "current-task-marker" },
      },
      f.context,
    );
    const tool = f.registry
      .resolveRunTools(f.resolution())
      .find((entry) => status.toolNames.includes(entry.name));
    if (!tool) throw new Error("真实Code MCP未进入共同Harness。");
    const results: string[] = [];
    for (const run of ["first", "second"]) {
      const result = await f.registry.executeDefinition(
        tool,
        { outside: join(outside, "escape"), text: `Unicode😀${run}` },
        {
          ...f.context,
          runId: run,
          toolCallId: run,
          taskWorkContext: { ...f.work, runId: run },
        },
      );
      const parsed = JSON.parse(JSON.stringify(result));
      const text = parsed.content?.[0]?.text;
      if (typeof text !== "string")
        throw new Error("MCP未返回可校验的真实协议结果。");
      results.push(text);
      expect(JSON.parse(text)).toMatchObject({
        text: `Unicode😀${run}`,
        denied: true,
        explicit: true,
        provider: false,
      });
    }
    expect(children).toHaveLength(1);
    expect(JSON.parse(results[0] ?? "{}").pid).toBe(
      JSON.parse(results[1] ?? "{}").pid,
    );
    expect(children[0]?.snapshot().enforcement?.filesystem).toBe("enforced");
    await expect
      .poll(
        async () =>
          (
            await readFile(join(f.root, "mcp-heartbeat"), "utf8").catch(
              () => "",
            )
          ).length,
      )
      .toBeGreaterThan(0);
    await service.closeTask(
      f.scope.workspaceId,
      f.scope.taskId,
      "实际Task关闭",
    );
    expect(children[0]?.snapshot().exit?.rangeEmpty).toBe(true);
    const before = await readFile(join(f.root, "mcp-heartbeat"), "utf8");
    await delay(100);
    expect(await readFile(join(f.root, "mcp-heartbeat"), "utf8")).toBe(before);
    await expect(
      readFile(join(outside, "escape"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.registry.resolveRunTools(f.resolution())).toHaveLength(0);
  },
);
