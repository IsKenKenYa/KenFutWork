import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { afterEach, expect, it } from "vitest";
import { resolveCheckpointWriteRoots } from "../process-sandbox/plugin.js";
import { resolveCheckpointGitDirectory } from "./git-directory.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "kfw-checkpoint-roots-"));
  fixtures.push(base);
  const checkpointRoot = join(base, "checkpoints");
  const scope: CodeExecutionScope = {
    instanceId: "instance",
    projectId: "project",
    taskId: "task",
    generation: 1,
    rootDirectory: join(base, "main"),
    additionalDirectories: [
      { path: join(base, "extra"), access: "read-write" },
      { path: join(base, "readonly"), access: "read-only" },
    ],
    sandboxMode: "workspace-write",
  };
  const hash = createHash("sha256").update(scope.rootDirectory).digest("hex");
  return {
    checkpointRoot,
    scope,
    short: join(checkpointRoot, `task-${hash.slice(0, 16)}.git`),
    legacy: join(checkpointRoot, "instance", "project", "task.git", hash),
  };
}

it("冷启动沙箱授权与检查点短路径一致，仅创建主根和可写附加根的精确私有目录", async () => {
  const { checkpointRoot, scope, short } = await fixture();
  const roots = await resolveCheckpointWriteRoots(checkpointRoot, scope);
  expect(roots).toHaveLength(2);
  expect(roots[0]).toBe(short);
  expect(
    await resolveCheckpointGitDirectory(
      checkpointRoot,
      scope,
      scope.rootDirectory,
    ),
  ).toBe(roots[0]);
  expect(
    await resolveCheckpointGitDirectory(
      checkpointRoot,
      scope,
      join(scope.rootDirectory, "..", "extra"),
    ),
  ).toBe(roots[1]);
  expect(roots).not.toContain(checkpointRoot);
  for (const root of roots) expect(await realpath(root)).toMatch(/\.git$/);
});

it("旧仓库迁至短布局，服务与沙箱共同保留原内容", async () => {
  const { checkpointRoot, scope, short, legacy } = await fixture();
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "HEAD"), "ref: refs/heads/main\n");
  expect((await resolveCheckpointWriteRoots(checkpointRoot, scope))[0]).toBe(
    short,
  );
  expect(
    await resolveCheckpointGitDirectory(
      checkpointRoot,
      scope,
      scope.rootDirectory,
    ),
  ).toBe(short);
  expect(await readFile(join(short, "HEAD"), "utf8")).toBe(
    "ref: refs/heads/main\n",
  );
});

it("已有短仓库优先，旧仓库不覆盖它", async () => {
  const { checkpointRoot, scope, short, legacy } = await fixture();
  await mkdir(short, { recursive: true });
  await mkdir(legacy, { recursive: true });
  await writeFile(join(short, "HEAD"), "short");
  await writeFile(join(legacy, "HEAD"), "legacy");
  expect(
    await resolveCheckpointGitDirectory(
      checkpointRoot,
      scope,
      scope.rootDirectory,
    ),
  ).toBe(short);
  expect(await readFile(join(short, "HEAD"), "utf8")).toBe("short");
  expect(await readFile(join(legacy, "HEAD"), "utf8")).toBe("legacy");
});

it("旧仓库无法搬迁时服务与沙箱均沿用精确旧目录", async () => {
  const { checkpointRoot, scope, short, legacy } = await fixture();
  await mkdir(legacy, { recursive: true });
  await writeFile(short, "blocked destination");
  expect(
    await resolveCheckpointGitDirectory(
      checkpointRoot,
      scope,
      scope.rootDirectory,
    ),
  ).toBe(legacy);
  expect((await resolveCheckpointWriteRoots(checkpointRoot, scope))[0]).toBe(
    legacy,
  );
  expect(await readFile(short, "utf8")).toBe("blocked destination");
});
