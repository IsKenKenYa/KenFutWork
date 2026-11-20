import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, expect, it } from "vitest";

import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import { ScopedFileController } from "./file-controller.js";
import { createFileMutations } from "./file-mutations.js";

/**
 * 删除保护的「先移到回收站」：文件必须真的被移到 `.kenfutwork-trash/<时间戳>/`，
 * 而不是被删掉。这条是「删除可撤销」的唯一保障，所以要验证三件事：
 * 原路径不再存在、回收站里有同内容副本、越界路径仍被拒。
 */
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

const LIMITS = {
  codeReadPageCharacters: 8_000,
  codeReadMaxBytes: 1_000_000,
  codeWriteMaxBytes: 1_000_000,
  codePatchMaxBytes: 1_000_000,
} as never;

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "kfw-trash-")));
  directories.push(directory);
  const root = join(directory, "project");
  await mkdir(join(root, "src"), { recursive: true });
  const projectId = randomUUID();
  const scope: ScopedFilesystemScope = {
    role: "main",
    agentId: "main",
    describe: () => ({
      instanceId: randomUUID(),
      projectId,
      taskId: randomUUID(),
      generation: 1,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: "workspace-write",
    }),
    resolvePath: async (path) => {
      const absolute = resolve(root, path);
      if (absolute !== root && !absolute.startsWith(`${root}${sep}`))
        throw new Error("目录未授权");
      return absolute;
    },
  };
  const mutations = createFileMutations(
    new ScopedFileController(scope, LIMITS),
    LIMITS,
  );
  return { root, mutations };
}

it("moveToTrash 把文件移到 .kenfutwork-trash/<时间戳>/，原路径不再存在", async () => {
  const { root, mutations } = await fixture();
  const source = join(root, "src", "keep.txt");
  await writeFile(source, "important content", "utf8");

  const { trashedPath } = await mutations.moveToTrash({ path: source });

  // 原路径没了
  await expect(readFile(source, "utf8")).rejects.toThrow();
  // 回收站里内容一致
  expect(await readFile(trashedPath, "utf8")).toBe("important content");
  // 落在授权根下的回收站目录里（不是系统临时目录）
  expect(trashedPath.startsWith(join(root, ".kenfutwork-trash"))).toBe(true);
});

it("moveToTrash 保留相对目录结构（不同子目录的同名文件不互相覆盖）", async () => {
  const { root, mutations } = await fixture();
  await mkdir(join(root, "a"), { recursive: true });
  await mkdir(join(root, "b"), { recursive: true });
  const first = join(root, "a", "same.txt");
  const second = join(root, "b", "same.txt");
  await writeFile(first, "from-a", "utf8");
  await writeFile(second, "from-b", "utf8");

  const one = await mutations.moveToTrash({ path: first });
  const two = await mutations.moveToTrash({ path: second });

  expect(await readFile(one.trashedPath, "utf8")).toBe("from-a");
  expect(await readFile(two.trashedPath, "utf8")).toBe("from-b");
});

it("moveToTrash 拒绝不存在的文件，也拒绝越界路径", async () => {
  const { root, mutations } = await fixture();
  await expect(
    mutations.moveToTrash({ path: join(root, "missing.txt") }),
  ).rejects.toThrow(/不存在/u);

  await expect(
    mutations.moveToTrash({ path: join(root, "..", "outside.txt") }),
  ).rejects.toThrow(/未授权/u);
});
