import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSkillImportSourceStager,
  normalizeUploadFileName,
} from "./import-source-staging.js";

// 中间产物统一放仓库 `.scratch/`（已 gitignore），与其它测试同一口径。
const SCRATCH_ROOT = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../"),
  ".scratch",
);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function createParentDirectory(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const directory = mkdtempSync(join(SCRATCH_ROOT, "zip-staging-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const INSTANCE_A = "00000000-0000-4000-8000-0000000000a1";
const INSTANCE_B = "00000000-0000-4000-8000-0000000000b2";

const encoder = new TextEncoder();
function zipOf(files: Record<string, string | Uint8Array>): Buffer {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, content]) => [
          name,
          typeof content === "string" ? encoder.encode(content) : content,
        ]),
      ),
    ),
  );
}

const DEFAULT_LIMITS = {
  timeoutMs: 15_000,
  maxBytes: 1_048_576,
  maxEntries: 100,
};

/** 现读保留策略：测试里直接返回常量，并可按实例分档。 */
function fakePolicy(options: {
  ttlMs?: number;
  maxSources?: number;
  policies?: Record<string, { ttlMs: number; maxSources: number }>;
  onRead?: () => void;
}) {
  return async (instanceId: string) => {
    options.onRead?.();
    return (
      options.policies?.[instanceId] ?? {
        ttlMs: options.ttlMs ?? 1_800_000,
        maxSources: options.maxSources ?? 8,
      }
    );
  };
}

