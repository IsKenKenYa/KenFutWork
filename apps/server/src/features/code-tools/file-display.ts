import type { DiffHunk, FileCommit, PatchFileChange } from "./file-types.js";

type FileDiffInput = Pick<FileCommit, "filePath" | "structuredPatch">;
type FileDiffDisplay = {
  kind: "file_diff";
  filePath: string;
  additions: number;
  deletions: number;
  structuredPatch: DiffHunk[];
  truncated?: boolean;
};

function countLines(hunks: DiffHunk[]) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  return { additions, deletions };
}

/** 只截展示补丁，保留完整hunk；字节预算来自Task文件域，canonical写入事实不受影响。 */
export function fileDiffDisplay(
  input: FileDiffInput,
  maxPatchBytes: number,
): FileDiffDisplay {
  if (!Number.isFinite(maxPatchBytes) || maxPatchBytes < 0)
    throw new Error("文件展示的补丁字节预算无效，请检查工作区设置。");
  const patch: DiffHunk[] = [];
  const encoder = new TextEncoder();
  // JSON []与项间逗号是编码开销，非运行时可调限额。
  let bytes = encoder.encode("[]").byteLength;
  for (const hunk of input.structuredPatch) {
    const cost =
      encoder.encode(JSON.stringify(hunk)).byteLength + (patch.length ? 1 : 0);
    if (bytes + cost > maxPatchBytes) break;
    patch.push(structuredClone(hunk));
    bytes += cost;
  }
  return {
    kind: "file_diff",
    filePath: input.filePath,
    ...countLines(input.structuredPatch),
    structuredPatch: patch,
    ...(patch.length < input.structuredPatch.length ? { truncated: true } : {}),
  };
}

/** 多文件提交逐项真实投影；失败项不伪造diff，预算在所有文件补丁间共享。 */
export function fileDiffsDisplay(
  files: PatchFileChange[],
  maxPatchBytes: number,
) {
  if (!Number.isFinite(maxPatchBytes) || maxPatchBytes < 0)
    throw new Error("文件展示的补丁字节预算无效，请检查工作区设置。");
  const encoder = new TextEncoder();
  const emptyPatchBytes = encoder.encode("[]").byteLength;
  let remaining = maxPatchBytes - files.length * emptyPatchBytes;
  if (remaining < 0)
    throw new Error("多文件展示的补丁字节预算不足，请检查工作区设置。");
  const displayFiles = files.map((file) => {
    const display = fileDiffDisplay(file, remaining + emptyPatchBytes);
    remaining -=
      encoder.encode(JSON.stringify(display.structuredPatch)).byteLength -
      emptyPatchBytes;
    return display;
  });
  return {
    kind: "file_diffs" as const,
    files: displayFiles,
    ...(displayFiles.some((file) => file.truncated) ? { truncated: true } : {}),
  };
}
