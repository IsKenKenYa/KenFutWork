import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  type CodeExecutionScope,
} from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import { createExecutionScopes } from "../execution/scope-service.js";
import type { FileLimits } from "./file-types.js";
import {
  loadCodeDirectoryInstructions,
  loadCodeProjectContext,
} from "./project-instructions.js";
import { createCodeFileTools } from "./tool-definitions.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(fileLimits: Partial<FileLimits> = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "code-instructions-")),
  );
  const extra = await realpath(
    await mkdtemp(join(tmpdir(), "code-extra-instructions-")),
  );
  directories.push(root, extra);
  const snapshot: CodeExecutionScope = {
    workspaceId: "2cdb5c27-a1f7-4109-9927-40e0b0822956",
    projectId: "c15b75a5-b7ef-46b5-8b0c-d543dd7769d5",
    taskId: "0432143f-e2b8-4ea6-adea-01f706f537d3",
    generation: 0,
    rootDirectory: root,
    additionalDirectories: [{ path: extra, access: "read-only" }],
    sandboxMode: "workspace-write",
  };
  const scopes = createExecutionScopes({
    resolveFileLimits: async () => ({
      ...AGENT_GOVERNANCE_DEFAULTS,
      ...fileLimits,
    }),
    repository: {
      load: async () => ({
        scope: snapshot,
        state: "ready",
        branchGeneration: 1,
      }),
    },
    viewerService: {
      resolveWorkspace: async () => ({
        id: snapshot.workspaceId,
        name: "工作区",
        type: "personal",
        ownerUserId: "user",
      }),
    },
  });
  const handle = await scopes.openTask(
    {
      id: "user",
      email: "user@example.test",
      accessToken: "test",
      userMetadata: {},
    },
    snapshot.taskId,
  );
  return { root, extra, handle };
}

it("Project 初始上下文只注入主根 AGENTS，子目录与附加只读根不会提升为全局规则", async () => {
  const { root, extra, handle } = await fixture();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "AGENTS.md"), "主项目规则");
  await writeFile(join(root, "src", "AGENTS.md"), "src 局部规则");
  await writeFile(join(extra, "AGENTS.md"), "附加目录规则");
  expect(
    await loadCodeProjectContext(handle, {
      maxTextBytes: 1024,
      maxEntries: 20,
    }),
  ).toEqual({
    instructions: [
      {
        path: join(root, "AGENTS.md"),
        scopeDirectory: root,
        content: "主项目规则",
        truncated: false,
      },
    ],
    skills: [],
    truncated: false,
    issues: [],
  });
});

it("三种项目 Skills 路径先给metadata，正文仍通过真实 Read 按需读取", async () => {
  const { root, handle } = await fixture();
  for (const folder of [".agents", ".claude", ".codex"]) {
    const path = join(root, folder, "skills", "review");
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "SKILL.md"),
      `---\nname: ${folder.slice(1)}-review\ndescription: 检查代码\n---\nSKILL_PRIVATE_BODY`,
    );
  }
  const result = await loadCodeProjectContext(handle, {
    maxTextBytes: 1024,
    maxEntries: 20,
  });
  expect(result.skills).toEqual([
    {
      name: "agents-review",
      description: "检查代码",
      path: join(root, ".agents", "skills", "review", "SKILL.md"),
      files: [],
    },
    {
      name: "claude-review",
      description: "检查代码",
      path: join(root, ".claude", "skills", "review", "SKILL.md"),
      files: [],
    },
    {
      name: "codex-review",
      description: "检查代码",
      path: join(root, ".codex", "skills", "review", "SKILL.md"),
      files: [],
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("SKILL_PRIVATE_BODY");
  expect(
    (await handle.backend.readPage({ path: result.skills[0]?.path ?? "" }))
      .content,
  ).toContain("SKILL_PRIVATE_BODY");
});

it("目录适用规则按主根到子目录排序，附加根规则只出现在显式读取该目录时", async () => {
  const { root, extra, handle } = await fixture();
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, "other"));
  await writeFile(join(root, "AGENTS.md"), "主根");
  await writeFile(join(root, "src", "AGENTS.md"), "src规则");
  await writeFile(join(root, "other", "AGENTS.md"), "其它目录");
  await writeFile(join(extra, "AGENTS.md"), "附加根规则");
  const limits = { maxTextBytes: 1024, maxEntries: 20 };
  expect(
    (
      await loadCodeDirectoryInstructions(
        handle,
        join(root, "src", "nested"),
        limits,
      )
    ).instructions.map((entry) => [entry.scopeDirectory, entry.content]),
  ).toEqual([
    [root, "主根"],
    [join(root, "src"), "src规则"],
  ]);
  expect(
    (
      await loadCodeDirectoryInstructions(handle, extra, limits)
    ).instructions.map((entry) => [entry.scopeDirectory, entry.content]),
  ).toEqual([[extra, "附加根规则"]]);
});

