import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * 随仓库分发的 ZCode KiCad 插件（MIT，`assets/kicad-plugin`）——真实的 MCP 服务：
 * Python `fastmcp` + `kicad-cli`/`pcbnew`，工具覆盖电路 spec、真实 KiCad 库、布线、
 * DRC、Gerber/BOM/CPL、3D 与在 KiCad 里继续编辑。
 *
 * 这里只做宿主侧的生命周期与转发：MCP stdio 客户端常驻，面板与 agent 共用同一个
 * 服务进程（产物存插件数据目录，跨调用可见）。KiCad 未安装时服务照常启动，工具会
 * 返回安装说明——与上游行为一致。
 */

/** 单次工具调用的协议超时；上游声明 300s（面板轮询与 DRC 渲染都在这个量级）。 */
const REQUEST_TIMEOUT_MS = 300_000;

export interface KicadToolSummary {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown> | undefined;
  title?: string;
}

/** 界面上「装到哪里」的默认位置：Windows 走官方安装包默认目录，macOS 是应用包。 */
const KICAD_INSTALL_HINT =
  process.platform === "win32"
    ? "C:/Program Files/KiCad/10.0"
    : process.platform === "darwin"
      ? "/Applications/KiCad/KiCad.app"
      : "/usr";

/** Windows 上 KiCad 的默认安装根（官方安装包装到 `<根>\<版本>\`）。 */
export const WINDOWS_INSTALL_ROOTS = [
  "C:/Program Files/KiCad",
  "C:/Program Files (x86)/KiCad",
];

/** 在若干安装根里挑一个带 `bin/kicad-cli.exe` 的版本目录（版本号倒序）。 */
export function pickKicadInstall(roots: readonly string[]): string | null {
  for (const root of roots) {
    let versions: string[];
    try {
      versions = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
      continue;
    }
    for (const version of versions) {
      const dir = join(root, version);
      if (existsSync(join(dir, "bin", "kicad-cli.exe"))) return dir;
    }
  }
  return null;
}

export class KicadWorker {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private tools: KicadToolSummary[] = [];
  private closed = false;
  private readonly startedListeners: Array<
    (tools: KicadToolSummary[]) => void
  > = [];
  private notified = false;

  constructor(private readonly dataDir: string) {}

  static pluginRoot(): string {
    return fileURLToPath(new URL("../../../../assets/kicad-plugin/", import.meta.url));
  }

  /** agent 的工作区：`kicad_export_files` 把产物写到这里的 `kicad/out/`。 */
  workspaceDir(): string {
    return join(this.dataDir, "work", "kicad", "workspace");
  }

  private pluginDataDir(): string {
    return join(this.dataDir, "work", "kicad", "plugin-data");
  }

  /** 容器模式：KiCad 官方镜像（`kicad/kicad`），既不装系统也不需要管理员权限。 */
  dockerImage(): string | null {
    const configured = (process.env.KENFUTWORK_KICAD_DOCKER ?? "").trim();
    return configured || null;
  }

  /**
   * KiCad 安装目录：`KENFUTWORK_KICAD_APP` 显式指定 > Windows 默认安装（按版本号倒序）
   * > 实例内的便携解包目录。与 Python 侧 `config.kicad_app_dir()` 同一口径：装完即被找到，
   * 不需要重启服务。
   */
  kicadAppDir(): string {
    const image = this.dockerImage();
    if (image) return image;
    const configured = (process.env.KENFUTWORK_KICAD_APP ?? "").trim();
    if (configured) return configured;
    return (
      pickKicadInstall(WINDOWS_INSTALL_ROOTS) ??
      join(this.dataDir, "runtime", "kicad")
    );
  }

  /** `kicad-cli` 是否存在（两平台各自的相对位置；容器模式恒可用）。 */
  kicadInstalled(): boolean {
    if (this.dockerImage()) return true;
    const root = this.kicadAppDir();
    return (
      existsSync(join(root, "bin", "kicad-cli.exe")) ||
      existsSync(join(root, "bin", "kicad-cli")) ||
      existsSync(join(root, "Contents", "MacOS", "kicad-cli"))
    );
  }

  private async connect(): Promise<Client> {
    if (this.closed) throw new Error("KiCad 服务已关闭。");
    if (this.client) return this.client;
    this.connecting ??= this.start().catch((error: unknown) => {
      this.connecting = null;
      throw error;
    });
    this.client = await this.connecting;
    return this.client;
  }

