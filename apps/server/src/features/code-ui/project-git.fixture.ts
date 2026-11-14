import { execFile } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";

const execute = promisify(execFile);

/** 原组件与HTTP回归共用真实仓库，只提交已核验的独占测试目录。 */
export async function createProjectGitFixture(directory: string) {
  const root = join(directory, "project-git");
  const hooks = join(directory, "empty-hooks");
  await mkdir(root);
  await mkdir(hooks);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(directory, "absent-global-config");
  const git = (args: string[]) =>
    execute("git", ["-c", `core.hooksPath=${hooks}`, "-C", root, ...args], {
      cwd: root,
      env,
    });
  await git(["init", "-b", "main"]);
  expect((await stat(join(root, ".git"))).isDirectory()).toBe(true);
  expect((await git(["rev-parse", "--show-toplevel"])).stdout.trim()).toBe(
    await realpath(root),
  );
  await git(["config", "user.name", "Project Git测试"]);
  await git(["config", "user.email", "project-git@test.invalid"]);
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(["add", "--", ".gitignore", "tracked.txt"]);
  await git(["commit", "-m", "项目只读Git基线"]);
  await writeFile(join(root, "tracked.txt"), "base\nproject change\n");
  await writeFile(join(root, "ignored.txt"), "ignored\n");
  return { root: await realpath(root) };
}
