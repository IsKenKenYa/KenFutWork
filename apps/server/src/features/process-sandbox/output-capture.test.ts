import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OutputCapture, readCapturedOutput } from "./output-capture.js";

const dirs: string[] = [];
function tempPath(name = "out.log") {
  const dir = mkdtempSync(join(tmpdir(), "kfw-output-capture-"));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const NUL = "\u0000";

it("preserveNul：系统 consumer 要求逐字节保真时 NUL 分隔符原样保留", () => {
  const path = tempPath();
  const capture = new OutputCapture(path, 64 * 1024);
  try {
    // 影子 Git 的 `ls-files -z` 清单：路径之间就是 NUL；剥掉会把整份清单粘成一个路径。
    capture.append(Buffer.from("a.txt\0dir/b.txt\0", "utf8"));
    expect(capture.read(0, 64 * 1024, true, true).data).toBe(
      "a.txt\0dir/b.txt\0",
    );
    // 缺省仍剥 NUL（默认口径不变）。
    expect(capture.read(0, 64 * 1024, true).data).toBe("a.txtdir/b.txt");
  } finally {
    capture.close();
  }
});

it("命令输出里的 NUL 字节被剥掉（UTF-16LE 输出按 UTF-8 解码的典型形态）", () => {
  const path = tempPath();
  const capture = new OutputCapture(path, 64 * 1024);
  try {
    // `wsl --status` 这类工具在 Windows 上按 UTF-16LE 输出：ASCII 每字符后跟一个 0x00。
    capture.append(Buffer.from("wsl", "utf16le"));
    const output = capture.read(0, 64 * 1024, false);
    expect(output.data).not.toContain(NUL);
    // 剥掉 NUL 后 ASCII 文本正好还原
    expect(output.data).toBe("wsl");
    // 字节游标仍按原始字节计（6 字节 = 3 字符 × 2）
    expect(output.nextOffset).toBe(6);
    expect(output.retainedBytes).toBe(6);
  } finally {
    capture.close();
  }
});

it("二进制片段里的裸 NUL 也被剥掉，其余字节照常保留", () => {
  const path = tempPath();
  const capture = new OutputCapture(path, 64 * 1024);
  try {
    capture.append(Buffer.from([0x61, 0x00, 0x62, 0x00, 0x63]));
    expect(capture.read(0, 64 * 1024, false).data).toBe("abc");
  } finally {
    capture.close();
  }
});

it("readCapturedOutput：从落盘文件读也剥 NUL，且分页游标不受影响", () => {
  const path = tempPath();
  writeFileSync(path, Buffer.from("ab", "utf16le"));
  const stats = { retainedBytes: 4, totalBytes: 4, discardedBytes: 0 };
  const first = readCapturedOutput(
    path,
    stats,
    { offset: 0, maxBytes: 2 },
    true,
  );
  expect(first.data).not.toContain(NUL);
  expect(first.nextOffset).toBe(2);
  const rest = readCapturedOutput(
    path,
    stats,
    { offset: 2, maxBytes: 2 },
    true,
  );
  expect(rest.data).toBe("b");
  expect(rest.nextOffset).toBe(4);
});

it("没有 NUL 的正常输出逐字节不变", () => {
  const path = tempPath();
  const capture = new OutputCapture(path, 64 * 1024);
  try {
    capture.append(Buffer.from("hello\n世界\n", "utf8"));
    expect(capture.read(0, 64 * 1024, true).data).toBe("hello\n世界\n");
  } finally {
    capture.close();
  }
});
