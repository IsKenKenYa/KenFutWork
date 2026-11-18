import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import { executionEnvironment } from "../process-sandbox/environment.js";
import {
  type CadGuiApplication,
  cadGuiApplicationSchema,
} from "./gui-document-contracts.js";
import type { CadGuiProbeContext } from "./gui-probe.js";
import { CAD_GUI_PROCESS_IDENTITY_QUERY_SOURCE } from "./gui-process-identity-source.js";

export interface CadGuiNativeCommand {
  executable: string;
  args: readonly string[];
  stdin?: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}

/** 取消后等待自己的 helper close；不结束被查询的应用或按数值 PID 发信号。 */
export type CadGuiNativeRunner = (
  command: CadGuiNativeCommand,
) => Promise<string>;

export type CadGuiProcessIdentity = Pick<
  CadGuiApplication,
  "birth" | "executablePath"
>;

function inside(bundle: string, executable: string): boolean {
  const relative = posix.relative(bundle, executable);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith("../") &&
    !posix.isAbsolute(relative)
  );
}

export async function resolveCadGuiPython(bundlePath: string): Promise<string> {
  try {
    const bundle = await realpath(bundlePath);
    if (bundle !== bundlePath) throw new Error("changed bundle");
    const python = await realpath(
      posix.join(bundle, "Contents", "Resources", "bin", "python"),
    );
    if (!inside(bundle, python)) throw new Error("interpreter escaped bundle");
    const information = await stat(python);
    if (!information.isFile() || (information.mode & 0o111) === 0)
      throw new Error("invalid interpreter");
    await access(python, constants.X_OK);
    return python;
  } catch {
    throw new Error("FreeCAD Python 不可用。");
  }
}

const HELPER_KILL_GRACE_MS = 250;

/** 固定宿主命令。stderr 不进入回执，取消只结束当前 ChildProcess 并 join close。 */
export const runCadGuiNativeCommand: CadGuiNativeRunner = (command) =>
  new Promise((resolve, reject) => {
    if (command.signal.aborted) {
      reject(new Error("helper cancelled"));
      return;
    }
    const child = spawn(command.executable, [...command.args], {
      shell: false,
      env: executionEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let length = 0;
    let failure: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill("SIGTERM");
      } catch {
        /* close/error 仍是收束边界。 */
      }
      forceKill ??= setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 不改为按数值 PID 发送信号。 */
        }
      }, HELPER_KILL_GRACE_MS);
    };
    const abort = () => {
      failure ??= new Error("helper cancelled");
      terminate();
    };
    child.stdout.on("data", (data: Buffer) => {
      length += data.length;
      if (length > command.maxOutputBytes) {
        failure ??= new Error("helper output limit");
        terminate();
        return;
      }
      if (!failure) chunks.push(data);
    });
    child.stderr.resume();
    child.on("error", () => {
      failure ??= new Error("helper process failed");
    });
    child.stdin.on("error", () => {
      failure ??= new Error("helper input failed");
      terminate();
    });
    child.once("close", (code) => {
      command.signal.removeEventListener("abort", abort);
      if (forceKill) clearTimeout(forceKill);
      if (failure || code !== 0) {
        reject(failure ?? new Error("helper process failed"));
        return;
      }
      try {
        resolve(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        reject(new Error("helper output invalid"));
      }
    });
    command.signal.addEventListener("abort", abort, { once: true });
    if (command.signal.aborted) abort();
    child.stdin.end(command.stdin);
  });

const identityReplySchema = cadGuiApplicationSchema
  .pick({ pid: true, birth: true, executablePath: true })
  .extend({ ok: z.literal(true) })
  .strict();

/** 本机只读进程元数据；不归属 Task，不获得 GUI 或文档控制能力。 */
export async function readCadGuiProcessIdentity(
  application: { pid: number; bundlePath: string },
  context: CadGuiProbeContext,
): Promise<CadGuiProcessIdentity> {
  if (
    process.platform !== "darwin" ||
    !Number.isSafeInteger(application.pid) ||
    application.pid < 2 ||
    application.pid > 0x7fff_ffff ||
    !Number.isSafeInteger(context.timeoutMs) ||
    context.timeoutMs <= 0 ||
    context.timeoutMs > 2_147_483_647
  )
    throw new Error("FreeCAD 进程身份查询不可用。");
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal?.addEventListener("abort", abort, { once: true });
  if (context.signal?.aborted) abort();
  const deadline = Date.now() + context.timeoutMs;
  const timer = setTimeout(abort, context.timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const python = await resolveCadGuiPython(application.bundlePath);
    controller.signal.throwIfAborted();
    const output = await runCadGuiNativeCommand({
      executable: python,
      args: ["-I", "-S", "-B", "-c", CAD_GUI_PROCESS_IDENTITY_QUERY_SOURCE],
      stdin: JSON.stringify({ pid: application.pid }),
      signal: controller.signal,
      timeoutMs: Math.max(1, deadline - Date.now()),
      maxOutputBytes: 16_384,
    });
    controller.signal.throwIfAborted();
    const identity = identityReplySchema.parse(JSON.parse(output));
    if (identity.pid !== application.pid) throw new Error("identity mismatch");
    return { birth: identity.birth, executablePath: identity.executablePath };
  } catch {
    if (context.signal?.aborted) context.signal.throwIfAborted();
    throw new Error("无法确认 FreeCAD 进程出生身份。");
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", abort);
  }
}
