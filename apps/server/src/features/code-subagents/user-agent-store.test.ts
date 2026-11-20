import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createUserAgent,
  deleteUserAgent,
  findUserAgentByName,
  listUserAgents,
  parseAgentMarkdown,
  readUserAgentState,
  serializeAgentMarkdown,
  setUserAgentEnabled,
  updateUserAgent,
  userAgentsDirectory,
  userAgentsStatePath,
} from "./user-agent-store.js";

let root: string;
let dataDir: string;
let directory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kfw-user-agents-"));
  dataDir = join(root, "data");
  directory = userAgentsDirectory(dataDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const config = {
  name: "doc-reviewer",
  description: "审阅文档",
  systemPrompt: "你是文档审阅员。",
  color: "blue" as const,
  modelSelection: { providerId: "provider-1", modelId: "model-a" },
  tools: ["Read", "Grep"],
  permissionMode: "plan" as const,
};

describe("用户智能体 Markdown 存储", () => {
  it("序列化与解析保持全部字段，模型选择可往返", () => {
    const markdown = serializeAgentMarkdown(config);
    const parsed = parseAgentMarkdown(
      markdown,
      join(directory, "doc-reviewer.md"),
      "user",
    );
    if (!("agent" in parsed)) throw new Error(parsed.diagnostic.message);
    expect(parsed.agent).toMatchObject({
      id: "user:user:doc-reviewer",
      name: "doc-reviewer",
      description: "审阅文档",
      systemPrompt: "你是文档审阅员。",
      color: "blue",
      tools: ["Read", "Grep"],
      permissionMode: "plan",
      scope: "user",
    });
    expect(parsed.agent.modelSelection).toEqual({
      providerId: "provider-1",
      modelId: "model-a",
    });
  });

  it("创建后可按名称查找；重命名同时迁移文件与禁用状态", async () => {
    const created = await createUserAgent({
      dataDir,
      directory,
      scope: "user",
      config,
    });
    expect(
      await findUserAgentByName({
        dataDir,
        directory,
        scope: "user",
        name: "DOC-REVIEWER",
        enabledOnly: true,
      }),
    ).toMatchObject({ id: created.id });

    await setUserAgentEnabled(dataDir, created.id, false);
    expect(
      await findUserAgentByName({
        dataDir,
        directory,
        scope: "user",
        name: "doc-reviewer",
        enabledOnly: true,
      }),
    ).toBeNull();

    const renamed = await updateUserAgent({
      dataDir,
      directory,
      scope: "user",
      agentId: created.id,
      config: { ...config, name: "doc-reviewer-2" },
    });
    expect(renamed.id).toBe("user:user:doc-reviewer-2");
    const listed = await listUserAgents(dataDir, "user", directory);
    expect(listed.agents.map((agent) => agent.name)).toEqual([
      "doc-reviewer-2",
    ]);
    expect(listed.state.disabledAgentIds).toEqual([renamed.id]);
    await expect(readFile(created.path, "utf8")).rejects.toThrow();
  });

  it("同名更新覆盖原文件，不产生第二份定义", async () => {
    const created = await createUserAgent({
      dataDir,
      directory,
      scope: "user",
      config,
    });
    const updated = await updateUserAgent({
      dataDir,
      directory,
      scope: "user",
      agentId: created.id,
      config: { ...config, description: "改过的描述" },
    });
    expect(updated.description).toBe("改过的描述");
    const listed = await listUserAgents(dataDir, "user", directory);
    expect(listed.agents).toHaveLength(1);
    expect(listed.agents[0]?.description).toBe("改过的描述");
  });

  it("拒绝非法与重名，不会覆盖已有文件", async () => {
    await createUserAgent({ dataDir, directory, scope: "user", config });
    await expect(
      createUserAgent({ dataDir, directory, scope: "user", config }),
    ).rejects.toThrow(/已存在/);
    await expect(
      createUserAgent({
        dataDir,
        directory,
        scope: "user",
        config: { ...config, name: "中文名" },
      }),
    ).rejects.toThrow(/字母、数字和连字符/);
    await expect(
      createUserAgent({
        dataDir,
        directory,
        scope: "user",
        config: { ...config, name: "explore" },
      }),
    ).rejects.toThrow(/内置派发名/);
  });

  it("删除只删所属文件，并清掉对应禁用记录", async () => {
    const created = await createUserAgent({
      dataDir,
      directory,
      scope: "user",
      config,
    });
    await setUserAgentEnabled(dataDir, created.id, false);
    await deleteUserAgent({
      dataDir,
      directory,
      scope: "user",
      agentId: created.id,
    });
    expect((await listUserAgents(dataDir, "user", directory)).agents).toEqual(
      [],
    );
    expect(await readUserAgentState(dataDir)).toEqual({
      disabledAgentIds: [],
      builtInModelSelectionOverrides: {},
    });
  });

  it("损坏的 Markdown 只产生诊断，不影响其它智能体", async () => {
    await createUserAgent({ dataDir, directory, scope: "user", config });
    await writeFile(join(directory, "broken.md"), "没有 frontmatter", "utf8");
    const listed = await listUserAgents(dataDir, "user", directory);
    expect(listed.agents).toHaveLength(1);
    expect(listed.diagnostics).toEqual([
      expect.objectContaining({ path: join(directory, "broken.md") }),
    ]);
  });

  it("状态文件损坏时回退默认值，不让坏 JSON 卡住设置页", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dataDir, { recursive: true });
    await writeFile(userAgentsStatePath(dataDir), "{not json", "utf8");
    expect(await readUserAgentState(dataDir)).toEqual({
      disabledAgentIds: [],
      builtInModelSelectionOverrides: {},
    });
  });
});
