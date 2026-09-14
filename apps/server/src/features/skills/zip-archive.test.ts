import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { readZipArchiveEntries, ZipArchiveError } from "./zip-archive.js";

/**
 * 测试用 ZIP 构造器（手写最小 ZIP，避免为测试引入打包依赖）：
 * 覆盖 store(0) 与 deflate(8) 两种压缩方式，与真实工具产物同构。
 */
function buildZip(
  files: Array<{ path: string; content: string; deflate?: boolean }>,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.path, "utf-8");
    const raw = Buffer.from(file.content, "utf-8");
    const method = file.deflate ? 8 : 0;
    const payload = file.deflate ? deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 name flag
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(0, 14); // crc (reader 不校验)
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

describe("zip-archive 最小读取器", () => {
  it("store 与 deflate 两种方式都能读出文本内容", () => {
    const zip = buildZip([
      {
        path: "SKILL.md",
        content: "---\nname: demo\n---\n正文",
        deflate: true,
      },
      { path: "scripts/run.py", content: "print('hi')", deflate: false },
    ]);
    const entries = readZipArchiveEntries(zip);
    expect(entries.map((e) => e.path)).toEqual(["SKILL.md", "scripts/run.py"]);
    expect(entries[0]?.content).toContain("name: demo");
    expect(entries[1]?.content).toBe("print('hi')");
  });

  it("UTF-8 文件名与中文内容往返一致", () => {
    const zip = buildZip([
      { path: "references/说明.md", content: "中文内容 ✅", deflate: true },
    ]);
    const entries = readZipArchiveEntries(zip);
    expect(entries[0]?.path).toBe("references/说明.md");
    expect(entries[0]?.content).toBe("中文内容 ✅");
  });

  it("目录项被跳过（只回文件）", () => {
    const zip = buildZip([
      { path: "scripts/", content: "" },
      { path: "scripts/a.py", content: "a" },
    ]);
    expect(readZipArchiveEntries(zip).map((e) => e.path)).toEqual([
      "scripts/a.py",
    ]);
  });

  it("路径穿越被拒绝（不在解包层放行）", () => {
    const zip = buildZip([{ path: "../evil.sh", content: "rm -rf /" }]);
    expect(() => readZipArchiveEntries(zip)).toThrow(ZipArchiveError);
    expect(() => readZipArchiveEntries(zip)).toThrow(/非法路径/);
  });

  it("绝对路径被拒绝", () => {
    const zip = buildZip([{ path: "/etc/passwd", content: "x" }]);
    expect(() => readZipArchiveEntries(zip)).toThrow(/非法路径/);
  });

  it("加密条目明确报错（不静默产出乱码）", () => {
    const zip = buildZip([{ path: "SKILL.md", content: "x" }]);
    // 打开加密标志（bit 0）——读取器以**中央目录**为准，故补在这里
    zip.writeUInt16LE(0x0801, centralDirectoryOffset(zip) + 8);
    expect(() => readZipArchiveEntries(zip)).toThrow(/加密/);
  });

  it("Zip64 哨兵值明确报错", () => {
    const zip = buildZip([{ path: "SKILL.md", content: "x" }]);
    zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
    expect(() => readZipArchiveEntries(zip)).toThrow(/Zip64/);
  });

  it("非 ZIP 内容报「不是有效 ZIP」而非静默空结果", () => {
    expect(() => readZipArchiveEntries(Buffer.from("hello world"))).toThrow(
      /不是有效的 ZIP/,
    );
  });

  it("单条目超限被拒绝（防 zip bomb）", () => {
    const zip = buildZip([{ path: "big.txt", content: "x".repeat(2048) }]);
    expect(() => readZipArchiveEntries(zip, { maxEntryBytes: 1024 })).toThrow(
      /条目过大/,
    );
  });

  it("总体积超限被拒绝", () => {
    const zip = buildZip([
      { path: "a.txt", content: "x".repeat(600) },
      { path: "b.txt", content: "y".repeat(600) },
    ]);
    expect(() => readZipArchiveEntries(zip, { maxTotalBytes: 1000 })).toThrow(
      /总体积超限/,
    );
  });

  it("不支持的压缩方式明确报错", () => {
    const zip = buildZip([{ path: "a.txt", content: "x" }]);
    zip.writeUInt16LE(12, centralDirectoryOffset(zip) + 10); // method 12 (bzip2)
    expect(() => readZipArchiveEntries(zip)).toThrow(/不支持的压缩方式/);
  });
});

/** 中央目录起始偏移（从 EOCD 反查签名），测试改包用。 */
function centralDirectoryOffset(zip: Buffer): number {
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === 0x02014b50) {
      return i;
    }
  }
  throw new Error("central directory not found in fixture");
}
