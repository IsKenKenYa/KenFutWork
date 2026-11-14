import { mkdir, readFile, writeFile } from "node:fs/promises";

import { defaultAgentsInstructionPath } from "./user-agent-store.js";

/**
 * 实例级默认指令（`<dataDir>/AGENTS.md`）。
 *
 * 与 ZCode 的 `~/.zcode/AGENTS.md` 同义：所有智能体（含子智能体）在每轮运行
 * 都会拿到这段规则；项目根目录的 AGENTS.md 仍然作为项目上下文单独注入。
 * 文件不存在或不可读时返回 null——默认规则是增强，不是运行前置。
 */
export async function readInstanceInstructions(
  dataDir: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const content = await readFile(
      defaultAgentsInstructionPath(dataDir),
      "utf8",
    );
    const trimmed = content.replace(/^\uFEFF/u, "").trim();
    if (!trimmed) return null;
    return clipUtf8(trimmed, maxBytes);
  } catch {
    return null;
  }
}

/**
 * 设置页展示默认 AGENTS.md 入口前先落一个空文件：
 * 外部编辑器打开不存在的路径会报错，用户也就无法「编辑并保存」。
 */
export async function ensureDefaultInstructionsFile(
  dataDir: string,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  try {
    await writeFile(defaultAgentsInstructionPath(dataDir), "", {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** 读取默认指令原文（编辑器用，保留空白）；缺文件时返回空串。 */
export async function readDefaultInstructionsContent(
  dataDir: string,
): Promise<string> {
  try {
    return await readFile(defaultAgentsInstructionPath(dataDir), "utf8");
  } catch {
    return "";
  }
}

/** 写入默认指令原文；调用方负责字节预算校验。 */
export async function writeDefaultInstructionsContent(
  dataDir: string,
  content: string,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(defaultAgentsInstructionPath(dataDir), content, "utf8");
}

function clipUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}
