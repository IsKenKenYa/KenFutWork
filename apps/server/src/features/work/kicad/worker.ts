import { mkdirSync } from "node:fs";
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
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(KicadWorker.pluginRoot(), "dist", "server.mjs")],
      cwd: workspace,
      env: {
        ...process.env,
        ZCODE_WORKSPACE_ROOT: workspace,
        ZCODE_PLUGIN_DATA: this.pluginDataDir(),
      },
      stderr: "pipe",
    });
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
    return result as unknown as Record<string, unknown>;
  }

  async readResource(uri: string): Promise<Record<string, unknown>> {
    const client = await this.connect();
    const result = await client.readResource({ uri }, { timeout: REQUEST_TIMEOUT_MS });
    return result as unknown as Record<string, unknown>;
  }

  /** 面板与信息页用：服务是否可用、工具清单、KiCad 安装事实。 */
  async status(): Promise<{
    ready: boolean;
    error: string | null;
    tools: string[];
    kicadVersion: string | null;
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
        workspace: this.workspaceDir(),
      };
    } catch (error) {
      return {
        ready: false,
        error: error instanceof Error ? error.message : String(error),
        tools: [],
        kicadVersion: null,
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
