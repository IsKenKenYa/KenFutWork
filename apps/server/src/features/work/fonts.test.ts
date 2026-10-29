import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addFont,
  fontFamilyName,
  fontFormatOf,
  listFonts,
  MAX_FONT_BYTES,
  manifestFor,
  removeFont,
  workFontsDir,
} from "./fonts.js";

/**
 * 用户字体库：编辑器的 WASM 自绘界面读不到系统字体，只能靠宿主把这些文件映射到
 * 站点 `fonts/` 下。这里锁定三件事——家族名解析、上传幂等与校验、清单格式。
 */

/** 真实结构的 sfnt 片段（只保留 name 表，来自 霞鹜文楷 轻便版 的 name 记录）。 */
const REAL_FONT = readFileSync(
  join(import.meta.dirname, "__fixtures__", "test-font.ttf"),
);

/** 同一字体的两份不同字节：改动 name 表末尾的填充即可得到不同哈希。 */
function variant(suffix: number): Buffer {
  const copy = Buffer.from(REAL_FONT);
  copy.writeUInt8(suffix & 0xff, copy.length - 1);
  return copy;
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "work-fonts-"));
}

describe("用户字体库", () => {
  it("只认 ttf / otf / ttc，其余格式拒绝", () => {
    expect(fontFormatOf("a.ttf")).toBe("ttf");
    expect(fontFormatOf("a.OTF")).toBe("otf");
    expect(fontFormatOf("a.ttc")).toBe("ttc");
    expect(fontFormatOf("a.woff2")).toBeNull();
    expect(fontFormatOf("a.exe")).toBeNull();
  });

  it("从 sfnt 的 name 表取家族名（UTF-16BE 平台）", () => {
    expect(fontFamilyName(REAL_FONT)).toBe("霞鹜文楷 轻便版");
  });

  it("多语言家族名优先取简体中文（不是碰巧第一条的繁中）", () => {
    // 该字体的 name 表顺序是 zh-TW、en-US、zh-CN、zh-HK、zh-MO：
    // 按记录顺序取会得到「霞鶩文楷 輕便版」，必须按语言优先级拿到简体。
    expect(fontFamilyName(REAL_FONT)).toBe("霞鹜文楷 轻便版");
  });

  it("非字体字节没有家族名", () => {
    expect(fontFamilyName(Buffer.from("not a font at all"))).toBeNull();
  });

  it("上传按内容哈希命名，同内容重复上传幂等", async () => {
    const dataDir = tmp();
    const bytes = REAL_FONT;
    const first = await addFont({ dataDir, fileName: "我的字体.ttf", bytes });
    const again = await addFont({ dataDir, fileName: "我的字体.ttf", bytes });
    expect(first.fileName).toBe(again.fileName);
    expect(first.family).toBe("霞鹜文楷 轻便版");
    expect(first.format).toBe("ttf");
    expect(await listFonts(dataDir)).toHaveLength(1);
    expect(readFileSync(join(workFontsDir(dataDir), first.fileName))).toEqual(
      bytes,
    );
  });

  it("不同内容同名不互相覆盖", async () => {
    const dataDir = tmp();
    const a = await addFont({
      dataDir,
      fileName: "font.ttf",
      bytes: variant(1),
    });
    const b = await addFont({
      dataDir,
      fileName: "font.ttf",
      bytes: variant(2),
    });
    expect(a.fileName).not.toBe(b.fileName);
    expect(await listFonts(dataDir)).toHaveLength(2);
  });

  it("拒绝非字体、空文件与超限文件", async () => {
    const dataDir = tmp();
    await expect(
      addFont({ dataDir, fileName: "x.ttf", bytes: Buffer.from("nope") }),
    ).rejects.toThrow(/有效的字体/);
    await expect(
      addFont({ dataDir, fileName: "x.ttf", bytes: Buffer.alloc(0) }),
    ).rejects.toThrow(/空的/);
    await expect(
      addFont({
        dataDir,
        fileName: "x.ttf",
        bytes: Buffer.concat([REAL_FONT, Buffer.alloc(MAX_FONT_BYTES)]),
      }),
    ).rejects.toThrow(/上限/);
    expect(await listFonts(dataDir)).toEqual([]);
  });

  it("删除只能作用于字体目录里的直接文件", async () => {
    const dataDir = tmp();
    const font = await addFont({
      dataDir,
      fileName: "a.ttf",
      bytes: REAL_FONT,
    });
    await removeFont(dataDir, font.fileName);
    expect(await listFonts(dataDir)).toEqual([]);
    await expect(removeFont(dataDir, "../escape.ttf")).rejects.toThrow(
      /不合法/,
    );
    await expect(removeFont(dataDir, "a.txt")).rejects.toThrow(/不合法/);
  });

  it("清单按 craft-fonts 格式输出；中日韩家族名带上 Hani/Hans", async () => {
    const dataDir = tmp();
    await addFont({
      dataDir,
      fileName: "cn.ttf",
      bytes: REAL_FONT,
    });
    await addFont({
      dataDir,
      fileName: "lat.ttf",
      bytes: variant(3),
    });
    const manifest = manifestFor(await listFonts(dataDir));
    const rows = manifest
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    expect(rows).toHaveLength(2);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // 八列：family | style | file | scripts | licence | licence file | sha256 | source
      expect(row.split(" | ")).toHaveLength(8);
      expect(row).toContain("fonts/user/");
    }
    // 家族名含中文（霞鹜文楷）时带 Hani/Hans；纯拉丁名只给 Latn。
    const manifestText = manifestFor([
      { fileName: "cn.ttf", family: "思源宋体", format: "ttf", bytes: 1 },
      { fileName: "lat.ttf", family: "Inter Copy", format: "ttf", bytes: 1 },
    ]);
    expect(manifestText).toContain(
      "思源宋体 | Regular | fonts/user/cn.ttf | Hani,Hans,Latn",
    );
    expect(manifestText).toContain(
      "Inter Copy | Regular | fonts/user/lat.ttf | Latn",
    );
  });
});
