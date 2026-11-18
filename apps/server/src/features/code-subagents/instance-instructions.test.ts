import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureDefaultInstructionsFile,
  readInstanceInstructions,
} from "./instance-instructions.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kfw-instance-agents-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("实例级默认 AGENTS.md", () => {
  it("文件不存在时返回 null，不阻断运行", async () => {
    expect(await readInstanceInstructions(dataDir, 1024)).toBeNull();
  });

  it("读取并去掉 BOM 与首尾空白", async () => {
    await writeFile(
      join(dataDir, "AGENTS.md"),
      "\uFEFF  默认规则\n第二行\n",
      "utf8",
    );
    expect(await readInstanceInstructions(dataDir, 1024)).toBe(
      "默认规则\n第二行",
    );
  });

  it("超过字节预算时按 UTF-8 字符边界截断", async () => {
    await writeFile(join(dataDir, "AGENTS.md"), "中文规则🙂后续", "utf8");
    const clipped = await readInstanceInstructions(dataDir, 13);
    expect(clipped).toBe("中文规则");
  });

  it("确保入口文件存在：首次落空文件，已有内容不被覆盖", async () => {
    await ensureDefaultInstructionsFile(dataDir);
    expect((await stat(join(dataDir, "AGENTS.md"))).isFile()).toBe(true);
    expect(await readFile(join(dataDir, "AGENTS.md"), "utf8")).toBe("");
    await writeFile(join(dataDir, "AGENTS.md"), "已有规则", "utf8");
    await ensureDefaultInstructionsFile(dataDir);
    expect(await readFile(join(dataDir, "AGENTS.md"), "utf8")).toBe("已有规则");
  });
});
