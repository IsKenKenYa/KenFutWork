import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createKnowledgeLibrary } from "./library.js";

/** 「云盘式」托管目录：只负责落盘与列清单，注册/索引由 Provider 负责。 */
async function fixture(maxBytes = 1024) {
  const dataDir = await mkdtemp(join(tmpdir(), "kfw-kb-lib-"));
  return {
    dataDir,
    library: createKnowledgeLibrary({ dataDir, maxBytes }),
  };
}

describe("知识库托管目录", () => {
  it("保存文件并落在 knowledge/library 下", async () => {
    const { dataDir, library } = await fixture();
    const saved = await library.save("note.md", Buffer.from("hello"));
    expect(saved.path).toBe("note.md");
    expect(saved.sizeBytes).toBe(5);
    expect(saved.absolutePath).toBe(
      join(dataDir, "knowledge", "library", "note.md"),
    );
    expect(await readFile(saved.absolutePath, "utf8")).toBe("hello");
    expect((await library.path()).endsWith(join("knowledge", "library"))).toBe(
      true,
    );
  });

  it("重名不覆盖，自动加序号", async () => {
    const { library } = await fixture();
    await library.save("a.md", Buffer.from("first"));
    const second = await library.save("a.md", Buffer.from("second"));
    expect(second.path).toBe("a (2).md");
    expect(await readFile(second.absolutePath, "utf8")).toBe("second");
  });

  it("剥离路径分隔符与上级引用，防止越界写入", async () => {
    const { dataDir, library } = await fixture();
    const saved = await library.save("../../evil.txt", Buffer.from("x"));
    expect(saved.path).toBe("evil.txt");
    // 文件确实落在托管目录内，没有逃到上级
    const root = join(dataDir, "knowledge", "library");
    expect(saved.absolutePath.startsWith(root)).toBe(true);
    expect((await readdir(root)).includes("evil.txt")).toBe(true);
  });

  it("拒绝空文件与超预算文件", async () => {
    const { library } = await fixture(8);
    await expect(library.save("empty.md", Buffer.alloc(0))).rejects.toThrow(
      /空/,
    );
    await expect(
      library.save("big.md", Buffer.from("0123456789")),
    ).rejects.toThrow(/上限/);
  });

  it("列表只返回文件、按名排序，目录未创建时为空", async () => {
    const { library } = await fixture();
    expect(await library.list()).toEqual([]);
    await library.save("b.md", Buffer.from("b"));
    await library.save("a.md", Buffer.from("a"));
    const files = await library.list();
    expect(files.map((file) => file.path)).toEqual(["a.md", "b.md"]);
  });
});