  private async start(): Promise<Client> {
    const workspace = this.workspaceDir();
    mkdirSync(workspace, { recursive: true });
    mkdirSync(this.pluginDataDir(), { recursive: true });
    const image = this.dockerImage();
    // SDK 要求 Record<string, string>：process.env 的值可能是 undefined。
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) childEnv[key] = value;
    }
    const bind = (source: string, target: string): string[] => [
      "--mount",
      `type=bind,source=${source},target=${target}${target === "/plugin" ? ",readonly" : ""}`,
    ];
    const transport = new StdioClientTransport(
      image
        ? {
            command: "docker",
            args: [
              "run",
              "-i",
              "--rm",
              "--name",
              `kfw-kicad-${process.pid}`,
              ...bind(KicadWorker.pluginRoot(), "/plugin"),
              ...bind(workspace, "/ws"),
              ...bind(this.pluginDataDir(), "/data"),
              "-e",
              "ZCODE_WORKSPACE_ROOT=/ws",
              "-e",
              "ZCODE_PLUGIN_DATA=/data",
              image,
              "python3",
              "/plugin/dist/py/kicad_server.py",
            ],
            cwd: workspace,
            env: childEnv,
            stderr: "pipe",
          }
        : {
            command: process.execPath,
            args: [join(KicadWorker.pluginRoot(), "dist", "server.mjs")],
            cwd: workspace,
            env: {
              ...process.env,
              ZCODE_WORKSPACE_ROOT: workspace,
              ZCODE_PLUGIN_DATA: this.pluginDataDir(),
              ...(this.kicadInstalled()
                ? { ZCODE_KICAD_APP: this.kicadAppDir() }
                : {}),
            },
            stderr: "pipe",
          },
    );
    const client = new Client(
      { name: "kenfutwork-kicad", version: "1.0.0" },
      { capabilities: {} },
    );
    // 首次启动要等 uv 拉依赖（离线时才失败）：把子进程诊断写进服务日志，别静默超时。
    transport.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.log(`[kicad] ${text}`);
    });
    await client.connect(transport);
    return client;
  }

  /** 工具清单就绪后回调一次；插件据此把工具接进内核（懒启动）。 */
  onStarted(listener: (tools: KicadToolSummary[]) => void): void {
    this.startedListeners.push(listener);
    if (this.notified) listener(this.tools);
  }

  /** 后台启动服务（Work 页面打开时调用）；失败留到 status 里如实报告。 */
  ensureStarted(): void {
    void this.listTools().catch(() => undefined);
  }

  private notifyStarted(): void {
    if (this.notified) return;
    this.notified = true;
    for (const listener of this.startedListeners) {
      try {
        listener(this.tools);
      } catch (error) {
        console.warn("[work] KiCad 工具注册失败：", error);
      }
    }
  }

  async listTools(): Promise<KicadToolSummary[]> {
    if (this.tools.length > 0) return this.tools;
    const client = await this.connect();
    const listed = await client.listTools(undefined, {
      timeout: REQUEST_TIMEOUT_MS,
    });
    this.tools = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
      ...(tool.title ? { title: tool.title } : {}),
    }));
    this.notifyStarted();
    return this.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const client = await this.connect();
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: REQUEST_TIMEOUT_MS,
    });
    return this.remap(result) as unknown as Record<string, unknown>;
  }

  async readResource(uri: string): Promise<Record<string, unknown>> {
    const client = await this.connect();
    const result = await client.readResource({ uri }, { timeout: REQUEST_TIMEOUT_MS });
    return this.remap(result) as unknown as Record<string, unknown>;
  }

  /** 容器里的 `/ws`、`/data` 映射回宿主机路径，工具结果里的路径才对用户成立。 */
  private remap<T>(value: T): T {
    if (!this.dockerImage()) return value;
    const pairs: Array<[string, string]> = [
      ["/ws", this.workspaceDir()],
      ["/data", this.pluginDataDir()],
    ];
    const walk = (node: unknown): unknown => {
      if (typeof node === "string") {
        return pairs.reduce(
          (text, [from, to]) => text.split(from).join(to),
          node,
        );
      }
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === "object") {
        return Object.fromEntries(
          Object.entries(node as Record<string, unknown>).map(([key, item]) => [
            key,
            walk(item),
          ]),
        );
      }
      return node;
    };
    return walk(value) as T;
  }

  /** 面板与信息页用：服务是否可用、工具清单、KiCad 安装事实。 */
  async status(): Promise<{
    ready: boolean;
    error: string | null;
    tools: string[];
    kicadVersion: string | null;
    kicadInstalled: boolean;
    kicadApp: string;
    /** 界面上提示用户「装到哪里」的默认位置（按平台）。 */
    kicadInstallHint: string;
    workspace: string;
  }> {
    try {
      await this.listTools();
      const info = await this.callTool("kicad_info", {});
      const structured = info.structuredContent as
        | { kicad_version?: string }
        | undefined;
      return {
        ready: true,
        error: null,
        tools: this.tools.map((tool) => tool.name),
        kicadVersion: structured?.kicad_version ?? null,
        kicadInstalled: this.kicadInstalled(),
        kicadApp: this.kicadAppDir(),
        kicadInstallHint: KICAD_INSTALL_HINT,
        workspace: this.workspaceDir(),
      };
    } catch (error) {
      return {
        ready: false,
        error: error instanceof Error ? error.message : String(error),
        tools: [],
        kicadVersion: null,
        kicadInstalled: this.kicadInstalled(),
        kicadApp: this.kicadAppDir(),
        kicadInstallHint: KICAD_INSTALL_HINT,
        workspace: this.workspaceDir(),
      };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    // 启动还在路上时先等它落地，否则子进程会在关闭之后才起来。
    await this.connecting?.catch(() => undefined);
    const client = this.client;
    this.client = null;
    this.connecting = null;
    this.tools = [];
    await client?.close().catch(() => undefined);
  }
}

export { REQUEST_TIMEOUT_MS };
