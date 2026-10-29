import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEdaTools, listEdaParts } from "./eda-tools.js";

const SAMPLE = `(kicad_sch
  (version 20231120)
  (lib_symbols
    (symbol "Device:R" (symbol "R_0_1" (rectangle (start -1 -2.5) (end 1 2.5))))
  )
  (symbol
    (lib_id "Device:R")
    (at 120 100 0)
    (property "Reference" "R1" (at 122 98 0))
    (property "Value" "10k" (at 122 101 0))
  )
  (symbol
    (lib_id "Device:C")
    (at 150 100 0)
    (property "Reference" "C1" (at 152 98 0))
    (property "Value" "100n" (at 152 101 0))
  )
)
`;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "kfw-eda-tools-"));
  dirs.push(dir);
  return dir;
}

describe("EDA agent 工具", () => {
  it("列出顶层元件（位号 / 值 / 库符号），不把 lib_symbols 的定义算成元件", () => {
    expect(listEdaParts(SAMPLE)).toEqual([
      { libId: "Device:R", ref: "R1", value: "10k" },
      { libId: "Device:C", ref: "C1", value: "100n" },
    ]);
  });

  it("写进去的正文，HTTP 端点与编辑器读到的就是同一份", async () => {
    const dir = await fixture();
    const tools = createEdaTools(dir);
    const write = tools.find((tool) => tool.name === "eda_write");
    const read = tools.find((tool) => tool.name === "eda_read");
    expect(write && read).toBeTruthy();

    const result = await write?.execute({ text: SAMPLE });
    expect(result?.structuredContent).toEqual({ bytes: Buffer.byteLength(SAMPLE, "utf8"), parts: 2 });

    // 文档落在实例数据目录的固定位置：HTTP 端点读的是同一个文件。
    expect(await readFile(join(dir, "work", "eda", "schematic.kicad_sch"), "utf8")).toBe(SAMPLE);
    const back = await read?.execute({});
    expect(back?.content[0]?.text).toBe(SAMPLE);
  });

  it("拒绝不是原理图的正文：不能借工具往文档目录里写任意内容", async () => {
    const dir = await fixture();
    const write = createEdaTools(dir).find((tool) => tool.name === "eda_write");
    await expect(write?.execute({ text: "hello" })).rejects.toThrow(/kicad_sch/u);
  });

  it("空文档读出来是可读提示，不是抛错", async () => {
    const dir = await fixture();
    const read = createEdaTools(dir).find((tool) => tool.name === "eda_read");
    const result = await read?.execute({});
    expect(result?.content[0]?.text).toContain("还没有内容");
  });
});
