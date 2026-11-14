import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  type ComputerUseHelperActionResult,
  type ComputerUseHelperApplicationsResult,
  type ComputerUseHelperAxTreeParams,
  type ComputerUseHelperAxTreeResult,
  type ComputerUseHelperClickParams,
  type ComputerUseHelperClipboardReadResult,
  type ComputerUseHelperClipboardWriteParams,
  type ComputerUseHelperClipboardWriteResult,
  type ComputerUseHelperDisplaysResult,
  type ComputerUseHelperDragParams,
  type ComputerUseHelperKeyParams,
  type ComputerUseHelperPermissionRequestKind,
  type ComputerUseHelperPermissionRequestResult,
  type ComputerUseHelperPermissionStatus,
  type ComputerUseHelperScreenshotParams,
  type ComputerUseHelperScreenshotResult,
  type ComputerUseHelperScrollParams,
  type ComputerUseHelperTypeParams,
  type ComputerUseHelperWindowsResult,
  computerUseHelperActionResultSchema,
  computerUseHelperApplicationsResultSchema,
  computerUseHelperAxTreeResultSchema,
  computerUseHelperClipboardReadResultSchema,
  computerUseHelperClipboardWriteResultSchema,
  computerUseHelperDisplaysResultSchema,
  computerUseHelperPermissionRequestResultSchema,
  computerUseHelperPermissionStatusSchema,
  computerUseHelperScreenshotResultSchema,
  computerUseHelperWindowsResultSchema,
} from "@kenfutwork/shared";
import { HelperClient, HelperRpcError } from "./helper-client.js";

const execFileAsync = promisify(execFile);

export class HelperProcessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HelperProcessError";
  }
}

interface HelperAppInfo {
  bundleId: string;
  executableName: string;
  version: string;
}

export interface HelperProcessManagerOptions {
  appPath: string;
  socketPath: string;
  token?: string;
  clientVersion?: string;
  clientTimeoutMs?: number;
  actionTimeoutMs?: () => number;
}

/** 真实 Helper.app 的启动、握手、权限查询、重启与关闭。 */
export class HelperProcessManager {
  private readonly appPath: string;
  private readonly socketPath: string;
  private readonly token: string;
  private readonly clientVersion: string;
  private readonly clientTimeoutMs: number;
  private readonly actionTimeoutMs: () => number;
  private appInfoPromise: Promise<HelperAppInfo> | undefined;
  private client: HelperClient | null = null;
  private startPromise: Promise<HelperClient> | null = null;

  constructor(options: HelperProcessManagerOptions) {
    this.appPath = options.appPath;
    this.socketPath = options.socketPath;
    this.token = options.token ?? randomBytes(32).toString("hex");
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.clientTimeoutMs =
      options.clientTimeoutMs ??
      AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs;
    this.actionTimeoutMs =
      options.actionTimeoutMs ?? (() => this.clientTimeoutMs);
  }

  async status(probe = false): Promise<ComputerUseHelperPermissionStatus> {
    const client = await this.ensureClient();
    const raw = await this.request(
      "permission.status",
      probe ? { probe: true } : undefined,
      client,
    );
    return computerUseHelperPermissionStatusSchema.parse(raw);
  }

  async requestPermission(
    kind: ComputerUseHelperPermissionRequestKind,
  ): Promise<ComputerUseHelperPermissionRequestResult> {
    const client = await this.ensureClient();
    // 系统权限框可能等用户很久；这不是后台动作，不设短超时。
    const raw = await this.request(
      "permission.request",
      { kind },
      client,
      120_000,
    );
    return computerUseHelperPermissionRequestResultSchema.parse(raw);
  }

  async restart(): Promise<{ ok: true }> {
    await this.stop();
    await this.start();
    return { ok: true };
  }

