import { posix } from "node:path";
import { cadGuiApplicationSchema } from "./gui-document-contracts.js";
import {
  type CadGuiNativeCommand,
  type CadGuiNativeRunner,
  resolveCadGuiPython,
  runCadGuiNativeCommand,
} from "./gui-native.js";
import type { CadGuiApplication, CadGuiProbeContext } from "./gui-probe.js";
import { FREECAD_GUI_TRANSPORT_SOURCE } from "./gui-transport-source.js";

export type CadGuiTransportCommand = CadGuiNativeCommand;

/** 取消后须等待自己的 helper close 再拒绝；不得结束目标 GUI。 */
export type CadGuiTransportRunner = CadGuiNativeRunner;

export interface CadGuiMacroTransport {
  send(
    application: CadGuiApplication,
    macroPath: string,
    context: CadGuiProbeContext,
  ): Promise<void>;
}

export class CadGuiTransportError extends Error {
  constructor(
    readonly code: "not_supported" | "application_changed" | "transport_failed",
    message: string,
    readonly actionSent: boolean | undefined,
  ) {
    super(message);
    this.name = "CadGuiTransportError";
  }
}

// 私有控制协议的上限独立于模型预览，避免预览截断被误认成未知送达。
const DISCOVERY_MAX_BYTES = 262_144;
const REQUEST_MAX_BYTES = 262_144;
const RECEIPT_MAX_BYTES = 16_384;
const applicationInputSchema = cadGuiApplicationSchema.strict();

function validPath(path: string): boolean {
  return posix.isAbsolute(path) && !/[\0\r\n]/u.test(path);
}

async function pythonExecutable(
  application: CadGuiApplication,
): Promise<string> {
  try {
    return await resolveCadGuiPython(application.bundlePath);
  } catch {
    throw new CadGuiTransportError(
      "application_changed",
      "FreeCAD 的 Python 程序不可用，请重新查询应用。",
      false,
    );
  }
}

function socketPaths(output: string, pid: number): string[] {
  if (Buffer.byteLength(output, "utf8") > DISCOVERY_MAX_BYTES)
    throw new CadGuiTransportError(
      "transport_failed",
      "FreeCAD 连接清单过大。",
      false,
    );
  let identified = false;
  const candidates = new Set<string>();
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      if (!/^p\d+$/u.test(line) || Number(line.slice(1)) !== pid)
        throw new CadGuiTransportError(
          "application_changed",
          "FreeCAD 连接所属进程已变化，请重新查询。",
          false,
        );
      identified = true;
    }
    if (!line.startsWith("n")) continue;
    const path = line.slice(1);
    if (validPath(path) && posix.basename(path) === "FreeCAD")
      candidates.add(path);
  }
  if (!identified || candidates.size === 0)
    throw new CadGuiTransportError(
      "transport_failed",
      "没有找到 FreeCAD 的本地连接。",
      false,
    );
  return [...candidates];
}

function acceptReceipt(output: string): void {
  if (Buffer.byteLength(output, "utf8") > RECEIPT_MAX_BYTES)
    throw new Error("invalid receipt");
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid receipt");
  const receipt = value as Record<string, unknown>;
  const fields = Object.keys(receipt).sort().join(",");
  if (
    fields === "actionSent,ok" &&
    receipt.ok === true &&
    receipt.actionSent === true
  )
    return;
  if (fields !== "actionSent,code,ok" || receipt.ok !== false)
    throw new Error("invalid receipt");
  const identityCodes = [
    "peer_mismatch",
    "identity_changed",
    "identity_unavailable",
  ];
  const preflightCodes = [
    "invalid_request",
    "socket_unavailable",
    "socket_invalid",
    "peer_unavailable",
    ...identityCodes,
    "internal",
  ];
  if (
    receipt.actionSent === false &&
    preflightCodes.includes(String(receipt.code))
  )
    throw new CadGuiTransportError(
      identityCodes.includes(String(receipt.code))
        ? "application_changed"
        : "transport_failed",
      identityCodes.includes(String(receipt.code))
        ? "FreeCAD 连接所属进程已变化，请重新查询。"
        : "FreeCAD 本地连接不可用，请重试。",
      false,
    );
  if (
    receipt.actionSent === null &&
    ["send_failed", "internal"].includes(String(receipt.code))
  )
    throw new CadGuiTransportError(
      "transport_failed",
      "无法确认 FreeCAD 是否已收到请求。",
      undefined,
    );
  throw new Error("invalid receipt");
}

