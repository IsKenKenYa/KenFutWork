import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ToolMessage } from "@langchain/core/messages";
import { afterEach, expect, it } from "vitest";
import {
  createScopedBackend,
  type ScopedFilesystemScope,
} from "../features/execution/scoped-filesystem.js";
import {
  createToolResultOffloadMiddleware,
  createToolResultOffloadWriter,
  prefixByBytes,
  removeTaskToolResultOffloads,
} from "./tool-result-offload.js";

const TASK_ID = "00000000-0000-4000-8000-000000000003";
const RUN_ID = "run-1";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface OffloadMiddleware {
  wrapModelCall(
    request: { messages: unknown[] },
    handler: (request: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

async function fixture(maxBytes = 1_048_576) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "kfw-offload-"));
  directories.push(rootDirectory);
  let revoked = false;
  const scope: ScopedFilesystemScope = {
    agentId: "main",
    role: "main",
    describe: () => ({
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      taskId: TASK_ID,
      generation: 0,
      rootDirectory,
      additionalDirectories: [],
      sandboxMode: "workspace-write",
    }),
    resolvePath: async (path) => {
      if (revoked) throw new Error("执行作用域已撤销");
      const absolute = resolve(rootDirectory, path);
      if (
        absolute !== rootDirectory &&
        !absolute.startsWith(`${rootDirectory}/`)
      )
        throw new Error("目录未授权");
      return absolute;
    },
  };
  const backend = createScopedBackend(scope);
  const writer = createToolResultOffloadWriter({
    taskId: TASK_ID,
    runId: RUN_ID,
    maxBytes,
    guard: async () => {
      await scope.resolvePath(".", "read");
    },
    resolvePath: (relativePath) => scope.resolvePath(relativePath, "write"),
  });
  return {
    rootDirectory,
    backend,
    writer,
    revoke: () => {
      revoked = true;
    },
  };
}

function bigOutput(lines = 40): string {
  return Array.from(
    { length: lines },
    (_, index) => `第 ${index + 1} 行 ${"内容".repeat(4)}`,
  ).join("\n");
}

function toolMessages(): unknown[] {
  return [
    new ToolMessage({
      content: bigOutput(),
      tool_call_id: "call-1",
    }),
  ];
}

async function runMiddleware(
  maxChars: number,
  messages: unknown[],
  writer: Parameters<typeof createToolResultOffloadMiddleware>[0]["writer"],
): Promise<unknown[]> {
  const middleware = createToolResultOffloadMiddleware({
    writer,
    maxChars,
  }) as unknown as OffloadMiddleware;
  const request = { messages };
  let seen: unknown[] = [];
  await middleware.wrapModelCall(request, async (input) => {
    seen = (input as { messages: unknown[] }).messages;
    return input;
  });
  return seen;
}

it("超过阈值时外置原文并换成含路径与行数字节的说明", async () => {
  const { rootDirectory, writer } = await fixture();
  const original = bigOutput();
  const seen = await runMiddleware(100, toolMessages(), writer);
  const message = seen[0] as { content: string; tool_call_id: string };
  expect(message.tool_call_id).toBe("call-1");
  expect(message.content).toContain(".kenfutwork/tool-results");
  expect(message.content).toContain(`${TASK_ID}/${RUN_ID}/call-1.txt`);
  expect(message.content).toMatch(/共 40 行 /);
  expect(message.content.length).toBeLessThan(200);

  const stored = await readFile(
    join(
      rootDirectory,
      ".kenfutwork",
      "tool-results",
      TASK_ID,
      RUN_ID,
      "call-1.txt",
    ),
    "utf8",
  );
  expect(stored).toBe(original);
});

it("未超过阈值时保持原样且不写文件", async () => {
  const { rootDirectory, writer } = await fixture();
  const messages = [
    new ToolMessage({ content: "短输出", tool_call_id: "call-short" }),
  ];
  const seen = await runMiddleware(100, messages, writer);
  expect((seen[0] as { content: string }).content).toBe("短输出");
  await expect(
    access(join(rootDirectory, ".kenfutwork", "tool-results")),
  ).rejects.toThrow();
});

