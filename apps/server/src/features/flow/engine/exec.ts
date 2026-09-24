import { execFile } from "node:child_process";

/**
 * 引擎探测用的命令执行（可注入，便于单测喂假输出）。
 *
 * 与 `code-git/git-exec.ts` 同一条纪律：`execFile` 直接传参数数组，不经 shell 二次解释；
 * 超时即失败（探测不该把请求挂死）。返回**原始字节**：Windows 的若干系统工具
 * （`wsl.exe` 等）按 UTF-16LE 输出，先按字符串解码会把内容读成乱码 + 空字符。
 */
export interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type RunCommand = (
  file: string,
  args: readonly string[],
) => Promise<CommandResult>;

export function createProcessRunCommand(options?: {
  timeoutMs?: number;
}): RunCommand {
  const timeout = options?.timeoutMs ?? 5_000;
  return (file, args) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? 127
                : 0;
          resolve({
            code,
            // 未捕获到输出时用 error.message 兜底，保证 reason 里总有可读线索
            stdout: Buffer.from(String(stdout ?? "")),
            stderr: Buffer.from(
              String(stderr ?? "") || (error ? error.message : ""),
            ),
          });
        },
      );
    });
}

/**
 * 命令输出 → 文本。
 *
 * Windows 工具（`wsl.exe --status` 等）可能输出 UTF-16LE：按 UTF-8 读会得到
 * 大量 `\u0000`。检测到就按 UTF-16LE 重解码——不做这一步，关键词匹配全落空，
 * 探测会把「其实可用」报成不可用。
 */
export function decodeCommandText(buffer: Buffer): string {
  const asUtf8 = buffer.toString("utf8");
  const nulRatio =
    asUtf8.length === 0
      ? 0
      : [...asUtf8].filter((char) => char === "\u0000").length / asUtf8.length;
  const text = nulRatio > 0.2 ? buffer.toString("utf16le") : asUtf8;
  // 顺带清掉 BOM 与残留 NUL（后续按行解析才干净）
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .trim();
}