function validateRequest(
  application: CadGuiApplication,
  macroPath: string,
  context: CadGuiProbeContext,
): CadGuiApplication {
  // Schema 解析持有完整原身份的独立副本，后续 await 不读调用方可变对象。
  const parsed = applicationInputSchema.safeParse(application);
  if (
    !parsed.success ||
    parsed.data.pid < 2 ||
    parsed.data.pid > 0x7fff_ffff ||
    !validPath(parsed.data.bundlePath) ||
    !validPath(parsed.data.executablePath)
  )
    throw new CadGuiTransportError(
      "application_changed",
      "FreeCAD 应用绑定无效，请重新查询。",
      false,
    );
  const binding = parsed.data;
  if (!validPath(macroPath))
    throw new CadGuiTransportError(
      "transport_failed",
      "FreeCAD 请求路径无效。",
      false,
    );
  if (
    !Number.isSafeInteger(context.timeoutMs) ||
    context.timeoutMs <= 0 ||
    context.timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(context.maxOutputBytes) ||
    context.maxOutputBytes <= 0
  )
    throw new CadGuiTransportError(
      "transport_failed",
      "FreeCAD 连接查询限制无效。",
      false,
    );
  return binding;
}

export function createMacosCadGuiTransport(
  options: { platform?: NodeJS.Platform; run?: CadGuiTransportRunner } = {},
): CadGuiMacroTransport {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCadGuiNativeCommand;
  return {
    async send(application, macroPath, context) {
      if (platform !== "darwin")
        throw new CadGuiTransportError(
          "not_supported",
          "当前系统不支持 FreeCAD 本地连接。",
          false,
        );
      const binding = validateRequest(application, macroPath, context);
      const controller = new AbortController();
      let timedOut = false;
      let pythonStarted = false;
      const abort = () => controller.abort();
      context.signal?.addEventListener("abort", abort, { once: true });
      if (context.signal?.aborted) abort();
      const deadline = Date.now() + context.timeoutMs;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, context.timeoutMs);
      const remaining = () => Math.max(1, deadline - Date.now());
      try {
        controller.signal.throwIfAborted();
        const python = await pythonExecutable(binding);
        controller.signal.throwIfAborted();
        const discovered = await run({
          executable: "/usr/sbin/lsof",
          args: ["-a", "-p", String(binding.pid), "-U", "-Fn"],
          signal: controller.signal,
          timeoutMs: remaining(),
          maxOutputBytes: DISCOVERY_MAX_BYTES,
        });
        controller.signal.throwIfAborted();
        const candidates = socketPaths(discovered, binding.pid);
        const input = JSON.stringify({
          application: binding,
          macroPath,
          socketPaths: candidates,
          timeoutMs: remaining(),
        });
        if (Buffer.byteLength(input, "utf8") > REQUEST_MAX_BYTES)
          throw new CadGuiTransportError(
            "transport_failed",
            "FreeCAD 连接请求过大。",
            false,
          );
        controller.signal.throwIfAborted();
        pythonStarted = true;
        const output = await run({
          executable: python,
          args: ["-I", "-S", "-B", "-c", FREECAD_GUI_TRANSPORT_SOURCE],
          stdin: input,
          signal: controller.signal,
          timeoutMs: remaining(),
          maxOutputBytes: RECEIPT_MAX_BYTES,
        });
        controller.signal.throwIfAborted();
        acceptReceipt(output);
      } catch (error) {
        if (error instanceof CadGuiTransportError) throw error;
        throw new CadGuiTransportError(
          "transport_failed",
          context.signal?.aborted
            ? "FreeCAD 连接请求已取消。"
            : timedOut
              ? "FreeCAD 连接请求超时。"
              : "FreeCAD 连接请求失败。",
          pythonStarted ? undefined : false,
        );
      } finally {
        clearTimeout(timeout);
        context.signal?.removeEventListener("abort", abort);
      }
    },
  };
}
