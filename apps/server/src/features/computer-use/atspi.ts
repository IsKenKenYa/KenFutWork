import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import type { AxNode } from "./ax-tree.js";
import { CU_AX_DEFAULT_LIMITS, type CuOperationContext } from "./executor.js";

export async function atspi(
  input: {
    operation: "observe" | "click" | "type";
    pid: number;
    title: string | null;
    bounds: [number, number, number, number];
    index?: number;
    text?: string;
  },
  context?: CuOperationContext,
): Promise<{
  available: boolean;
  reason?: string;
  root?: AxNode;
  actionSent?: boolean;
}> {
  return await new Promise((resolve, reject) => {
    const child = execFile(
      "python3",
      [fileURLToPath(new URL("./atspi.py", import.meta.url))],
      {
        timeout:
          context?.timeoutMs ??
          AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
        maxBuffer:
          context?.maxOutputBytes ??
          AGENT_GOVERNANCE_DEFAULTS.processMaxOutputBytes,
        ...(context ? { signal: context.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            Object.assign(
              new Error(`AT-SPI失败：${stderr.trim() || error.code}`),
              {
                code: context?.signal.aborted
                  ? "cancelled"
                  : "accessibility_unavailable",
              },
            ),
          );
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("AT-SPI未返回有效JSON"));
          }
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      JSON.stringify({
        ...input,
        limits: context?.treeLimits ?? CU_AX_DEFAULT_LIMITS,
      }),
    );
  });
}
