// Adapted from OpenAI Codex apply-patch at e53e932; see LICENSE, NOTICE and 来源清单.json.
// Only parsing and text transformation live here. The host owns authorization and publication.
export interface PatchChunk {
  context?: string;
  entries: Array<{ kind: " " | "+" | "-"; text: string }>;
  eof: boolean;
}
export type PatchHunk =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: PatchChunk[] };

export function parsePatch(text: string): PatchHunk[] {
  const lines = text.trim().split(/\r?\n/);
  if (
    lines[0]?.trim() !== "*** Begin Patch" ||
    lines.at(-1)?.trim() !== "*** End Patch"
  )
    throw new Error("补丁必须以 *** Begin Patch 开始，以 *** End Patch 结束");
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  let chunk: PatchChunk | undefined;
  const finish = () => {
    if (
      current?.type === "update" &&
      (!current.chunks.length ||
        current.chunks.some((entry) => !entry.entries.length))
    )
      throw new Error(`更新补丁为空：${current.path}`);
  };
  for (const line of lines.slice(1, -1)) {
    const marker = line.trim();
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(marker);
    if (header) {
      finish();
      const path = header[2]?.trim();
      if (!path) throw new Error("补丁路径不能为空");
      current =
        header[1] === "Add"
          ? { type: "add", path, content: "" }
          : header[1] === "Delete"
            ? { type: "delete", path }
            : { type: "update", path, chunks: [] };
      hunks.push(current);
      chunk = undefined;
      continue;
    }
    if (!current) throw new Error(`无效补丁头：${line}`);
    if (current.type === "add") {
      if (!line.startsWith("+"))
        throw new Error(`新建文件行必须以 + 开始：${line}`);
      current.content += `${line.slice(1)}\n`;
      continue;
    }
    if (current.type === "delete")
      throw new Error(`删除补丁中出现额外内容：${line}`);
    if (marker.startsWith("*** Move to: ")) {
      if (current.movePath || current.chunks.length)
        throw new Error("Move to 必须紧跟 Update File 且只能出现一次");
      current.movePath = marker.slice("*** Move to: ".length);
      continue;
    }
    if (marker === "@@" || marker.startsWith("@@ ")) {
      if (chunk && !chunk.entries.length) throw new Error("补丁块为空");
      chunk = {
        ...(marker !== "@@" ? { context: marker.slice(3) } : {}),
        entries: [],
        eof: false,
      };
      current.chunks.push(chunk);
      continue;
    }
    if (marker === "*** End of File") {
      if (!chunk) throw new Error("End of File 需要更新内容");
      chunk.eof = true;
      continue;
    }
    if (line === "" && chunk?.eof) continue;
    const kind = line[0];
    if (kind !== " " && kind !== "+" && kind !== "-")
      throw new Error(`无效补丁行：${line}`);
    if (chunk?.eof) throw new Error("End of File 后不能继续更新内容");
    if (!chunk) {
      chunk = { entries: [], eof: false };
      current.chunks.push(chunk);
    }
    chunk.entries.push({ kind, text: line.slice(1) });
  }
  finish();
  if (!hunks.length) throw new Error("补丁为空");
  return hunks;
}

function normalize(text: string): string {
  return text
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return -1;
  const from = eof ? Math.max(start, lines.length - pattern.length) : start;
  const transforms = [
    (value: string) => value,
    (value: string) => value.trimEnd(),
    (value: string) => value.trim(),
    normalize,
  ];
  for (const transform of transforms) {
    for (let index = from; index <= lines.length - pattern.length; index += 1) {
      if (
        pattern.every(
          (value, offset) =>
            transform(lines[index + offset] ?? "") === transform(value),
        )
      )
        return index;
    }
  }
  return -1;
}

interface SourceLine {
  text: string;
  ending: string;
  start: number;
  end: number;
}
export interface AppliedChunks {
  content: string;
  observedRanges: Array<{ start: number; end: number }>;
}

/** Preserve unchanged source line endings; newly inserted lines use the first source ending. */
export function applyChunks(
  content: string,
  chunks: PatchChunk[],
): AppliedChunks {
  const source: SourceLine[] = [];
  let offset = 0;
  for (const match of content.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!match[0]) continue;
    const ending = /(?:\r\n|\r|\n)$/.exec(match[0])?.[0] ?? "";
    source.push({
      text: ending ? match[0].slice(0, -ending.length) : match[0],
      ending,
      start: offset,
      end: offset + match[0].length,
    });
    offset += match[0].length;
  }
  const preferred = source.find((line) => line.ending)?.ending ?? "\n";
  const replacements: Array<{
    start: number;
    count: number;
    lines: SourceLine[];
  }> = [];
  const observedRanges: AppliedChunks["observedRanges"] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const sourceText = source.map((line) => line.text);
    if (chunk.context !== undefined) {
      const index = seekSequence(sourceText, [chunk.context], cursor, false);
      if (index < 0) throw new Error(`找不到补丁上下文：${chunk.context}`);
      cursor = index + 1;
    }
    const old = chunk.entries
      .filter((entry) => entry.kind !== "+")
      .map((entry) => entry.text);
    let index = old.length
      ? seekSequence(sourceText, old, cursor, chunk.eof)
      : source.length;
    if (index < 0) throw new Error(`找不到补丁原文：${old.join("\n")}`);
    observedRanges.push({
      start: source[index]?.start ?? content.length,
      end: source[index + old.length - 1]?.end ?? content.length,
    });
    let groupStart = index;
    let removed = 0;
    let added: SourceLine[] = [];
    const flush = () => {
      if (removed || added.length)
        replacements.push({ start: groupStart, count: removed, lines: added });
      removed = 0;
      added = [];
    };
    for (const entry of chunk.entries) {
      if (entry.kind === " ") {
        flush();
        index += 1;
        groupStart = index;
      } else if (entry.kind === "-") {
        removed += 1;
        index += 1;
      } else
        added.push({ text: entry.text, ending: preferred, start: 0, end: 0 });
    }
    flush();
    cursor = index;
  }
  replacements.sort((a, b) => b.start - a.start);
  const result = [...source];
  for (const replacement of replacements)
    result.splice(replacement.start, replacement.count, ...replacement.lines);
  return {
    content: result
      .map((line) => `${line.text}${line.ending || preferred}`)
      .join(""),
    observedRanges,
  };
}