it("同一运行的后续和并发模型请求继续替换已外置的原始输出", async () => {
  const { rootDirectory, writer } = await fixture();
  const messages = toolMessages();
  const middleware = createToolResultOffloadMiddleware({
    writer,
    maxChars: 100,
  }) as unknown as OffloadMiddleware;
  const invoke = () =>
    middleware.wrapModelCall(
      { messages },
      async (request) => request,
    ) as Promise<{
      messages: ToolMessage[];
    }>;
  const first = await invoke();
  const notice = first.messages[0]?.content;
  expect(notice).toContain("工具输出已外置");
  for (const response of [
    await invoke(),
    ...(await Promise.all([invoke(), invoke()])),
  ]) {
    expect(response.messages[0]?.content).toBe(notice);
    expect(response.messages[0]?.tool_call_id).toBe("call-1");
  }
  expect((messages[0] as ToolMessage).content).toBe(bigOutput());
  const directory = join(
    rootDirectory,
    ".kenfutwork",
    "tool-results",
    TASK_ID,
    RUN_ID,
  );
  expect(await readdir(directory)).toEqual(["call-1.txt"]);
  expect(await readFile(join(directory, "call-1.txt"), "utf8")).toBe(
    bigOutput(),
  );
});

it("外置文件可被读取工具按行区间分页读取", async () => {
  const { backend, writer } = await fixture();
  const original = bigOutput();
  const target = await writer.write("call-page", original);
  const page = await backend.readPage({
    path: target.relativePath,
    line: 2,
    limit: 3,
  });
  expect(page.content.trimEnd()).toBe(
    original.split("\n").slice(1, 4).join("\n"),
  );
  expect(page.totalLines).toBe(40);
});

it("并发同键写入幂等覆盖且不产生重复文件", async () => {
  const { rootDirectory, writer } = await fixture();
  const original = bigOutput();
  await Promise.all([
    writer.write("call-same", original),
    writer.write("call-same", original),
  ]);
  const files = await readdir(
    join(rootDirectory, ".kenfutwork", "tool-results", TASK_ID, RUN_ID),
  );
  expect(files).toEqual(["call-same.txt"]);
  expect(
    await readFile(
      join(
        rootDirectory,
        ".kenfutwork",
        "tool-results",
        TASK_ID,
        RUN_ID,
        "call-same.txt",
      ),
      "utf8",
    ),
  ).toBe(original);
});

it("超过单文件上限时只保留可读前缀并在说明标注", async () => {
  const { rootDirectory, writer } = await fixture(64);
  const original = bigOutput();
  const seen = await runMiddleware(100, toolMessages(), writer);
  const notice = (seen[0] as { content: string }).content;
  expect(notice).toContain("写盘只保留前");
  const stored = await readFile(
    join(
      rootDirectory,
      ".kenfutwork",
      "tool-results",
      TASK_ID,
      RUN_ID,
      "call-1.txt",
    ),
    "utf8",
  );
  expect(stored).toBe(prefixByBytes(original, 64));
  expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(64);
});

it("归档或删除清理只移除该 Task 的目录", async () => {
  const { rootDirectory, writer } = await fixture();
  await writer.write("call-a", bigOutput());
  const otherTask = join(rootDirectory, ".kenfutwork", "tool-results", "other");
  await mkdir(otherTask, { recursive: true });
  await removeTaskToolResultOffloads(rootDirectory, TASK_ID);
  await expect(
    access(join(rootDirectory, ".kenfutwork", "tool-results", TASK_ID)),
  ).rejects.toThrow();
  await expect(access(otherTask)).resolves.toBeUndefined();
});

it("归档后迟到写入不复活目录", async () => {
  const { rootDirectory, writer, revoke } = await fixture();
  await writer.write("call-first", bigOutput());
  await removeTaskToolResultOffloads(rootDirectory, TASK_ID);
  revoke();
  await expect(writer.write("call-late", bigOutput())).rejects.toThrow(
    "执行作用域已撤销",
  );
  await expect(
    access(join(rootDirectory, ".kenfutwork", "tool-results", TASK_ID)),
  ).rejects.toThrow();
});
