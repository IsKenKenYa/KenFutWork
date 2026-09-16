import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_VIEW_BYTES, readSandboxTextFile } from "./sandbox-file.js";

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
    writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x0a]));

    const view = readSandboxTextFile(root, "logo.png");
    expect(view.binary).toBe(true);
    expect(view.content).toBe("");
  });

  it("越界与目录：给可读原因（不是 ENOENT/EISDIR 原文）", () => {
    const root = makeRoot();
    writeFileSync(join(root, "ok.txt"), "x", "utf8");

    expect(() => readSandboxTextFile(root, "../outside.txt")).toThrow(/越出工作目录/);
    expect(() => readSandboxTextFile(root, "")).toThrow(/是目录/);
    expect(() => readSandboxTextFile(root, "missing.txt")).toThrow(/文件不存在/);
  });
});