it("Read 的真实输出带局部适用规则，附加目录规则不提升为全局指令", async () => {
  const { root, extra, handle } = await fixture();
  await writeFile(join(root, "AGENTS.md"), "主根规则");
  await writeFile(join(extra, "AGENTS.md"), "附加根规则");
  await writeFile(join(extra, "note.txt"), "附加文件");
  const read = createCodeFileTools({
    backend: handle.backend,
    modelCapabilities: { image: false, pdf: false },
  }).find((tool) => tool.name === "Read");
  if (!read) throw new Error("缺少 Read 工具");
  expect(
    await read.execute(
      { file_path: join(extra, "note.txt") },
      { scopeHandle: handle },
    ),
  ).toMatchObject({
    canonicalOutput: {
      instructions: [
        {
          path: join(extra, "AGENTS.md"),
          scopeDirectory: extra,
          content: "附加根规则",
          truncated: false,
        },
      ],
      instructionsTruncated: false,
    },
    modelContent: [{ type: "text", text: expect.stringContaining("只适用于") }],
  });
});

it("metadata加载不能把未向模型披露的Skill正文记成当前agent已Read", async () => {
  const { root, handle } = await fixture();
  const path = join(root, ".agents", "skills", "review", "SKILL.md");
  await mkdir(join(root, ".agents", "skills", "review"), { recursive: true });
  await writeFile(
    path,
    "---\nname: review\ndescription: 检查代码\n---\n未披露的正文",
  );
  await loadCodeProjectContext(handle, { maxTextBytes: 1024, maxEntries: 20 });
  await expect(
    handle.backend.writeFile({ path, content: "覆盖全文" }),
  ).rejects.toThrow(/read|读取/i);
});

it("根规则按UTF8字节预算截断，不拆Unicode字符且保留真实继续指针", async () => {
  const { root, handle } = await fixture();
  await writeFile(join(root, "AGENTS.md"), "中文🙂\n后续规则");
  const result = await loadCodeProjectContext(handle, {
    maxTextBytes: 8,
    maxEntries: 20,
  });
  expect(result).toMatchObject({
    truncated: true,
    instructions: [
      {
        content: "中文",
        truncated: true,
        continuation: { line: 1, column: 2 },
      },
    ],
  });
  const first = result.instructions[0];
  if (!first?.continuation) throw new Error("截断规则需要真实继续指针");
  expect(
    (
      await handle.backend.readPage({
        path: first.path,
        continuation: first.continuation,
      })
    ).content,
  ).toBe("🙂\n后续规则");
});

it("可容纳的根规则完整加载，不把普通Read页面字符上限当作全文预算", async () => {
  const { root, handle } = await fixture({ codeReadPageCharacters: 128 });
  const content = "规则".repeat(100);
  await writeFile(join(root, "AGENTS.md"), content);
  expect(
    await loadCodeProjectContext(handle, {
      maxTextBytes: 1024,
      maxEntries: 20,
    }),
  ).toMatchObject({
    truncated: false,
    instructions: [{ content, truncated: false }],
  });
});

it.each(["AGENTS", "SKILL"] as const)(
  "%s symlink指向附加只读根时不能提升为主项目全局上下文",
  async (kind) => {
    const { root, extra, handle } = await fixture();
    if (kind === "AGENTS") {
      await writeFile(join(extra, "AGENTS.md"), "附加规则");
      await symlink(join(extra, "AGENTS.md"), join(root, "AGENTS.md"));
    } else {
      await mkdir(join(root, ".agents"));
      await mkdir(join(extra, "review"));
      await writeFile(
        join(extra, "review", "SKILL.md"),
        "---\nname: review\ndescription: 附加目录技能\n---\n正文",
      );
      await symlink(extra, join(root, ".agents", "skills"));
    }
    await expect(
      loadCodeProjectContext(handle, { maxTextBytes: 1024, maxEntries: 20 }),
    ).rejects.toThrow(/主目录/);
  },
);

it("长Skill frontmatter跨Read页解析，metadata预算不足显式省略而非伪造完整技能", async () => {
  const { root, handle } = await fixture({ codeReadPageCharacters: 128 });
  const path = join(root, ".agents", "skills", "review", "SKILL.md");
  await mkdir(join(root, ".agents", "skills", "review"), { recursive: true });
  await writeFile(
    path,
    `---\nname: review\ndescription: ${"d".repeat(240)}\n---\nPRIVATE_BODY`,
  );
  const complete = await loadCodeProjectContext(handle, {
    maxTextBytes: 512,
    maxEntries: 20,
  });
  expect(complete.skills).toEqual([
    { name: "review", description: "d".repeat(240), path, files: [] },
  ]);
  expect(JSON.stringify(complete)).not.toContain("PRIVATE_BODY");
  const limited = await loadCodeProjectContext(handle, {
    maxTextBytes: 32,
    maxEntries: 20,
  });
  expect(limited).toMatchObject({
    skills: [],
    truncated: true,
    issues: [{ path, message: expect.stringContaining("预算") }],
  });
});
