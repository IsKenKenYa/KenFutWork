import type { ReactNode } from "react";

interface TextMatchRange {
  start: number;
  end: number;
}

function getQueryParts(query: string): string[] {
  const seen = new Set<string>();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .filter((part) => {
      if (seen.has(part)) {
        return false;
      }
      seen.add(part);
      return true;
    });
}

function mergeRanges(ranges: TextMatchRange[]): TextMatchRange[] {
  const sortedRanges = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const mergedRanges: TextMatchRange[] = [];

  for (const range of sortedRanges) {
    const lastRange = mergedRanges.at(-1);
    if (!lastRange || range.start > lastRange.end) {
      mergedRanges.push({ ...range });
      continue;
    }

    lastRange.end = Math.max(lastRange.end, range.end);
  }

  return mergedRanges;
}

function toSourceRanges(
  text: string,
  normalizedLength: number,
  matches: TextMatchRange[],
): TextMatchRange[] {
  const characters = new Intl.Segmenter().segment(text);
  if (normalizedLength === text.length) {
    // 匹配只有半个组合字符时，仍给整个字符加高亮。
    return matches.map(({ start, end }) => {
      const first = characters.containing(start)!;
      const last = characters.containing(end - 1)!;
      return { start: first.index, end: last.index + last.segment.length };
    });
  }

  const positions: TextMatchRange[] = [];
  // 例如 İ 在部分语言环境中会变成 i 和一个组合点。
  for (const { segment, index } of characters) {
    const source = { start: index, end: index + segment.length };
    const length = segment.toLocaleLowerCase().length;
    for (let offset = 0; offset < length; offset++) {
      positions.push(source);
    }
  }
  return matches.map(({ start, end }) => ({
    start: positions[start]!.start,
    end: positions[end - 1]!.end,
  }));
}

function findTextMatchRanges(text: string, query: string): TextMatchRange[] {
  const parts = getQueryParts(query);
  if (parts.length === 0 || text.length === 0) {
    return [];
  }

  const normalizedText = text.toLocaleLowerCase();
  const ranges: TextMatchRange[] = [];

  for (const part of parts) {
    let searchIndex = 0;
    while (searchIndex < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(part, searchIndex);
      if (matchIndex === -1) {
        break;
      }

      ranges.push({
        start: matchIndex,
        end: matchIndex + part.length,
      });
      searchIndex = matchIndex + part.length;
    }
  }

  if (ranges.length === 0) return ranges;
  return mergeRanges(
    /^[\x20-\x7e]*$/u.test(text)
      ? ranges
      : toSourceRanges(text, normalizedText.length, ranges),
  );
}

export function HighlightedMatchText({ text, query }: { text: string; query: string }) {
  const ranges = findTextMatchRanges(text, query);
  if (ranges.length === 0) {
    return <>{text}</>;
  }

  const parts: ReactNode[] = [];
  let cursor = 0;

  ranges.forEach((range, index) => {
    if (cursor < range.start) {
      parts.push(<span key={`plain-${index}`}>{text.slice(cursor, range.start)}</span>);
    }

    parts.push(
      <mark key={`match-${index}`} className="rounded-sm bg-accent font-semibold text-foreground">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });

  if (cursor < text.length) {
    parts.push(<span key="plain-end">{text.slice(cursor)}</span>);
  }

  return <>{parts}</>;
}
