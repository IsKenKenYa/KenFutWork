import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceSettings } from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";

import type { LocalActor } from "../local-instance/types.js";
import { createProjectMemoryService } from "./project-memory.js";

const actor: LocalActor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: null,
};
const projectId = "22222222-2222-4222-8222-222222222222";
const DAY = 86_400_000;

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createFixture(options?: {
  memoryEnabled?: boolean;
  orphanRetentionDays?: number;
  recoverableWindowDays?: number;
  now?: number;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "kfw-memory-maintain-"));
  fixtures.push(dataDir);
  const settings = {
    codeReadMaxBytes: 4_000,
    codeReadPageCharacters: 300,
    memoryOrphanRetentionDays: options?.orphanRetentionDays ?? 30,
    memoryRecoverableWindowDays: options?.recoverableWindowDays ?? 30,
  } as unknown as InstanceSettings;
  let now = options?.now ?? 1_700_000_000_000;
  const memory = createProjectMemoryService({
    dataDir,
    projects: { listProjects: async () => [{ id: projectId, name: "记忆项目" }] } as never,
    localInstance: {
      resolve: async (value: LocalActor) => ({ instanceId: value.instanceId }),
    } as never,
    preferences: {
      readHumanPreferences: async () => ({
        memoryEnabled: options?.memoryEnabled ?? true,
      }),
    } as never,
    settings: { getInstanceSettings: async () => settings } as never,
    canvases: { getCanvas: async () => ({ projectId }) } as never,
    agentPersistence: { getPersistence: async () => ({ store: {} }) } as never,
    now: () => now,
  });
  return {
    memory,
    root: memory.memoryDirectory(projectId),
    advanceDays: (days: number) => {
      now += days * DAY;
    },
    currentTime: () => now,
  };
}

async function seed(
  root: string,
  files: Record<string, string>,
  indexLines: string[],
): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [name, content] of Object.entries(files))
    await writeFile(join(root, name), `${content}\n`, "utf8");
  await writeFile(join(root, "MEMORY.md"), `${indexLines.join("\n")}\n`, "utf8");
}

it("重复正文只保留被索引引用的一份并把另一份送进回收区", async () => {
  const { memory, root } = await createFixture();
  await seed(
    root,
    { "a.md": "同一结论", "b.md": "同一结论" },
    ["- [结论甲](a.md) — 同一结论", "- [结论乙](b.md) — 同一结论"],
  );
  const result = await memory.maintainProjectMemory(actor, { projectId });
  expect(result.merged).toBe(1);
  expect(result.trashed).toBe(1);
  expect(result.indexUpdated).toBe(true);

  const index = await readFile(join(root, "MEMORY.md"), "utf8");
  expect(index).toContain("(a.md)");
  expect(index).not.toContain("(b.md)");
  await expect(readFile(join(root, "b.md"), "utf8")).rejects.toThrow();

  const trash = await memory.listTrashedMemories(actor, { projectId });
  expect(trash).toHaveLength(1);
  expect(trash[0]?.fileName).toBe("b.md");
  expect(trash[0]?.reason).toBe("duplicate");
});

it("索引悬挂行进回收区且可在窗口内恢复", async () => {
  const { memory, root } = await createFixture();
  await seed(root, {}, ["- [已删除](gone.md) — 旧结论"]);
  await memory.maintainProjectMemory(actor, { projectId });

  const index = await readFile(join(root, "MEMORY.md"), "utf8");
  expect(index).not.toContain("gone.md");
  const trash = await memory.listTrashedMemories(actor, { projectId });
  expect(trash[0]?.reason).toBe("dangling-index");

  await memory.restoreTrashedMemory(actor, {
    projectId,
    trashId: trash[0]!.id,
  });
  const restored = await readFile(join(root, "MEMORY.md"), "utf8");
  expect(restored).toContain("[已删除](gone.md) — 旧结论");
  expect(await memory.listTrashedMemories(actor, { projectId })).toEqual([]);
});

it("回收项过窗口后仍可列出但标记不可恢复，恢复被拒绝", async () => {
  const { memory, root, advanceDays, currentTime } = await createFixture({
    orphanRetentionDays: 1,
    recoverableWindowDays: 30,
  });
  await seed(root, { "old.md": "旧结论" }, []);
  const stamp = new Date(currentTime() - 2 * DAY);
  await utimes(join(root, "old.md"), stamp, stamp);
  await memory.maintainProjectMemory(actor, { projectId });

  advanceDays(31);
  const trash = await memory.listTrashedMemories(actor, { projectId });
  expect(trash).toHaveLength(1);
  expect(trash[0]?.title).toBe("old");
  expect(trash[0]?.restorable).toBe(false);
  await expect(
    memory.restoreTrashedMemory(actor, {
      projectId,
      trashId: trash[0]!.id,
    }),
  ).rejects.toThrow("已过可恢复窗口");
});

