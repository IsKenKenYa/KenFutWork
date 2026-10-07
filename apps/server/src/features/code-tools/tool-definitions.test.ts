import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createScopedBackend,
  type ScopedFilesystemScope,
} from "../execution/scoped-filesystem.js";
import { createCodeFileTools } from "./tool-definitions.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "code-tools-"));
  directories.push(rootDirectory);
  const scope: ScopedFilesystemScope = {
    role: "main",
    agentId: "main",
    describe: () => ({
      instanceId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      taskId: "00000000-0000-4000-8000-000000000003",
      generation: 0,
      rootDirectory,
      additionalDirectories: [],
      sandboxMode: "workspace-write",
    }),
    resolvePath: async (path) => {
      const result = resolve(rootDirectory, path);
      if (!result.startsWith(`${rootDirectory}/`) && result !== rootDirectory)
        throw new Error("目录未授权");
      return result;
    },
  };
  const backend = createScopedBackend(scope);
  const tools = createCodeFileTools({
    backend,
    modelCapabilities: { image: false, pdf: false },
  });
  return { tools, backend, rootDirectory };
}

it("core file tools consume one scoped backend and preserve ZCode canonical output with model display projections", async () => {
  const { tools, rootDirectory } = await fixture();
  expect(tools.map((tool) => tool.name)).toEqual([
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "ApplyPatch",
    "preview_file",
    "diff_files",
  ]);
  const write = tools.find((tool) => tool.name === "Write");
  const read = tools.find((tool) => tool.name === "Read");
  const edit = tools.find((tool) => tool.name === "Edit");
  if (!write || !read || !edit) throw new Error("缺少核心工具");
  const created = await write.execute(
    { file_path: "note.txt", content: "first\n" },
    { toolCallId: "create" },
  );
  expect(created).toMatchObject({
    canonicalOutput: {
      type: "create",
      filePath: join(rootDirectory, "note.txt"),
      content: "first\n",
      originalFile: null,
    },
    display: {
      kind: "file_diff",
      filePath: join(rootDirectory, "note.txt"),
      additions: 1,
      deletions: 0,
    },
  });
  expect(await read.execute({ file_path: "note.txt" }, {})).toMatchObject({
    canonicalOutput: {
      type: "text",
      filePath: join(rootDirectory, "note.txt"),
      content: "first\n",
    },
    modelContent: [{ type: "text", text: expect.stringContaining("1\tfirst") }],
  });
  const edited = await edit.execute(
    { file_path: "note.txt", old_string: "first", new_string: "second" },
    { toolCallId: "edit" },
  );
  expect(edited).toMatchObject({
    canonicalOutput: {
      filePath: join(rootDirectory, "note.txt"),
      oldString: "first",
      newString: "second",
      originalFile: "first\n",
      replaceAll: false,
    },
  });
  await expect(read.execute({ file_path: "../outside" }, {})).rejects.toThrow(
    /授权/,
  );
});

it("Grep preserves count/files output pagination and requested context lines", async () => {
  const { tools, backend, rootDirectory } = await fixture();
  await writeFile(
    join(rootDirectory, "a.txt"),
    "before\nneedle one\nneedle two\nafter\n",
  );
  await writeFile(join(rootDirectory, "b.txt"), "needle three\n");
  const grep = tools.find((tool) => tool.name === "Grep");
  if (!grep) throw new Error("缺少Grep");
  expect(
    await grep.execute(
      { pattern: "needle", output_mode: "count", head_limit: 1 },
      {},
    ),
  ).toMatchObject({
    canonicalOutput: {
      content: `${join(rootDirectory, "a.txt")}:2`,
      truncated: true,
    },
  });
  const page = await backend.grepPage({
    pattern: "needle",
    mode: "files_with_matches",
    limit: 1,
  });
  if (!page.continuation) throw new Error("缺少Grep继续指针");
  const next = await backend.grepPage({
    pattern: "needle",
    mode: "files_with_matches",
    limit: 1,
    continuation: page.continuation,
  });
  expect(next.matches.map((match) => match.path)).toEqual([
    join(rootDirectory, "b.txt"),
  ]);
  const context = await grep.execute(
    { pattern: "needle one", output_mode: "content", "-C": 1 },
    {},
  );
  expect(context).toMatchObject({
    canonicalOutput: { content: expect.stringContaining("1:before") },
  });
  expect(context).toMatchObject({
    canonicalOutput: { content: expect.stringContaining("3:needle two") },
  });
});

it("every file producer propagates the actual execution cancellation signal", async () => {
  const { tools, rootDirectory } = await fixture();
  await writeFile(join(rootDirectory, "cancel.txt"), "safe\n");
  const controller = new AbortController();
  controller.abort(new Error("用户取消"));
  const cases: Array<[string, Record<string, unknown>]> = [
    ["Read", { file_path: "cancel.txt" }],
    ["preview_file", { path: "cancel.txt" }],
    ["Glob", { pattern: "**/*" }],
    ["Grep", { pattern: "safe" }],
    ["Write", { file_path: "cancel.txt", content: "unsafe" }],
    [
      "Edit",
      { file_path: "cancel.txt", old_string: "safe", new_string: "unsafe" },
    ],
    [
      "ApplyPatch",
      {
        patch_text:
          "*** Begin Patch\n*** Add File: new.txt\n+unsafe\n*** End Patch",
      },
    ],
    ["diff_files", { beforePath: "cancel.txt", afterPath: "cancel.txt" }],
  ];
  for (const [name, args] of cases) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`缺少${name}`);
    await expect(
      tool.execute(args, { signal: controller.signal }),
    ).rejects.toThrow(/取消/);
  }
});

it("Grep only-matching retains repeated matches on one line and count metadata reports actual matching lines", async () => {
  const { tools, rootDirectory } = await fixture();
  await writeFile(
    join(rootDirectory, "repeated.txt"),
    "needle needle\nneedle\n",
  );
  const grep = tools.find((tool) => tool.name === "Grep");
  if (!grep) throw new Error("缺少Grep");
  const only = await grep.execute(
    { pattern: "needle", output_mode: "content", "-o": true },
    {},
  );
  expect(only).toMatchObject({
    canonicalOutput: {
      content: `${join(rootDirectory, "repeated.txt")}:1:needle\n${join(rootDirectory, "repeated.txt")}:1:needle\n${join(rootDirectory, "repeated.txt")}:2:needle`,
      numMatches: 3,
    },
  });
  expect(
    await grep.execute({ pattern: "needle", output_mode: "count" }, {}),
  ).toMatchObject({ canonicalOutput: { numMatches: 2 } });
});
