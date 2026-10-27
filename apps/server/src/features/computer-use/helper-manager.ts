import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
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
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_CLIENT_TIMEOUT_MS = 10_000;

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
  startupTimeoutMs?: number;
  clientTimeoutMs?: number;
}

/** 真实 Helper.app 的启动、握手、权限查询、重启与关闭。 */
export class HelperProcessManager {
  private readonly appPath: string;
  private readonly socketPath: string;
  private readonly token: string;
  private readonly clientVersion: string;
  private readonly startupTimeoutMs: number;
  private readonly clientTimeoutMs: number;
  private appInfoPromise: Promise<HelperAppInfo> | undefined;
  private client: HelperClient | null = null;
  private startPromise: Promise<HelperClient> | null = null;

  constructor(options: HelperProcessManagerOptions) {
    this.appPath = options.appPath;
    this.socketPath = options.socketPath;
    this.token = options.token ?? randomBytes(32).toString("hex");
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.clientTimeoutMs = options.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
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

  async applications(): Promise<ComputerUseHelperApplicationsResult> {
    const client = await this.ensureClient();
    const raw = await this.request("apps.list", undefined, client);
    return computerUseHelperApplicationsResultSchema.parse(raw);
  }

  async windows(pid: number): Promise<ComputerUseHelperWindowsResult> {
    const client = await this.ensureClient();
    const raw = await this.request("windows.list", { pid }, client);
    return computerUseHelperWindowsResultSchema.parse(raw);
  }

  async displays(): Promise<ComputerUseHelperDisplaysResult> {
    const client = await this.ensureClient();
    const raw = await this.request("displays.list", undefined, client);
    return computerUseHelperDisplaysResultSchema.parse(raw);
  }

  async axTree(
    params: ComputerUseHelperAxTreeParams,
  ): Promise<ComputerUseHelperAxTreeResult> {
    const client = await this.ensureClient();
    const raw = await this.request("ax.tree", params, client);
    return computerUseHelperAxTreeResultSchema.parse(raw);
  }

  async screenshot(
    params: ComputerUseHelperScreenshotParams,
  ): Promise<ComputerUseHelperScreenshotResult> {
    const client = await this.ensureClient();
    const raw = await this.request("screenshot.capture", params, client);
    return computerUseHelperScreenshotResultSchema.parse(raw);
  }

  async click(
    params: ComputerUseHelperClickParams,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.click", params);
  }

  async typeText(
    params: ComputerUseHelperTypeParams,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.type", params);
  }

  async key(
    params: ComputerUseHelperKeyParams,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.key", params);
  }

  async scroll(
    params: ComputerUseHelperScrollParams,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.scroll", params);
  }

  async drag(
    params: ComputerUseHelperDragParams,
  ): Promise<ComputerUseHelperActionResult> {
    return await this.requestAction("input.drag", params);
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
  ): Promise<ComputerUseHelperActionResult> {
    const client = await this.ensureClient();
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
    timeoutMs?: number,
  ): Promise<T> {
    try {
      return await client.request<T>(method, params, timeoutMs);
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
    try {
      await execFileAsync("/usr/bin/open", args, { timeout: 5_000 });
    } catch (error) {
      throw new HelperProcessError(
        "helper_start_failed",
        `无法启动 Helper.app：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        this.client = await HelperClient.connect({
          socketPath: this.socketPath,
          token: this.token,
          timeoutMs: this.clientTimeoutMs,
          clientVersion: this.clientVersion,
        });
        return this.client;
      } catch (error) {
        lastError = error;
        await delay(50);
      }
    }
    throw new HelperProcessError(
      "helper_start_failed",
      `Helper 未在 ${this.startupTimeoutMs}ms 内就绪：${
        lastError instanceof Error ? lastError.message : String(lastError)
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
