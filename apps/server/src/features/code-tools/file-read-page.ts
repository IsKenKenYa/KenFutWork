import type { PageRead } from "./file-read.js";
import type { ReadPageInput, TextPage } from "./file-types.js";

export class TextPager {
  readonly startLine: number;
  readonly startColumn: number;
  private line = 1;
  private column = 0;
  private absolute = 0;
  private start = 0;
  private end = 0;
  private remaining: number;
  private content = "";
  text = "";
  private seen = false;
  private lastNewline = false;
  private reachedColumn: boolean;
  private next: { line: number; column: number } | undefined;
  private reason: "characters" | "lines" | undefined;
  constructor(
    private readonly path: string,
    private readonly input: ReadPageInput,
    maxCharacters: number,
    private readonly collectWhole: boolean,
  ) {
    this.startLine = input.continuation?.line ?? input.line ?? 1;
    this.startColumn = input.continuation?.column ?? input.column ?? 0;
    if (
      !Number.isSafeInteger(this.startLine) ||
      this.startLine < 1 ||
      !Number.isSafeInteger(this.startColumn) ||
      this.startColumn < 0
    )
      throw new Error("读取行列范围无效");
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1)
    )
      throw new Error("读取行数必须为正整数");
    this.remaining = maxCharacters;
    this.reachedColumn = this.startColumn === 0;
  }
  consume(chunk: string): void {
    if (this.collectWhole) this.text += chunk;
    for (const character of chunk) {
      if (character === "\0")
        throw new Error(`二进制文件不能作为文本读取：${this.path}`);
      this.seen = true;
      this.lastNewline = character === "\n";
      if (
        this.line === this.startLine &&
        this.column < this.startColumn &&
        this.column + character.length > this.startColumn
      )
        throw new Error("column_offset 分割 Unicode 字符");
      const eligible =
        this.line > this.startLine ||
        (this.line === this.startLine && this.column >= this.startColumn);
      if (this.line === this.startLine && this.column === this.startColumn)
        this.reachedColumn = true;
      if (eligible && !this.next) {
        if (
          this.remaining <= 0 ||
          (this.input.limit !== undefined &&
            this.line >= this.startLine + this.input.limit)
        ) {
          this.next = { line: this.line, column: this.column };
          this.reason = this.remaining <= 0 ? "characters" : "lines";
        } else {
          if (this.content === "") this.start = this.absolute;
          this.content += character;
          this.remaining -= 1;
          this.end = this.absolute + character.length;
        }
      }
      this.absolute += character.length;
      if (character === "\n") {
        this.line += 1;
        this.column = 0;
      } else this.column += character.length;
    }
  }
  finish(version: string, sizeBytes: number): PageRead {
    if (!this.reachedColumn && this.line >= this.startLine)
      throw new Error("column_offset 超过该行长度");
    const page: TextPage = {
      type: "text",
      filePath: this.path,
      content: this.content,
      numLines: this.content
        ? this.content.split("\n").length -
          (this.content.endsWith("\n") ? 1 : 0)
        : 0,
      startLine: this.startLine,
      startColumn: this.startColumn,
      endLine: this.next?.line ?? this.line,
      endColumn: this.next?.column ?? this.column,
      totalLines: this.seen ? this.line - (this.lastNewline ? 1 : 0) : 0,
      sizeBytes,
      bytesRead: sizeBytes,
      version,
      truncated: this.next !== undefined,
      ...(this.reason ? { truncationReason: this.reason } : {}),
      ...(this.next
        ? {
            continuation: { ...this.next, version },
            partialViewNotice: `继续读取：${JSON.stringify({ ...this.next, version })}`,
          }
        : {}),
    };
    return {
      page,
      range: { start: this.start, end: this.end },
      full:
        this.startLine === 1 &&
        this.startColumn === 0 &&
        this.next === undefined,
      totalCharacters: this.absolute,
    };
  }
}