describe("暂存来源登记表", () => {
  it("stageZip 后可按 id 找到，释放后目录一并删除", async () => {
    const parent = createParentDirectory();
    const stager = createSkillImportSourceStager({
      readPolicy: fakePolicy({}),
      parentDirectory: parent,
    });
    const staged = await stager.stageZip({
      instanceId: INSTANCE_A,
      fileName: "demo.zip",
      stream: Readable.from([zipOf({ "SKILL.md": "内容" })]),
      limits: DEFAULT_LIMITS,
    });
    expect(staged.kind).toBe("zip");
    expect(staged.label).toBe("demo.zip");
    expect(staged.sourceKey).toMatch(/^zip:sha256:/u);

    const found = await stager.find(INSTANCE_A, staged.id);
    expect(found?.rootPath).toBe(staged.rootPath);
    expect(existsSync(staged.rootPath)).toBe(true);

    expect(await stager.release(INSTANCE_A, staged.id)).toBe(true);
    expect(await stager.find(INSTANCE_A, staged.id)).toBeUndefined();
    expect(existsSync(staged.workDirectory)).toBe(false);
  });

  it("别的实例看不见、也释放不了本实例的来源", async () => {
    const stager = createSkillImportSourceStager({
      readPolicy: fakePolicy({}),
      parentDirectory: createParentDirectory(),
    });
    const staged = await stager.stageZip({
      instanceId: INSTANCE_A,
      fileName: "demo.zip",
      stream: Readable.from([zipOf({ "SKILL.md": "内容" })]),
      limits: DEFAULT_LIMITS,
    });
    expect(await stager.find(INSTANCE_B, staged.id)).toBeUndefined();
    expect(await stager.release(INSTANCE_B, staged.id)).toBe(false);
    // 本实例仍在，目录未动
    expect(await stager.find(INSTANCE_A, staged.id)).toBeDefined();
    expect(existsSync(staged.workDirectory)).toBe(true);
    await stager.releaseAll(INSTANCE_A);
    expect(existsSync(staged.workDirectory)).toBe(false);
  });

  it("超过保留期后顺手清理，不再返回", async () => {
    const parent = createParentDirectory();
    let now = 1_000_000;
    const stager = createSkillImportSourceStager({
      readPolicy: fakePolicy({ ttlMs: 100 }),
      parentDirectory: parent,
      now: () => now,
    });
    const staged = await stager.stageZip({
      instanceId: INSTANCE_A,
      fileName: "demo.zip",
      stream: Readable.from([zipOf({ "SKILL.md": "内容" })]),
      limits: DEFAULT_LIMITS,
    });
    now += 101;
    expect(await stager.find(INSTANCE_A, staged.id)).toBeUndefined();
    expect(existsSync(staged.workDirectory)).toBe(false);
  });

  it("保留期内未过期的不受影响，到点边界起算过期", async () => {
    let now = 1_000_000;
    const stager = createSkillImportSourceStager({
      readPolicy: fakePolicy({ ttlMs: 100 }),
      parentDirectory: createParentDirectory(),
      now: () => now,
    });
    const staged = await stager.stageZip({
      instanceId: INSTANCE_A,
      fileName: "demo.zip",
      stream: Readable.from([zipOf({ "SKILL.md": "内容" })]),
      limits: DEFAULT_LIMITS,
    });
    now += 99;
    expect((await stager.list(INSTANCE_A)).map((s) => s.id)).toEqual([
      staged.id,
    ]);
    expect(existsSync(staged.workDirectory)).toBe(true);
    now += 1;
    expect(await stager.list(INSTANCE_A)).toEqual([]);
    expect(existsSync(staged.workDirectory)).toBe(false);
  });

  it("同实例来源数超上限时删最早的", async () => {
    const stager = createSkillImportSourceStager({
      readPolicy: fakePolicy({ maxSources: 2 }),
      parentDirectory: createParentDirectory(),
    });
    const first = await stager.stageZip({
      instanceId: INSTANCE_A,
      fileName: "one.zip",
      stream: Readable.from([zipOf({ "SKILL.md": "1" })]),
      limits: DEFAULT_LIMITS,
    });
    const second = await stager.stageZip({
      instanceId: INSTANCE_A,
      fileName: "two.zip",
      stream: Readable.from([zipOf({ "SKILL.md": "2" })]),
      limits: DEFAULT_LIMITS,
    });
    const third = await stager.stageZip({
      instanceId: INSTANCE_A,
      fileName: "three.zip",
      stream: Readable.from([zipOf({ "SKILL.md": "3" })]),
      limits: DEFAULT_LIMITS,
    });
    const ids = (await stager.list(INSTANCE_A)).map((s) => s.id);
    expect(ids).toEqual([second.id, third.id]);
    expect(existsSync(first.workDirectory)).toBe(false);
    expect(existsSync(third.workDirectory)).toBe(true);
    // 别的实例不受本实例上限影响
    const other = await stager.stageZip({
      instanceId: INSTANCE_B,
      fileName: "other.zip",
      stream: Readable.from([zipOf({ "SKILL.md": "b" })]),
      limits: DEFAULT_LIMITS,
    });
    expect(await stager.find(INSTANCE_B, other.id)).toBeDefined();
  });

  it("空压缩包给可读原因，暂存目录不残留", async () => {
    const parent = createParentDirectory();
    const stager = createSkillImportSourceStager({
      readPolicy: fakePolicy({}),
      parentDirectory: parent,
    });
    await expect(
      stager.stageZip({
        instanceId: INSTANCE_A,
        fileName: "empty.zip",
        stream: Readable.from([zipOf({})]),
        limits: DEFAULT_LIMITS,
      }),
    ).rejects.toThrow(/压缩包是空的/);
    expect(
      readdirSync(parent).filter((name) => name.startsWith("kfw-")),
    ).toEqual([]);
  });

  it("stageGit 失败给可读原因，暂存目录不残留", async () => {
    const parent = createParentDirectory();
    const stager = createSkillImportSourceStager({
      readPolicy: fakePolicy({}),
      parentDirectory: parent,
    });
    await expect(
      stager.stageGit({
        instanceId: INSTANCE_A,
        // 端口 9（discard）本机不监听，连接立刻被拒
        url: "https://127.0.0.1:9/owner/repo",
        binary: "git",
        limits: DEFAULT_LIMITS,
      }),
    ).rejects.toMatchObject({ name: "SkillImportSourceError" });
    expect(
      readdirSync(parent).filter((name) => name.startsWith("kfw-")),
    ).toEqual([]);
  });

  it("dispose 清空全部实例的暂存目录", async () => {
    const stager = createSkillImportSourceStager({
      readPolicy: fakePolicy({}),
      parentDirectory: createParentDirectory(),
    });
    const staged = await stager.stageZip({
      instanceId: INSTANCE_A,
      fileName: "demo.zip",
      stream: Readable.from([zipOf({ "SKILL.md": "内容" })]),
      limits: DEFAULT_LIMITS,
    });
    stager.dispose();
    expect(existsSync(staged.workDirectory)).toBe(false);
    expect(await stager.list(INSTANCE_A)).toEqual([]);
  });
});

describe("上传文件名规范化", () => {
  it("只留基本名，剥掉路径分隔与控制字符", () => {
    expect(normalizeUploadFileName("demo.zip")).toBe("demo.zip");
    expect(normalizeUploadFileName("C:\\下载\\技能包.zip")).toBe("技能包.zip");
    expect(normalizeUploadFileName("/var/tmp/demo.zip")).toBe("demo.zip");
    expect(normalizeUploadFileName("de\u0000mo.zip")).toBe("demo.zip");
  });

  it("过长文件名截断，空名给可读原因", () => {
    expect(normalizeUploadFileName("x".repeat(500)).length).toBe(200);
    expect(() => normalizeUploadFileName(undefined)).toThrow(/没有名字/);
    expect(() => normalizeUploadFileName("")).toThrow(/没有名字/);
    expect(() => normalizeUploadFileName("\\")).toThrow(/没有名字/);
  });
});
