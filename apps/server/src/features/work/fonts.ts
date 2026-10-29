import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { WorkFont, WorkFontFormat } from "@kenfutwork/shared";

/**
 * 用户字体库（`<dataDir>/work/fonts`）。
 *
 * 定位：编辑器是 WASM 自绘，读不到系统字体——只能用包内嵌的或**站点同源**提供的
 * 字体文件。这里把用户上传的 ttf/otf 落到实例数据目录，托管编辑器时映射到站点的
 * `fonts/` 下，并生成一份 `fonts/manifest.txt`（craft-fonts 格式），供
 * PhotoCraft / VectorCraft 这类运行时加载字体的编辑器按需拉取。
 *
 * 边界：
 * - 字体是**用户自己的资产**，只在本机实例里用，不进仓库、不随产品分发；
 * - 存储名由内容哈希派生，用户可控的只有扩展名与展示名，不参与路径；
 * - 解析家族名失败不阻塞上传（退化为文件名），因为能否解析取决于字体格式差异。
 */

const FONT_DIR = "work/fonts";
const FORMAT_BY_EXT: Record<string, WorkFontFormat> = {
  ".ttf": "ttf",
  ".otf": "otf",
  ".ttc": "ttc",
};
/** 单个字体上限：24MB——常见中文字体（含 CJK 全集）在 10–20MB 量级。 */
export const MAX_FONT_BYTES = 24 * 1024 * 1024;

export function workFontsDir(dataDir: string): string {
  return join(dataDir, ...FONT_DIR.split("/"));
}

export function fontFormatOf(fileName: string): WorkFontFormat | null {
  return FORMAT_BY_EXT[extname(fileName).toLowerCase()] ?? null;
}