  async applications(
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperApplicationsResult> {
    const client = await this.ensureClient();
    const raw = await this.request(
      "apps.list",
      undefined,
      client,
      undefined,
      signal,
    );
    return computerUseHelperApplicationsResultSchema.parse(raw);
  }

  async windows(
    pid: number,
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperWindowsResult> {
    const client = await this.ensureClient();
    const raw = await this.request(
      "windows.list",
      { pid },
      client,
      undefined,
      signal,
    );
    return computerUseHelperWindowsResultSchema.parse(raw);
  }

  async displays(): Promise<ComputerUseHelperDisplaysResult> {
    const client = await this.ensureClient();
    const raw = await this.request("displays.list", undefined, client);
    return computerUseHelperDisplaysResultSchema.parse(raw);
  }

  async axTree(
    params: ComputerUseHelperAxTreeParams,
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperAxTreeResult> {
    const client = await this.ensureClient();
    const timeoutMs = params.timeoutMs ?? this.actionTimeoutMs();
    const raw = await this.request(
      "ax.tree",
      { ...params, timeoutMs },
      client,
      timeoutMs,
      signal,
    );
    return computerUseHelperAxTreeResultSchema.parse(raw);
  }

  async screenshot(
    params: ComputerUseHelperScreenshotParams,
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperScreenshotResult> {
    const client = await this.ensureClient();
    const raw = await this.request(
      "screenshot.capture",
      params,
      client,
      undefined,
      signal,
    );
    return computerUseHelperScreenshotResultSchema.parse(raw);
  }

  async click(
    params: ComputerUseHelperClickParams,
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.click", params, signal);
  }

  async typeText(
    params: ComputerUseHelperTypeParams,
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.type", params, signal);
  }

  async focus(
    params: { pid: number; windowId: number },
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.focus", params, signal);
  }

  async move(
    params: Pick<ComputerUseHelperClickParams, "pid" | "x" | "y">,
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.move", params, signal);
  }

  async key(
    params: ComputerUseHelperKeyParams,
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.key", params, signal);
  }

  async scroll(
    params: ComputerUseHelperScrollParams,
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.scroll", params, signal);
  }

  async drag(
    params: ComputerUseHelperDragParams,
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.drag", params, signal);
  }

  async readClipboard(): Promise<ComputerUseHelperClipboardReadResult> {
    const client = await this.ensureClient();
    const raw = await this.request("clipboard.read", undefined, client);
    return computerUseHelperClipboardReadResultSchema.parse(raw);
  }

  async writeClipboard(
    params: ComputerUseHelperClipboardWriteParams,
  ): Promise<ComputerUseHelperClipboardWriteResult> {
    const client = await this.ensureClient();
    const raw = await this.request("clipboard.write", params, client);
    return computerUseHelperClipboardWriteResultSchema.parse(raw);
  }

  private async requestAction(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ComputerUseHelperActionResult> {
    signal?.throwIfAborted();
    const client = await this.ensureClient();
    // 已发出的原生输入不能撤回，等待 Helper 回包；未发出的输入在此取消。
    signal?.throwIfAborted();
    const raw = await this.request(method, params, client);
    return computerUseHelperActionResultSchema.parse(raw);
  }

  async start(): Promise<HelperClient> {
    if (this.client && !this.client.socketDestroyed) return this.client;
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.launchAndConnect().finally(() => {
      this.startPromise = null;
    });
    return await this.startPromise;
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.request("helper.shutdown");
      } catch {
        // 关闭请求失败也要释放本地连接；进程退出由 Helper 自己负责。
      } finally {
        client.close();
      }
    }
    await waitForSocketMissing(this.socketPath, 2_000);
    await safeUnlink(this.socketPath);
  }

  async close(): Promise<void> {
    await this.stop();
  }

  private async ensureClient(): Promise<HelperClient> {
    if (this.client && !this.client.socketDestroyed) return this.client;
    this.client = null;
    return await this.start();
  }

  private async request<T = unknown>(
    method: string,
    params: Record<string, unknown> | undefined,
    client: HelperClient,
    timeoutMs = this.actionTimeoutMs(),
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await client.request<T>(method, params, timeoutMs, signal);
    } catch (error) {
      if (error instanceof HelperRpcError && error.code === "disconnected")
        this.client = null;
      throw error;
    }
  }

  private async launchAndConnect(): Promise<HelperClient> {
    const info = await this.readAppInfo();
    const socketDirectory = dirname(this.socketPath);
    await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    await chmod(socketDirectory, 0o700);
    await safeUnlink(this.socketPath);
    const args = [
      "-n",
      "-a",
      this.appPath,
      "--args",
      "--socket",
      this.socketPath,
      "--token",
      this.token,
      "--bundle-id",
      info.bundleId,
      "--helper-path",
      this.appPath,
      "--version",
      info.version,
      "--parent-pid",
      String(process.pid),
    ];
    const startupTimeoutMs = this.actionTimeoutMs();
    const deadline = performance.now() + startupTimeoutMs;
    try {
      await execFileAsync("/usr/bin/open", args, { timeout: startupTimeoutMs });
    } catch (error) {
      throw new HelperProcessError(
        "helper_start_failed",
        `无法启动 Helper.app：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    let lastError: unknown;
    for (;;) {
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs <= 0) break;
      try {
        this.client = await HelperClient.connect({
          socketPath: this.socketPath,
          token: this.token,
          timeoutMs: remainingMs,
          clientVersion: this.clientVersion,
        });
        return this.client;
      } catch (error) {
        lastError = error;
        const retryAfterMs = Math.min(50, deadline - performance.now());
        if (retryAfterMs > 0) await delay(retryAfterMs);
      }
    }
    throw new HelperProcessError(
      "helper_start_failed",
      `Helper 未在 ${startupTimeoutMs}ms 内就绪：${
        lastError instanceof Error ? lastError.message : "启动时间已耗尽"
      }`,
    );
  }

  private async readAppInfo(): Promise<HelperAppInfo> {
    this.appInfoPromise ??= (async () => {
      try {
        await access(this.appPath);
      } catch {
        throw new HelperProcessError(
          "helper_missing",
          `Helper.app 不存在：${this.appPath}`,
        );
      }
      const infoPath = `${this.appPath}/Contents/Info.plist`;
      const { stdout } = await execFileAsync("/usr/bin/plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        infoPath,
      ]);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        throw new HelperProcessError(
          "helper_invalid",
          "Helper Info.plist 不是有效 JSON。",
        );
      }
      const bundleId = parsed.CFBundleIdentifier;
      const executableName = parsed.CFBundleExecutable;
      const version = parsed.CFBundleShortVersionString;
      if (
        typeof bundleId !== "string" ||
        typeof executableName !== "string" ||
        typeof version !== "string"
      )
        throw new HelperProcessError(
          "helper_invalid",
          "Helper Info.plist 缺少 bundleId、可执行名或版本。",
        );
      return { bundleId, executableName, version };
    })();
    return await this.appInfoPromise;
  }
}

async function waitForSocketMissing(
  socketPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(socketPath);
      await delay(50);
    } catch {
      return;
    }
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // 不存在的 socket 是正常状态。
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
