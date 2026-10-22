import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  openDesignLastProjectPath,
  readOpenDesignLastProject,
  writeOpenDesignLastProject,
} from "./last-project.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function dataDir() {
  const dir = await mkdtemp(join(tmpdir(), "kfw-od-last-project-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

it("没有文件时返回 null（可重建的投影，不是错误）", async () => {
  expect(readOpenDesignLastProject({ dataDir: await dataDir() })).toBeNull();
});

it("写入后读回项目 id / 名称 / 时间", async () => {
  const dir = await dataDir();
  writeOpenDesignLastProject({
    dataDir: dir,
    project: { projectId: "p-1", name: "订单仪表盘" },
    now: new Date("2026-10-20T01:00:00.000Z"),
  });
  expect(readOpenDesignLastProject({ dataDir: dir })).toEqual({
    projectId: "p-1",
    name: "订单仪表盘",
    updatedAt: "2026-10-20T01:00:00.000Z",
  });
});

it("文件损坏时按「没有」处理，不把面板炸掉", async () => {
  const dir = await dataDir();
  const { writeFile } = await import("node:fs/promises");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(openDesignLastProjectPath(dir), "{not json", "utf8");
  expect(readOpenDesignLastProject({ dataDir: dir })).toBeNull();
});
