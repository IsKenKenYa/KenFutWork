import { existsSync, readFileSync } from "node:fs";
import { workEdaDocumentPath, writeWorkEdaDocument } from "./builtin-editors.js";

/**
 * EDA 原理图的 agent 工具面：读、写、列元件。
 *
 * 与编辑器共用同一个文档（`<dataDir>/work/eda/schematic.kicad_sch`）——用户在 EDA 里
 * 拖动的结果和 agent 写的内容是同一份文件，不存在「谁改的是真的」。
 *
 * 边界：写操作只接受 `kicad_sch` 正文（和 HTTP 端点同一道门），避免把任意内容写进
 * 文档目录；工具本身不解析原理图语义，改结构由 agent 直接编辑 S-expression。
 */

export interface EdaTool {
  name: string;
  scope: "shared";
  access: "read" | "write";
  description: string;
  parameters: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

/** 从原理图正文里摘出顶层元件（`(symbol (lib_id …) …)`）的编号与位号。 */
export function listEdaParts(source: string): Array<{ ref: string; value: string; libId: string }> {
  const parts: Array<{ ref: string; value: string; libId: string }> = [];
  const symbolBlocks = source.matchAll(/\(symbol\s*\(lib_id\s+"([^"]+)"\)([\s\S]*?)\n\s*\)/g);
  for (const match of symbolBlocks) {
    const libId = match[1] ?? "";
    const body = match[2] ?? "";
    const prop = (key: string) =>
      new RegExp(`\\(property\\s+"${key}"\\s+"([^"]*)"`).exec(body)?.[1] ?? "";
    parts.push({ libId, ref: prop("Reference"), value: prop("Value") });
  }
  return parts;
}

export function createEdaTools(dataDir: string): EdaTool[] {
  const path = workEdaDocumentPath(dataDir);
  const read = (): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

  return [
    {
      name: "eda_read",
      scope: "shared",
      access: "read",
      description:
        "读取当前 EDA 原理图（.kicad_sch 文本）。原理图由用户与 agent 共用同一份文件。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const source = read();
        if (!source.trim()) return text("原理图还没有内容。");
        return {
          ...text(source),
          structuredContent: { bytes: Buffer.byteLength(source, "utf8"), parts: listEdaParts(source).length },
        };
      },
    },
    {
      name: "eda_parts",
      scope: "shared",
      access: "read",
      description: "列出原理图里的元件（位号、值、库符号）。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const parts = listEdaParts(read());
        if (parts.length === 0) return text("原理图里还没有元件。");
        return {
          ...text(parts.map((p) => `${p.ref} ${p.value} (${p.libId})`).join("\n")),
          structuredContent: { parts },
        };
      },
    },
    {
      name: "eda_write",
      scope: "shared",
      access: "write",
      description:
        "整体写入 EDA 原理图（.kicad_sch）。传完整文本，不做局部替换；正文必须以 (kicad_sch 开头。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "完整的 kicad_sch 文本" },
        },
        required: ["text"],
      },
      execute: async (input) => {
        const source = input.text;
        if (typeof source !== "string" || !/^\s*\(kicad_sch\b/u.test(source)) {
          throw new Error("这不是 KiCad 原理图：正文必须以 (kicad_sch 开头。");
        }
        await writeWorkEdaDocument(dataDir, source);
        const parts = listEdaParts(source);
        return {
          ...text(`已写入 ${parts.length} 个元件。`),
          structuredContent: { bytes: Buffer.byteLength(source, "utf8"), parts: parts.length },
        };
      },
    },
  ];
}