it("未被引用且超期的正文进回收区，未超期的保留", async () => {
  const { memory, root, currentTime } = await createFixture({
    orphanRetentionDays: 30,
  });
  await seed(root, { "old.md": "旧笔记", "fresh.md": "新笔记" }, []);
  const oldStamp = new Date(currentTime() - 40 * DAY);
  await utimes(join(root, "old.md"), oldStamp, oldStamp);

  await memory.maintainProjectMemory(actor, { projectId });
  await expect(readFile(join(root, "old.md"), "utf8")).rejects.toThrow();
  expect(await readFile(join(root, "fresh.md"), "utf8")).toContain("新笔记");
  const trash = await memory.listTrashedMemories(actor, { projectId });
  expect(trash.map((entry) => entry.fileName)).toEqual(["old.md"]);
});

it("被索引引用的条目即使很旧也不会自动删除", async () => {
  const { memory, root, currentTime } = await createFixture({
    orphanRetentionDays: 1,
  });
  await seed(root, { "kept.md": "长期结论" }, ["- [长期结论](kept.md) — 长期结论"]);
  const longAgo = new Date(currentTime() - 400 * DAY);
  await utimes(join(root, "kept.md"), longAgo, longAgo);

  const result = await memory.maintainProjectMemory(actor, { projectId });
  expect(result.trashed).toBe(0);
  expect(await readFile(join(root, "kept.md"), "utf8")).toContain("长期结论");
});

it("回收区超过可恢复窗口后永久删除", async () => {
  const { memory, root, advanceDays } = await createFixture({
    recoverableWindowDays: 7,
  });
  await seed(root, { "b.md": "同一结论", "a.md": "同一结论" }, [
    "- [甲](a.md) — 同一结论",
    "- [乙](b.md) — 同一结论",
  ]);
  await memory.maintainProjectMemory(actor, { projectId });
  expect(await readdir(join(root, ".trash"))).toHaveLength(1);

  advanceDays(8);
  const result = await memory.maintainProjectMemory(actor, { projectId });
  expect(result.purged).toBe(1);
  await expect(readdir(join(root, ".trash"))).resolves.toEqual([]);
});

it("保存一条新记忆后自动整理重复正文", async () => {
  const { memory, root } = await createFixture();
  await memory.saveMemory(actor, {
    projectId,
    title: "结论甲",
    content: "统一使用 pnpm",
  });
  await memory.saveMemory(actor, {
    projectId,
    title: "结论乙",
    content: "统一使用 pnpm",
  });

  const files = (await readdir(root))
    .filter((name) => name.endsWith(".md"))
    .sort();
  expect(files).toEqual(["MEMORY.md", "结论甲.md"]);
  const index = await readFile(join(root, "MEMORY.md"), "utf8");
  expect(index).toContain("(结论甲.md)");
  expect(index).not.toContain("(结论乙.md)");
});

it("恢复同名正文时自动加后缀，索引行去重", async () => {
  const { memory, root } = await createFixture();
  await seed(root, { "a.md": "同一结论", "b.md": "同一结论" }, [
    "- [甲](a.md) — 同一结论",
    "- [乙](b.md) — 同一结论",
  ]);
  await memory.maintainProjectMemory(actor, { projectId });
  const trash = await memory.listTrashedMemories(actor, { projectId });
  await writeFile(join(root, "b.md"), "后来的新内容\n", "utf8");

  const restored = await memory.restoreTrashedMemory(actor, {
    projectId,
    trashId: trash[0]!.id,
  });
  expect(restored.fileName).toBe("b-restored.md");
  expect(await readFile(join(root, "b-restored.md"), "utf8")).toContain(
    "同一结论",
  );
  expect(await readFile(join(root, "b.md"), "utf8")).toContain("后来的新内容");
});

it("记忆关闭时整理与恢复都拒绝", async () => {
  const { memory } = await createFixture({ memoryEnabled: false });
  await expect(
    memory.maintainProjectMemory(actor, { projectId }),
  ).rejects.toThrow("记忆功能已关闭");
  await expect(
    memory.listTrashedMemories(actor, { projectId }),
  ).rejects.toThrow("记忆功能已关闭");
});