/** 从 sfnt 的 name 表取家族名（name ID 16 优先，退 1）；取不到返回 null。 */
export function fontFamilyName(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  const version = bytes.readUInt32BE(0);
  const isSfnt =
    version === 0x00010000 ||
    bytes.toString("latin1", 0, 4) === "OTTO" ||
    bytes.toString("latin1", 0, 4) === "true";
  if (!isSfnt) return null;
  const numTables = bytes.readUInt16BE(4);
  if (numTables < 1 || numTables > 64) return null;
  let nameOffset = -1;
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (record + 16 > bytes.length) return null;
    if (bytes.toString("latin1", record, record + 4) === "name") {
      nameOffset = bytes.readUInt32BE(record + 8);
      break;
    }
  }
  if (nameOffset < 0 || nameOffset + 6 > bytes.length) return null;
  const count = bytes.readUInt16BE(nameOffset + 2);
  const storage = nameOffset + bytes.readUInt16BE(nameOffset + 4);
  // 名字取哪一个：字体通常带多语言家族名（简中/繁中/英文）。展示给中文用户，
  // 按「简中 > 其他中文 > 英文 > 其它」挑，而不是碰巧第一条（那常常是 zh-TW 繁中）。
  const candidates: Array<{ text: string; score: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const entry = nameOffset + 6 + i * 12;
    if (entry + 12 > bytes.length) break;
    const platform = bytes.readUInt16BE(entry);
    const languageId = bytes.readUInt16BE(entry + 4);
    const nameId = bytes.readUInt16BE(entry + 6);
    if (nameId !== 16 && nameId !== 1) continue;
    const length = bytes.readUInt16BE(entry + 8);
    const offset = storage + bytes.readUInt16BE(entry + 10);
    if (offset + length > bytes.length) continue;
    const raw = bytes.subarray(offset, offset + length);
    // Windows/Unicode 平台是 UTF-16BE；Mac 平台是单字节（多为 ASCII，够做展示名）。
    const text =
      platform === 3 || platform === 0
        ? Buffer.from(
            raw.length % 2 === 0 ? raw : raw.subarray(0, raw.length - 1),
          )
            .swap16()
            .toString("utf16le")
        : raw.toString("latin1");
    // 字体名里偶有 NUL/控制字符（坏字体常见），剔除后才是可展示的名字。
    const cleaned = [...text]
      .filter((char) => char.codePointAt(0)! > 31)
      .join("")
      .trim();
    if (!cleaned) continue;
    // typographic family（16）比 legacy family（1）更准，给它更高权重。
    const base = nameId === 16 ? 100 : 0;
    candidates.push({
      text: cleaned,
      score: base + nameLanguageScore(languageId),
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.text;
}

/**
 * 家族名的语言优先级（Windows LCID）：简体中文 > 繁体中文 > 英文 > 其它。
 * 中文用户看到的字体名要是「霞鹜文楷」而不是「霞鶩文楷」。
 */
function nameLanguageScore(languageId: number): number {
  switch (languageId) {
    case 0x0804: // zh-CN
    case 0x1004: // zh-SG
      return 40;
    case 0x0404: // zh-TW
    case 0x0c04: // zh-HK
    case 0x1404: // zh-MO
      return 30;
    case 0x0409: // en-US
      return 20;
    default:
      return 10;
  }
}

function safeStem(fileName: string): string {
  const stem = basename(fileName, extname(fileName))
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return stem || "font";
}

export type StoredFont = WorkFont;

async function describe(
  dataDir: string,
  fileName: string,
): Promise<StoredFont> {
  const path = join(workFontsDir(dataDir), fileName);
  const info = await stat(path);
  const bytes = await readFile(path);
  const format = fontFormatOf(fileName) ?? "ttf";
  return {
    fileName,
    family: fontFamilyName(bytes) ?? basename(fileName, extname(fileName)),
    format,
    bytes: info.size,
  };
}

export async function listFonts(dataDir: string): Promise<StoredFont[]> {
  const dir = workFontsDir(dataDir);
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const fonts = await Promise.all(
    names
      .filter((name) => fontFormatOf(name) !== null)
      .map((name) => describe(dataDir, name).catch(() => null)),
  );
  return fonts.filter((font): font is StoredFont => font !== null);
}

/**
 * 落一个字体文件。存储名 `sha16-safeStem.ext`：同内容重复上传幂等覆盖，
 * 不同内容但同名也不会互相顶掉。返回落位后的条目。
 */
export async function addFont(input: {
  dataDir: string;
  fileName: string;
  bytes: Buffer;
}): Promise<StoredFont> {
  const format = fontFormatOf(input.fileName);
  if (!format) throw new Error("只支持 ttf / otf / ttc 字体文件。");
  if (input.bytes.length === 0) throw new Error("字体文件是空的。");
  if (input.bytes.length > MAX_FONT_BYTES)
    throw new Error(
      `字体超过上限：${Math.round(input.bytes.length / 1024 / 1024)}MB > ${MAX_FONT_BYTES / 1024 / 1024}MB。`,
    );
  if (fontFamilyName(input.bytes) === null && !hasSfntHeader(input.bytes))
    throw new Error("这不是有效的字体文件（缺少 sfnt 头）。");
  const dir = workFontsDir(input.dataDir);
  await mkdir(dir, { recursive: true });
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  const ext = extname(input.fileName).toLowerCase();
  const fileName = `${digest.slice(0, 16)}-${safeStem(input.fileName)}${ext}`;
  const target = join(dir, fileName);
  if (!existsSync(target)) await writeFile(target, input.bytes);
  return describe(input.dataDir, fileName);
}

export async function removeFont(dataDir: string, fileName: string) {
  // 只允许删字体目录里的直接文件：文件名不参与路径拼接。
  const safe = fontFormatOf(fileName) !== null && !/[\\/]/u.test(fileName);
  if (!safe) throw new Error("字体名不合法。");
  await rm(join(workFontsDir(dataDir), fileName), { force: true });
}

function hasSfntHeader(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const version = bytes.readUInt32BE(0);
  return (
    version === 0x00010000 ||
    bytes.toString("latin1", 0, 4) === "OTTO" ||
    bytes.toString("latin1", 0, 4) === "true" ||
    bytes.toString("latin1", 0, 4) === "ttcf"
  );
}

/**
 * craft-fonts 格式的清单行：`family | style | file | scripts | licence | licence file | sha256 | source`。
 * 用户字体没有可靠的 script 标注，按「界面字体」给 `Latn`；家族名含中日韩字符时补
 * `Hani/Hans`——Web 编辑器只把标了该 script 的字体当 CJK 回退候选。
 */
export function manifestFor(fonts: StoredFont[]): string {
  const lines = [
    "# KenFutWork 用户字体（用户自行上传，仅本机实例使用）。",
    "# family | style | file | scripts | licence | licence file | sha256 | source",
  ];
  for (const font of fonts) {
    const scripts = /[\u4e00-\u9fff]/u.test(font.family)
      ? "Hani,Hans,Latn"
      : "Latn";
    lines.push(
      [
        font.family,
        "Regular",
        `fonts/user/${font.fileName}`,
        scripts,
        "User-supplied",
        "",
        "",
        "local",
      ].join(" | "),
    );
  }
  return `${lines.join("\n")}\n`;
}
