import { describe, expect, it } from "vitest";
import {
  classifyArchiveEntryPath,
  SkillImportSourceError,
  SourceBudget,
  withSourceDeadline,
} from "./import-source-support.js";

const DESTINATION = "/staging/root";

function classify(
  name: string,
  backslashIsSeparator: boolean,
): ReturnType<typeof classifyArchiveEntryPath> {
  return classifyArchiveEntryPath(name, {
    backslashIsSeparator,
    destination: DESTINATION,
  });
}

describe("归档条目路径分类", () => {
  it("普通文件与目录按原样放行，目录以结尾斜杠识别", () => {
    expect(classify("SKILL.md", false)).toEqual({
      kind: "file",
      path: "SKILL.md",
    });
    expect(classify("skills/foo/SKILL.md", false)).toEqual({
      kind: "file",
      path: "skills/foo/SKILL.md",
    });
    expect(classify("skills/foo/", false)).toEqual({
      kind: "directory",
      path: "skills/foo",
    });
  });

  it("写到暂存目录之外的路径整包拒绝：绝对路径、.. 与盘符", () => {
    for (const name of [
      "/etc/passwd",
      "../outside.txt",
      "a/../../outside.txt",
      "C:/Users/secret",
      "c:\\data\\secret",
    ]) {
      expect(() => classify(name, true)).toThrow(SkillImportSourceError);
      expect(() => classify(name, true)).toThrow(/暂存目录之外/);
    }
  });

  it("zip 里反斜杠当分隔符；仓库快照里反斜杠是普通字符名（跳过该条目）", () => {
    expect(classify("a\\b.txt", true)).toEqual({
      kind: "file",
      path: "a/b.txt",
    });
    expect(classify("a\\b.txt", false)).toEqual({ kind: "skipped" });
  });

  it("各平台都无法稳定写入的文件名只跳过条目：Windows 保留名、结尾点与空格、非法字符、过长段", () => {
    for (const name of [
      "con",
      "con.txt",
      "COM1",
      "lpt9.zip",
      "prn",
      "trailing.",
      "trailing ",
      "a<b>c.txt",
      "pipe|.txt",
      'quote".txt',
      "tab\tx.txt",
      `${"x".repeat(256)}.txt`,
    ]) {
      expect(classify(name, false), name).toEqual({ kind: "skipped" });
    }
  });

  it("单个 . 段与空段不是合法路径段", () => {
    expect(classify("./a.txt", false)).toEqual({ kind: "skipped" });
    expect(classify("a//b.txt", false)).toEqual({ kind: "skipped" });
  });

  it("拼出超过 Windows 全路径上限的条目跳过，短条目正常放行", () => {
    const longSegment = "y".repeat(120);
    expect(
      classify(`${longSegment}/${longSegment}/${longSegment}`, false),
    ).toEqual({ kind: "skipped" });
    expect(classify(`${longSegment}/SKILL.md`, false)).toEqual({
      kind: "file",
      path: `${longSegment}/SKILL.md`,
    });
  });
});

describe("来源预算", () => {
  const limits = { timeoutMs: 1_000, maxBytes: 10, maxEntries: 3 };
  const megaLimits = {
    timeoutMs: 1_000,
    maxBytes: 10 * 1_048_576,
    maxEntries: 3,
  };

  it("预算内的字节与条目正常计数", () => {
    const budget = new SourceBudget(limits);
    budget.addBytes(10);
    budget.addEntry();
    budget.addEntry();
    budget.addEntry();
    expect(() => budget.addBytes(0)).not.toThrow();
  });

  it("字节超限抛 413，读数带 MB 上限", () => {
    const budget = new SourceBudget(megaLimits);
    budget.addBytes(10 * 1_048_576);
    expect(() => budget.addBytes(1)).toThrow(SkillImportSourceError);
    try {
      budget.addBytes(1);
    } catch (error) {
      expect((error as SkillImportSourceError).statusCode).toBe(413);
      expect((error as Error).message).toContain("10 MB");
    }
  });

  it("条目数超限抛 413，读数带条目上限", () => {
    const budget = new SourceBudget(limits);
    budget.addEntry();
    budget.addEntry();
    budget.addEntry();
    expect(() => budget.addEntry()).toThrow(/超过 3 个上限/);
  });
});

describe("来源总时限", () => {
  it("到点中止并以可读原因拒绝", async () => {
    await expect(
      withSourceDeadline(20, "克隆仓库超过 1 秒，已中止。", async (signal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
        return "never";
      }),
    ).rejects.toMatchObject({
      name: "SkillImportSourceError",
      statusCode: 504,
      message: "克隆仓库超过 1 秒，已中止。",
    });
  });

  it("时限内完成则原样返回结果", async () => {
    await expect(
      withSourceDeadline(1_000, "不该发生。", async () => "done"),
    ).resolves.toBe("done");
  });

  it("时限内的失败原样抛出，不被时限包装", async () => {
    const failure = new SkillImportSourceError("来源有问题。");
    await expect(
      withSourceDeadline(1_000, "不该发生。", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
