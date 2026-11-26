import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchGitSkillSource,
  parseGitSkillSource,
} from "./import-source-git.js";
import { withSourceDeadline } from "./import-source-support.js";

// 中间产物统一放仓库 `.scratch/`（已 gitignore），与其它测试同一口径。
const SCRATCH_ROOT = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../"),
  ".scratch",
);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function createWorkDirectory(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const directory = mkdtempSync(join(SCRATCH_ROOT, "git-source-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

describe("仓库地址解析", () => {
  it("规范化末尾斜杠与 .git 后缀，同时保留主机", () => {
    expect(parseGitSkillSource("https://github.com/anthropics/skills")).toEqual(
      {
        url: "https://github.com/anthropics/skills",
        host: "github.com",
      },
    );
    expect(
      parseGitSkillSource("https://github.com/anthropics/skills.git/"),
    ).toEqual({
      url: "https://github.com/anthropics/skills",
      host: "github.com",
    });
  });

  it("只收 https 地址", () => {
    for (const url of [
      "http://github.com/anthropics/skills",
      "ssh://github.com/anthropics/skills",
      "file:///tmp/repo",
    ]) {
      expect(() => parseGitSkillSource(url), url).toThrow(/https:\/\//);
    }
    // scp 形态连 URL 都不是
    expect(() =>
      parseGitSkillSource("git@github.com:anthropics/skills"),
    ).toThrow(/不是合法 URL/);
  });

  it("不收带用户名密码、查询串或片段的地址", () => {
    expect(() =>
      parseGitSkillSource("https://user:pass@github.com/a/b"),
    ).toThrow(/用户名或密码/);
    expect(() => parseGitSkillSource("https://github.com/a/b?token=x")).toThrow(
      /查询串或片段/,
    );
    expect(() => parseGitSkillSource("https://github.com/a/b#readme")).toThrow(
      /查询串或片段/,
    );
  });

  it("云元数据地址一律拒绝", () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://100.100.100.200/metadata/",
    ]) {
      expect(() => parseGitSkillSource(url), url).toThrow(/云元数据/);
    }
  });

  it("地址要写到仓库名（至少两段路径）", () => {
    expect(() => parseGitSkillSource("https://github.com/owner")).toThrow(
      /写到仓库名/,
    );
  });

  it("不是 URL 的输入给可读原因", () => {
    expect(() => parseGitSkillSource("不是地址")).toThrow(/不是合法 URL/);
  });
});

describe("仓库拉取（真实 git，失败路径不依赖网络可达）", () => {
  it("连不上的地址给可读原因并中止", async () => {
    const workDirectory = createWorkDirectory();
    const destination = join(workDirectory, "content");
    mkdirSync(destination, { recursive: true });
    // 端口 9（discard）本机不监听，连接立刻被拒
    const promise = withSourceDeadline(15_000, "超时。", (signal) =>
      fetchGitSkillSource({
        url: "https://127.0.0.1:9/owner/repo",
        destination,
        workDirectory,
        binary: "git",
        limits: { timeoutMs: 15_000, maxBytes: 1_048_576, maxEntries: 100 },
        signal,
      }),
    );
    await expect(promise).rejects.toMatchObject({
      name: "SkillImportSourceError",
      statusCode: 400,
    });
    await expect(promise).rejects.toThrow(
      /连不上仓库服务器|仓库不存在|克隆仓库失败/,
    );
  });

  it("找不到 git 命令时给安装指引", async () => {
    const workDirectory = createWorkDirectory();
    const destination = join(workDirectory, "content");
    mkdirSync(destination, { recursive: true });
    await expect(
      withSourceDeadline(15_000, "超时。", (signal) =>
        fetchGitSkillSource({
          url: "https://127.0.0.1:9/owner/repo",
          destination,
          workDirectory,
          binary: "kfw-git-not-exist",
          limits: { timeoutMs: 15_000, maxBytes: 1_048_576, maxEntries: 100 },
          signal,
        }),
      ),
    ).rejects.toThrow(/找不到 git 命令/);
  });

  it("中止信号终止进行中的克隆", async () => {
    const workDirectory = createWorkDirectory();
    const destination = join(workDirectory, "content");
    mkdirSync(destination, { recursive: true });
    await expect(
      withSourceDeadline(20, "克隆仓库超过 1 秒，已中止。", (signal) =>
        fetchGitSkillSource({
          url: "https://example.com/owner/repo",
          destination,
          workDirectory,
          binary: "git",
          limits: { timeoutMs: 1_000, maxBytes: 1_048_576, maxEntries: 100 },
          signal,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 504 });
  });
});
