import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { SkillImportSourceError } from "./import-source-support.js";
import { extractZipSource } from "./import-source-zip.js";

// 中间产物统一放仓库 `.scratch/`（已 gitignore），与其它测试同一口径。
const SCRATCH_ROOT = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../"),
  ".scratch",
);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function createDestination(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const directory = mkdtempSync(join(SCRATCH_ROOT, "zip-source-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// fflate 的 zipSync 对字符串值需要显式编码（与 work-host 测试同一口径）
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

function extract(
  archive: Buffer | Readable,
  overrides: Partial<typeof DEFAULT_LIMITS> = {},
  destination = createDestination(),
) {
  const stream: Readable =
    archive instanceof Readable ? archive : Readable.from([archive]);
  return {
    destination,
    promise: extractZipSource({
      stream,
      destination,
      limits: { ...DEFAULT_LIMITS, ...overrides },
      signal: AbortSignal.timeout(15_000),
    }),
  };
}

describe("zip 来源解压", () => {
  it("文件与目录落盘，目录条目不计数", async () => {
    const { destination, promise } = extract(
      zipOf({
        "SKILL.md": "---\nname: demo\n---\n",
        "scripts/run.py": "print(1)",
        "assets/": new Uint8Array(0),
      }),
    );
    const result = await promise;
    expect(result.fileCount).toBe(2);
    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toContain(
      "name: demo",
    );
    expect(readFileSync(join(destination, "scripts/run.py"), "utf8")).toBe(
      "print(1)",
    );
    expect(existsSync(join(destination, "assets"))).toBe(true);
    expect(result.skippedEntries).toBe(0);
  });

  it("同一个包的内容得到同一个来源标识，内容不同标识不同", async () => {
    const archive = zipOf({ "SKILL.md": "内容一" });
    const first = await extract(archive, {}).promise;
    const second = await extract(archive, {}).promise;
    expect(first.sourceKey).toBe(second.sourceKey);
    expect(first.sourceKey).toMatch(/^zip:sha256:[0-9a-f]{64}$/u);

    const third = await extract(zipOf({ "SKILL.md": "内容二" }), {}).promise;
    expect(third.sourceKey).not.toBe(first.sourceKey);
  });

  it("越界路径整包拒绝，目的地不留任何文件", async () => {
    const { destination, promise } = extract(
      zipOf({
        "SKILL.md": "内容",
        "../evil.txt": "越界",
      }),
    );
    await expect(promise).rejects.toThrow(SkillImportSourceError);
    await expect(promise).rejects.toThrow(/暂存目录之外/);
    expect(existsSync(join(destination, "SKILL.md"))).toBe(true);
    expect(existsSync(join(destination, "evil.txt"))).toBe(false);
    expect(existsSync(join(dirname(destination), "evil.txt"))).toBe(false);
  });

  it("Windows 保留名等不可写条目只跳过，其余照常解出", async () => {
    const { destination, promise } = extract(
      zipOf({
        "SKILL.md": "内容",
        "con.txt": "保留名",
        "trailing.": "结尾点",
      }),
    );
    const result = await promise;
    expect(result.skippedEntries).toBe(2);
    expect(result.fileCount).toBe(1);
    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toBe("内容");
  });

  it("解压字节超预算抛 413", async () => {
    const { promise } = extract(
      zipOf({
        "a.txt": "x".repeat(64),
        "b.txt": "y".repeat(64),
      }),
      { maxBytes: 100 },
    );
    await expect(promise).rejects.toMatchObject({ statusCode: 413 });
    await expect(promise).rejects.toThrow(/上限/);
  });

  it("条目数超预算抛 413", async () => {
    const { promise } = extract(
      zipOf({
        "a.txt": "1",
        "b.txt": "2",
        "c.txt": "3",
      }),
      { maxEntries: 2 },
    );
    await expect(promise).rejects.toMatchObject({ statusCode: 413 });
    await expect(promise).rejects.toThrow(/超过 2 个上限/);
  });

  it("空压缩包返回零文件，由暂存层给「压缩包是空的」原因", async () => {
    const { promise } = extract(zipOf({}));
    const result = await promise;
    expect(result.fileCount).toBe(0);
  });

  it("不是 zip 的字节流给「无法解压」原因，不静默当作空包", async () => {
    const { promise } = extract(Buffer.from("这绝对不是一个 zip 包"));
    await expect(promise).rejects.toThrow(SkillImportSourceError);
  });

  it("中途中止以中止原因结束", async () => {
    const stream = new PassThrough();
    const archive = zipOf({
      "SKILL.md": "内容",
      "a.txt": "x".repeat(1024),
    });
    stream.write(archive.subarray(0, 10));
    const reason = new SkillImportSourceError(
      "解压压缩包超过 1 秒，已中止。",
      504,
    );
    const promise = extractZipSource({
      stream,
      destination: createDestination(),
      limits: DEFAULT_LIMITS,
      signal: (() => {
        const controller = new AbortController();
        queueMicrotask(() => {
          controller.abort(reason);
          stream.destroy(reason);
        });
        return controller.signal;
      })(),
    });
    await expect(promise).rejects.toBe(reason);
    await expect(promise).rejects.toMatchObject({ statusCode: 504 });
  });
});
