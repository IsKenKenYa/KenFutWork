import { execFile } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { rgPath } from "@vscode/ripgrep";
import type { ScopedFilesystemScope } from "../execution/scoped-filesystem.js";
import type { FileLimits, GrepPageInput } from "./file-types.js";

export interface RipgrepRow {
  type: string;
  data?: {
    line_number?: number;
    lines?: { text?: string };
    submatches?: Array<{ match?: { text?: string } }>;
  };
}
export interface RipgrepOutput {
  rows: RipgrepRow[];
  truncated: boolean;
  count?: number;
  hasMatch?: boolean;
}
class BinarySkipped extends Error {}
let fileTypes: Promise<Map<string, string[]>> | undefined;

export async function matchesFileType(
  name: string,
  type: string,
  limits: FileLimits,
): Promise<boolean> {
  if (!fileTypes)
    fileTypes = new Promise((resolve, reject) => {
      execFile(
        rgPath,
        ["--type-list"],
        {
          maxBuffer: limits.codeReadMaxBytes,
          env: { LANG: "C.UTF-8", NODE_ENV: "production" },
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            fileTypes = undefined;
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(
            new Map(
              stdout
                .trim()
                .split("\n")
                .map((line) => {
                  const index = line.indexOf(":");
                  return [
                    line.slice(0, index),
                    line
                      .slice(index + 1)
                      .trim()
                      .split(", "),
                  ];
                }),
            ),
          );
        },
      );
    });
  const patterns = (await fileTypes).get(type);
  if (!patterns) throw new Error(`未知 ripgrep 文件类型：${type}`);
  const { matchesGlob } = await import("node:path");
  return patterns.some((pattern) => matchesGlob(name, pattern));
}

async function feedFile(
  scope: ScopedFilesystemScope,
  path: string,
  fromLine: number,
  target: NodeJS.WritableStream,
  signal: AbortSignal,
): Promise<void> {
  const canonical = await scope.resolvePath(path, "read");
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("搜索输入不是常规文件");
    if ((await scope.resolvePath(path, "read")) !== canonical)
      throw new Error("搜索路径已变化");
    let decoder: TextDecoder | undefined;
    let line = 1;
    const send = async (text: string) => {
      if (text.includes("\0")) throw new BinarySkipped();
      let start = 0;
      while (line < fromLine) {
        const end = text.indexOf("\n", start);
        if (end < 0) return;
        line += 1;
        start = end + 1;
      }
      const body = text.slice(start);
      if (body && !target.write(body)) await once(target, "drain", { signal });
    };
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      signal,
    })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!decoder) {
        if (bytes.subarray(0, 5).toString("ascii") === "%PDF-")
          throw new BinarySkipped();
        const encoding =
          bytes[0] === 0xff && bytes[1] === 0xfe
            ? "utf-16le"
            : bytes[0] === 0xfe && bytes[1] === 0xff
              ? "utf-16be"
              : "utf-8";
        decoder = new TextDecoder(encoding, { fatal: true });
      }
      await send(decoder.decode(bytes, { stream: true }));
    }
    if (decoder) await send(decoder.decode());
    const after = await handle.stat();
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("文件在搜索期间变化，请重新搜索");
    target.end();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
    )
      throw new BinarySkipped();
    throw error;
  } finally {
    await handle.close();
  }
}

function parseOutput(
  stdout: string,
  truncated: boolean,
  mode: GrepPageInput["mode"],
  fromLine: number,
): RipgrepOutput {
  if (mode === "count")
    return { rows: [], truncated, count: Number(stdout.trim() || 0) };
  if (mode === "files_with_matches")
    return { rows: [], truncated, hasMatch: stdout.trim() !== "" };
  const complete = truncated
    ? stdout.slice(0, stdout.lastIndexOf("\n") + 1)
    : stdout;
  const rows = complete
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RipgrepRow);
  for (const row of rows)
    if (row.data?.line_number !== undefined)
      row.data.line_number += fromLine - 1;
  if (truncated && !rows.some((row) => row.type === "match"))
    throw new Error(
      "单个匹配行超过搜索字节预算，请提高预算或使用 Read 分页读取该文件",
    );
  return { rows, truncated };
}

/** Native rg receives guarded stdin, never model-provided filesystem arguments or server secrets. */
export async function runRipgrep(
  scope: ScopedFilesystemScope,
  path: string | undefined,
  input: GrepPageInput,
  maxBytes: number,
  fromLine = 1,
): Promise<RipgrepOutput> {
  input.signal?.throwIfAborted();
  const args = [
    input.mode === "count"
      ? "--count"
      : input.mode === "files_with_matches"
        ? "--files-with-matches"
        : "--json",
    `--regexp=${input.pattern}`,
  ];
  if (input.caseInsensitive) args.push("--ignore-case");
  if (input.multiline) args.push("--multiline", "--multiline-dotall");
  if (
    input.contextBefore &&
    input.mode !== "count" &&
    input.mode !== "files_with_matches"
  )
    args.push("--before-context", String(input.contextBefore));
  if (
    input.contextAfter &&
    input.mode !== "count" &&
    input.mode !== "files_with_matches"
  )
    args.push("--after-context", String(input.contextAfter));
  args.push("--", "-");
  const pumping = new AbortController();
  let feeding: Promise<void> = Promise.resolve();
  let feedError: unknown;
  let exited: Promise<void> = Promise.resolve();
  const result = new Promise<RipgrepOutput>((resolve, reject) => {
    const child = execFile(
      rgPath,
      args,
      {
        maxBuffer: maxBytes,
        encoding: "utf8",
        env: { LANG: "C.UTF-8", NODE_ENV: "production" },
        ...(input.signal ? { signal: input.signal } : {}),
      },
      (error, stdout, stderr) => {
        pumping.abort();
        if (input.signal?.aborted) {
          reject(input.signal.reason);
          return;
        }
        if (feedError instanceof BinarySkipped) {
          resolve({ rows: [], truncated: false });
          return;
        }
        if (
          feedError &&
          !(
            typeof feedError === "object" &&
            "code" in feedError &&
            (feedError.code === "ABORT_ERR" || feedError.code === "EPIPE")
          )
        ) {
          reject(feedError);
          return;
        }
        const truncated = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        if (error && error.code !== 1 && !truncated) {
          reject(new Error(stderr || `搜索失败：${error.message}`));
          return;
        }
        try {
          resolve(parseOutput(stdout, truncated, input.mode, fromLine));
        } catch (error) {
          reject(error);
        }
      },
    );
    exited = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    child.stdin?.on("error", (error) => {
      feedError ??= error;
      pumping.abort();
      child.kill();
    });
    const feedSignal = input.signal
      ? AbortSignal.any([input.signal, pumping.signal])
      : pumping.signal;
    if (path && child.stdin)
      feeding = feedFile(scope, path, fromLine, child.stdin, feedSignal).catch(
        (error) => {
          feedError = error;
          child.kill();
        },
      );
    else child.stdin?.end();
  });
  try {
    return await result;
  } finally {
    pumping.abort();
    await Promise.allSettled([feeding, exited]);
  }
}
