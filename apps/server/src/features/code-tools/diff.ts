import { diffArrays } from "diff";

export interface DiffLine {
  type: "context" | "added" | "removed";
  text: string;
}

/** Myers diff preserves the existing line-array contract without an O(n*m) LCS matrix. */
export function diffLines(before: string, after: string): DiffLine[] {
  return diffArrays(before.split("\n"), after.split("\n")).flatMap((part) =>
    part.value.map((text) => ({
      type: part.added
        ? ("added" as const)
        : part.removed
          ? ("removed" as const)
          : ("context" as const),
      text,
    })),
  );
}

export function summarizeDiff(lines: DiffLine[]): string {
  return `+${lines.filter((line) => line.type === "added").length} -${lines.filter((line) => line.type === "removed").length}`;
}
