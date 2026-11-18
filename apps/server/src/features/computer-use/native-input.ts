import { fork } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { resolveEntryRoot } from "../../desktop/entry-root.js";
import type { CuOperationContext } from "./executor.js";

/** 单次输入进程：SIGTERM触发worker清理；join exit后才返回，避免迟到输入污染下一会话。 */
export async function nativeInput(
  input: Record<string, unknown>,
  context: CuOperationContext,
): Promise<{ x: number; y: number }> {
  context.signal.throwIfAborted();
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const worker = import.meta.url.startsWith("file:")
    ? fileURLToPath(new URL(`./input-worker${extension}`, import.meta.url))
    : join(
        resolveEntryRoot({
          entryFileUrl: import.meta.url,
          execPath: process.execPath,
        }),
        "computer-use",
        "input-worker.cjs",
      );
  const child = fork(worker, [], {
    execArgv: extension === ".ts" ? ["--import", "tsx"] : [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let result:
    | { ok: boolean; error?: string; position?: { x: number; y: number } }
    | undefined;
  let failure: Error | undefined;
  let heldKeys: number[] = [];
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    child.kill("SIGTERM");
    forceKill ??= setTimeout(
      () => child.kill("SIGKILL"),
      context.timeoutMs ?? AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
    );
  };
  child.stderr?.resume();
  context.signal.addEventListener("abort", cancel, { once: true });
  if (context.signal.aborted) cancel();
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("message", (message) => {
        if (message && typeof message === "object" && "heldKeys" in message) {
          const keys = message.heldKeys;
          if (
            Array.isArray(keys) &&
            keys.every((key) => Number.isSafeInteger(key))
          )
            heldKeys = keys;
        } else result = message as typeof result;
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (context.signal.aborted)
          reject(
            Object.assign(new Error("原生输入已取消"), {
              code: "cancelled",
              actionSent: true,
            }),
          );
        else if (failure) reject(failure);
        else if (!result?.ok)
          reject(
            new Error(result?.error ?? `原生输入进程退出：${code ?? signal}`),
          );
        else resolve();
      });
      child.send(
        {
          ...input,
          timeoutMs: context.timeoutMs,
          inputDelayMs:
            context.inputDelayMs ??
            AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs,
        },
        (error) => {
          if (error) {
            failure = error;
            child.kill();
          }
        },
      );
    });
    if (!result?.position) throw new Error("原生输入没有返回指针位置");
    return result.position;
  } catch (error) {
    if (heldKeys.length && input.kind !== "releaseKeys") {
      try {
        await nativeInput(
          { kind: "releaseKeys", keys: heldKeys },
          {
            ...context,
            signal: AbortSignal.timeout(
              context.timeoutMs ??
                AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
            ),
            inputDelayMs: 0,
          },
        );
      } catch {
        throw Object.assign(
          new Error(
            "原生输入已退出，但持有按键未能确认释放；请先释放按键再继续",
          ),
          { code: "input_cleanup_failed", actionSent: true },
        );
      }
    }
    throw error;
  } finally {
    context.signal.removeEventListener("abort", cancel);
    if (forceKill) clearTimeout(forceKill);
  }
}
