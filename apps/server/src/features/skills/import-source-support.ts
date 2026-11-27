import { join } from "node:path";

/** 来源准备失败的可读原因；`statusCode` 是路由回给客户端的状态码。 */
export class SkillImportSourceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillImportSourceError";
    this.statusCode = statusCode;
  }
}

/** 单个来源在拉取与解压阶段共用的三项预算。 */
export interface SkillImportSourceLimits {
  timeoutMs: number;
  maxBytes: number;
  maxEntries: number;
}

/**
 * 给一次来源准备加上总时限。到点后 `signal` 的中止原因是一条可读错误，
 * 正在进行的步骤读到它以后收尾，并把同一个错误抛出去。
 */
export async function withSourceDeadline<T>(
  timeoutMs: number,
  timeoutMessage: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new SkillImportSourceError(timeoutMessage, 504)),
    timeoutMs,
  );
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** 来源在拉取过程中流出的字节与条目计数；超过预算时抛可读原因。 */
export class SourceBudget {
  private readonly limits: SkillImportSourceLimits;
  private bytes = 0;
  private entries = 0;

  constructor(limits: SkillImportSourceLimits) {
    this.limits = limits;
  }

  addBytes(count: number): void {
    this.bytes += count;
    if (this.bytes > this.limits.maxBytes) {
      throw new SkillImportSourceError(
        `来源解压后超过 ${Math.round(this.limits.maxBytes / 1_048_576)} MB 上限。`,
        413,
      );
    }
  }

  addEntry(): void {
    this.entries += 1;
    if (this.entries > this.limits.maxEntries) {
      throw new SkillImportSourceError(
        `来源里的文件数超过 ${this.limits.maxEntries} 个上限。`,
        413,
      );
    }
  }
}

export type ArchiveEntryPath =
  | { kind: "file" | "directory"; path: string }
  | { kind: "skipped" };

/** Windows 保留的设备名：写成文件名会被系统改写到别处。 */
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);
const WINDOWS_DRIVE_PREFIX = /^[a-z]:/iu;
// 控制字符是 Windows 文件名的非法字符之一，必须显式匹配
// biome-ignore lint/suspicious/noControlCharactersInRegex: 识别压缩包条目里的 Windows 非法字符
const WINDOWS_INVALID_CHARACTERS = /[\u0000-\u001f<>:"|?*]/u;
/** Windows 单个文件名的长度上限（按 UTF-16 单元计），也是常见文件系统按字节计的上限。 */
const MAX_SEGMENT_LENGTH = 255;
/**
 * Windows 未开启长路径时的全路径上限。这是系统常量而不是产品可调数值，
 * 所以不进治理表；各平台按同一条规则取舍，保证同一个来源在各平台解出同一批文件。
 */
const MAX_FULL_PATH_LENGTH = 260;

function isPortableSegment(
  segment: string,
  backslashIsSeparator: boolean,
): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  if (WINDOWS_INVALID_CHARACTERS.test(segment)) return false;
  // 结尾的点或空格在写入时会被系统去掉，读回来就对不上原名。
  if (/[. ]$/u.test(segment)) return false;
  if (!backslashIsSeparator && segment.includes("\\")) return false;
  if (
    segment.length > MAX_SEGMENT_LENGTH ||
    Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_LENGTH
  ) {
    return false;
  }
  return !WINDOWS_RESERVED_NAMES.has(
    segment.split(".")[0]?.toLowerCase() ?? "",
  );
}

/**
 * 判断压缩包或仓库快照里的一个条目能否写进暂存目录。
 *
 * 写到暂存目录之外的路径（绝对路径、盘符、`..`）说明来源有问题，整个来源拒绝；
 * 各平台都无法稳定写入的文件名只跳过该条目，其余文件照常解出。
 * zip 包里反斜杠在部分压缩工具写来就是分隔符，按分隔符处理；仓库快照里不这样认。
 */
export function classifyArchiveEntryPath(
  rawName: string,
  options: { backslashIsSeparator: boolean; destination: string },
): ArchiveEntryPath {
  const name = options.backslashIsSeparator
    ? rawName.replaceAll("\\", "/")
    : rawName;
  const directory = name.endsWith("/");
  const segments = (directory ? name.slice(0, -1) : name).split("/");
  if (
    name.startsWith("/") ||
    segments.includes("..") ||
    WINDOWS_DRIVE_PREFIX.test(segments[0] ?? "")
  ) {
    throw new SkillImportSourceError(
      "来源里有写到暂存目录之外的文件路径，已拒绝导入。",
    );
  }
  if (
    segments.some(
      (segment) => !isPortableSegment(segment, options.backslashIsSeparator),
    )
  ) {
    return { kind: "skipped" };
  }
  const path = segments.join("/");
  if (join(options.destination, ...segments).length >= MAX_FULL_PATH_LENGTH) {
    return { kind: "skipped" };
  }
  return { kind: directory ? "directory" : "file", path };
}
