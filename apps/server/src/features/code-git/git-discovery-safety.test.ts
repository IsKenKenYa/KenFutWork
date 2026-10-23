import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const git = promisify(execFile);

it("测试临时目录不能识别主仓，只能使用自己初始化的 Git 仓库", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-git-discovery-")),
  );
  try {
    await expect(
      git("git", ["rev-parse", "--show-toplevel"], { cwd: directory }),
    ).rejects.toMatchObject({ code: 128, stdout: "" });
    await git("git", ["init", "--quiet", directory]);
    const own = await git("git", ["rev-parse", "--show-toplevel"], {
      cwd: directory,
    });
    expect(own.stdout.trim()).toBe(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
