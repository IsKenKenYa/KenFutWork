import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ProcessSandboxError } from "./types.js";

interface ShellWord {
  value: string;
  start: number;
  end: number;
}

function unavailable(): never {
  throw new ProcessSandboxError(
    "enforcement_unavailable",
    "SRT Linux wrapper 结构改变，不能确认 PTY 的强 namespace 隔离。",
  );
}

/** 只接受 SRT shell-quote 生成的单条、无展开命令；保留原字节，不解释用户命令。 */
function shellWords(source: string): ShellWord[] {
  const words: ShellWord[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (/[\r\n]/.test(source[cursor] ?? "")) unavailable();
    if (/\s/.test(source[cursor] ?? "")) {
      cursor++;
      continue;
    }
    const start = cursor;
    let value = "";
    let quote = "";
    while (cursor < source.length) {
      const char = source[cursor++] ?? "";
      if (quote === "'") {
        if (char === "'") quote = "";
        else value += char;
        continue;
      }
      if (char === "\\") {
        const escaped = source[cursor++];
        if (escaped === undefined || escaped === "\n") unavailable();
        value += escaped;
        continue;
      }
      if (quote === '"') {
        if (char === '"') quote = "";
        else if (char === "$" || char === "`") unavailable();
        else value += char;
        continue;
      }
      if (/[\r\n]/.test(char)) unavailable();
      if (/\s/.test(char)) break;
      if (char === "'" || char === '"') quote = char;
      else if (/[#;&|<>()$`]/.test(char)) unavailable();
      else value += char;
    }
    if (quote) unavailable();
    words.push({ value, start, end: cursor });
  }
  return words;
}

/** node-pty 自有 session/TTY 替代 bwrap --new-session，其他隔离与命令完全保留。 */
export function prepareLinuxSandboxArgv(
  argv: string[],
  pty: boolean,
  privateDirectory?: string,
): string[] {
  if (argv.length !== 3 || argv[0] !== "/bin/sh" || argv[1] !== "-c")
    unavailable();
  const source = argv[2] ?? "";
  const words = shellWords(source);
  let launcher = 0;
  if (words[0]?.value === "/bin/sh") {
    const opener = /^exec ([0-9]+)<"\$1" && shift && exec "\$@"$/.exec(
      words[2]?.value ?? "",
    );
    if (
      words[1]?.value !== "-c" ||
      !opener ||
      words[3]?.value !== "srt-args" ||
      !/^\/proc\/[0-9]+\/fd\/[0-9]+$/.test(words[4]?.value ?? "")
    )
      unavailable();
    launcher = 5;
    const args = words.findIndex(
      (word, index) => index > launcher && word.value === "--args",
    );
    if (words[args + 1]?.value !== opener[1]) unavailable();
  }
  if (
    basename(words[launcher]?.value ?? "") !== "bwrap" ||
    words[launcher + 1]?.value !== "--new-session" ||
    words[launcher + 2]?.value !== "--die-with-parent"
  )
    unavailable();
  const boundary = words.findIndex(
    (word, index) => index > launcher && word.value === "--",
  );
  const flags = words.slice(launcher + 1, boundary).map((word) => word.value);
  const proc = flags.indexOf("--proc");
  if (
    boundary < 0 ||
    words.length !== boundary + 4 ||
    words[boundary + 1]?.value !== "/bin/sh" ||
    words[boundary + 2]?.value !== "-c" ||
    !flags.includes("--unshare-pid") ||
    !flags.includes("--unshare-user") ||
    proc < 0 ||
    flags[proc + 1] !== "/proc" ||
    flags.filter((word) => word === "--new-session").length !== 1
  )
    unavailable();
  const mountFlags =
    launcher === 5 && privateDirectory
      ? [
          ...flags,
          ...readFileSync(words[4]?.value ?? unavailable())
            .toString()
            .split("\0"),
        ]
      : flags;
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  if (pty) {
    const removed = words[launcher + 1];
    if (!removed) unavailable();
    edits.push({ start: removed.start, end: removed.end, replacement: "" });
  }
  // SRT 先 bind 内部 sockets，再 --tmpfs /tmp；强 denyRead('/') 会把 bind 遮蔽。
  // 只把 SRT 已授予的精确 socket inode 重放到 mounts 后，不暴露任何父目录内容。
  const device = words.findIndex(
    (word, index) => index > launcher && word.value === "--dev",
  );
  if (
    device < launcher ||
    device >= boundary ||
    words[device + 1]?.value !== "/dev"
  )
    unavailable();
  const socketBinds: string[] = [];
  for (let index = launcher + 3; index < device; index++) {
    if (words[index]?.value !== "--bind") continue;
    const path = words[index + 1]?.value ?? "";
    if (
      !/^\/tmp\/(?:srt-obs-[A-Za-z0-9]+\/[A-Za-z0-9]+\.sock|claude-(?:http|socks)-[a-f0-9]+\.sock)$/.test(
        path,
      )
    )
      continue;
    if (words[index + 2]?.value !== path) unavailable();
    const first = words[index];
    const last = words[index + 2];
    if (!first || !last) unavailable();
    socketBinds.push(source.slice(first.start, last.end).trimEnd());
  }
  const destination = words[device];
  if (!destination) unavailable();
  const privateMask =
    privateDirectory &&
    mountFlags.some(
      (word, index) =>
        word === "--tmpfs" && mountFlags[index + 1] === privateDirectory,
    );
  if (privateMask)
    socketBinds.push(
      `--remount-ro '${privateDirectory.replaceAll("'", "'\\''")}'`,
    );
  if (socketBinds.length)
    edits.push({
      start: destination.start,
      end: destination.start,
      replacement: `${socketBinds.join(" ")} `,
    });
  let adapted = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    adapted =
      adapted.slice(0, edit.start) + edit.replacement + adapted.slice(edit.end);
  return [argv[0], argv[1], adapted];
}
