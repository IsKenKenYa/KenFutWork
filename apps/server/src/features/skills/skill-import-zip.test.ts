import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  importFromZipUrl,
  importSkillFromUrl,
  SkillImportError,
} from "./skill-import-service.js";

/**
 * 技能 ZIP 导入（原 `skill-import-service.ts:801` 的 TODO）。
 * 需求：ZIP 与 tarball 同构产出 —— SKILL.md 解析、附属文件收集、
 * 单层根目录剥离、错误码可诊断。
 */

/** 最小 ZIP 构造器（store/deflate），与 zip-archive.test.ts 同构。 */
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
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

function stubDownload(payload: Buffer, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Internal Server Error",
      arrayBuffer: async () => payload,
    })),
  );
}

const SKILL_MD = `---
name: text-summarizer
description: 把长文案精简成三句话摘要
version: 1.2.0
author: tester
---

# 摘要技能

按步骤执行即可。
`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("技能 ZIP 导入", () => {
  it("zip 解包出 SKILL.md 清单与附属文件（deflate 与 store 混合）", async () => {
    stubDownload(
      buildZip([
        { path: "SKILL.md", content: SKILL_MD, deflate: true },
        { path: "scripts/summarize.py", content: "print('ok')" },
        { path: "references/guide.md", content: "指南", deflate: true },
        { path: "README.md", content: "不在收集目录内" },
      ]),
    );

    const imported = await importFromZipUrl("https://host/text-summarizer.zip");

    expect(imported.manifest.name).toBe("text-summarizer");
    expect(imported.manifest.version).toBe("1.2.0");
    expect(imported.skillContent).toContain("# 摘要技能");
    expect(imported.files.map((f) => f.filePath).sort()).toEqual([
      "references/guide.md",
      "scripts/summarize.py",
    ]);
    expect(imported.files[1]?.mimeType).toContain("text/");
    expect(imported.sourceUrl).toBe("https://host/text-summarizer.zip");
  });

  it("单层包裹目录被剥离（右键压缩文件夹的常见产物）", async () => {
    stubDownload(
      buildZip([
        { path: "my-skill/SKILL.md", content: SKILL_MD, deflate: true },
        { path: "my-skill/scripts/a.py", content: "a" },
      ]),
    );

    const imported = await importFromZipUrl("https://host/my-skill.zip");
    expect(imported.manifest.name).toBe("text-summarizer");
    expect(imported.files.map((f) => f.filePath)).toEqual(["scripts/a.py"]);
  });

  it("缺 SKILL.md 与 package.json：报 manifest_not_found 且提示 zip", async () => {
    stubDownload(buildZip([{ path: "notes.txt", content: "x" }]));
    await expect(
      importFromZipUrl("https://host/empty.zip"),
    ).rejects.toMatchObject({
      code: "manifest_not_found",
    });
    await expect(importFromZipUrl("https://host/empty.zip")).rejects.toThrow(
      /zip/,
    );
  });

  it("下载失败：zip_extract_error 且带状态码", async () => {
    stubDownload(Buffer.alloc(0), { status: 500 });
    const error = await importFromZipUrl("https://host/x.zip").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SkillImportError);
    expect((error as SkillImportError).code).toBe("zip_extract_error");
    expect((error as Error).message).toContain("500");
  });

  it("非 zip 内容：zip_extract_error 包住读取器说明（可诊断）", async () => {
    stubDownload(Buffer.from("not a zip at all"));
    const error = await importFromZipUrl("https://host/bad.zip").catch(
      (e: unknown) => e,
    );
    expect((error as SkillImportError).code).toBe("zip_extract_error");
    expect((error as Error).message).toContain("不是有效的 ZIP");
  });

  it("包内路径穿越：导入层直接拒绝（防御纵深）", async () => {
    stubDownload(buildZip([{ path: "../evil.sh", content: "rm -rf /" }]));
    const error = await importFromZipUrl("https://host/evil.zip").catch(
      (e: unknown) => e,
    );
    expect((error as SkillImportError).code).toBe("zip_extract_error");
    expect((error as Error).message).toContain("非法路径");
  });

  it("importSkillFromUrl 按扩展名分派到 zip（原来是抛 unsupported 的 TODO）", async () => {
    stubDownload(
      buildZip([{ path: "SKILL.md", content: SKILL_MD, deflate: true }]),
    );
    const imported = await importSkillFromUrl("https://host/s.zip");
    expect(imported.manifest.name).toBe("text-summarizer");
  });

  it(".skill 扩展名同样走 zip 分派", async () => {
    stubDownload(
      buildZip([{ path: "SKILL.md", content: SKILL_MD, deflate: true }]),
    );
    const imported = await importSkillFromUrl("https://host/s.skill");
    expect(imported.manifest.name).toBe("text-summarizer");
  });

  it("不支持的来源仍明确报错，且提示已含 zip", async () => {
    const error = await importSkillFromUrl("https://host/x.rar").catch(
      (e: unknown) => e,
    );
    expect((error as SkillImportError).code).toBe("unsupported_source");
    expect((error as Error).message).toContain(".zip");
  });
});
