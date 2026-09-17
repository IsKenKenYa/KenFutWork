import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  listSandboxDir,
  MAX_VIEW_BYTES,
  readSandboxTextFile,
} from "./sandbox-file.js";

/**
 * 沙箱文件预览（R3-2「打开」/ R3-3「文档入口」）。
 *
 * 这里锁三条：越界拒绝（`../` 与绝对路径）、按窗口读（不是先整读再截断）、
 * 二进制只回元信息（别把 png 塞进界面）。
 */
describe("沙箱文件预览", () => {
  const dirs: string[] = [];
  const makeRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), "kfw-sandbox-file-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("读文本文件：回内容、字节数与原路径", () => {
    const root = makeRoot();
    writeFileSync(join(root, "AGENTS.md"), "# 标题\n正文\n", "utf8");

    const view = readSandboxTextFile(root, "AGENTS.md");
    expect(view.content).toBe("# 标题\n正文\n");
    expect(view.bytes).toBe(Buffer.byteLength("# 标题\n正文\n"));
    expect(view.binary).toBe(false);
    expect(view.truncated).toBe(false);
    expect(view.path).toBe("AGENTS.md");
  });

  it("超过上限：只读前 MAX_VIEW_BYTES 字节并标 truncated", () => {
    const root = makeRoot();
    const big = "a".repeat(MAX_VIEW_BYTES + 1024);
    writeFileSync(join(root, "big.txt"), big, "utf8");

    const view = readSandboxTextFile(root, "big.txt");
    expect(view.truncated).toBe(true);
    expect(view.content.length).toBe(MAX_VIEW_BYTES);
    expect(view.bytes).toBe(big.length);
  });

  it("二进制文件：不回内容（避免把 png 当文本塞进界面）", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "logo.png"),
      Buffer.from([0x89, 0x50, 0x00, 0x0a]),
    );

    const view = readSandboxTextFile(root, "logo.png");
    expect(view.binary).toBe(true);
    expect(view.content).toBe("");
  });

  it("越界与目录：给可读原因（不是 ENOENT/EISDIR 原文）", () => {
    const root = makeRoot();
    writeFileSync(join(root, "ok.txt"), "x", "utf8");

    expect(() => readSandboxTextFile(root, "../outside.txt")).toThrow(
      /越出工作目录/,
    );
    expect(() => readSandboxTextFile(root, "")).toThrow(/是目录/);
    expect(() => readSandboxTextFile(root, "missing.txt")).toThrow(
      /文件不存在/,
    );
  });
});

/**
 * 列一层目录（R3-1「文件目录」标签）：目录在前、跳过 `.git`、越界与「不是目录」给可读原因。
 */
describe("目录清单（文件目录标签）", () => {
  const dirs: string[] = [];
  const makeRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), "kfw-dir-list-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录在前、同类按名排序，跳过 .git；给出相对路径与文件大小", () => {
    const root = makeRoot();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "AGENTS.md"), "abc", "utf8");
    writeFileSync(join(root, "z.txt"), "z", "utf8");

    const listing = listSandboxDir(root, "");
    expect(listing.path).toBe("");
    expect(listing.truncated).toBe(false);
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "src",
      "AGENTS.md",
      "z.txt",
    ]);
    expect(listing.entries[0]).toMatchObject({ type: "dir", bytes: null });
    expect(listing.entries[1]).toMatchObject({
      type: "file",
      path: "AGENTS.md",
      bytes: 3,
    });
  });

  it("进子目录时给出带前缀的相对路径（根目录用空串）", () => {
    const root = makeRoot();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "x", "utf8");

    const listing = listSandboxDir(root, "src");
    expect(listing.path).toBe("src");
    expect(listing.entries[0]).toMatchObject({ path: "src/app.ts" });
  });

  it("越界 / 不存在 / 不是目录：都抛可读原因（调用方折 400）", () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.txt"), "x", "utf8");

    expect(() => listSandboxDir(root, "../outside")).toThrow(/越出工作目录/);
    expect(() => listSandboxDir(root, "missing")).toThrow(/目录不存在/);
    expect(() => listSandboxDir(root, "a.txt")).toThrow(/不是目录/);
  });
});
