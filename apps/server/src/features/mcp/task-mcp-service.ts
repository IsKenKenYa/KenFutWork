import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { CodeExecutionScope } from "@kenfutwork/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ToolExecutionContext, ToolRegistry } from "../../kernel/types.js";
import type { ComputerUseMcpConnection } from "../computer-use/mcp-backend.js";
import { losesExecutionRights } from "../process-sandbox/scope-change.js";
import type { ProcessSandbox } from "../process-sandbox/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import { type McpAppPages, mcpAppClientCapabilities } from "./mcp-app-pages.js";
import {
  type McpResourceRequest,
  type McpResourceResult,
  registerMcpResourceTools,
  requestMcpResource,
} from "./mcp-resource-tools.js";
import type { McpConnectionConfiguration } from "./mcp-service.js";
import {
  assertMcpContribution,
  assertModelVisibleMcpTool,
  callMcpTool,
  createMcpToolDefinition,
  isModelVisibleMcpTool,
  type McpServerToolLike,
  type McpToolCallResult,
  mcpConfigurationVersion,
  mcpToolContractVersion,
} from "./mcp-tools.js";
import {
  createScopedMcpTransport,
  type ScopedMcpTransport,
} from "./scoped-stdio-transport.js";
import {
  inferMcpCommand,
  type McpTaskContext,
  mcpFailure,
  refreshMcpScope,
  TaskMcpError,
  taskMcpContext,
  taskMcpCreateSchema,
  taskMcpInstallSchema,
} from "./task-mcp-context.js";

export interface TaskMcpInstallInput {
  name: string;
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
}
export interface TaskMcpCreateInput
  extends Omit<TaskMcpInstallInput, "command"> {
  path: string;
  command?: string | undefined;
}
export interface TaskMcpStatus {
  name: string;
  taskId: string;
  status: "connecting" | "connected" | "closing" | "error";
  envKeys: string[];
  toolNames: string[];
  error?: string;
}
export interface TaskMcpService {
  readConfiguredResource(
    source: McpConnectionConfiguration,
    request: McpResourceRequest,
    context: ToolExecutionContext,
  ): Promise<McpResourceResult>;
  callConfigured(
    source: McpConnectionConfiguration,
    tool: McpServerToolLike,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<McpToolCallResult>;
  closeSource(name: string): Promise<void>;
  computerUseConnections(
    context: ToolExecutionContext,
  ): Promise<ComputerUseMcpConnection[]>;
  create(
    input: TaskMcpCreateInput,
    context: ToolExecutionContext,
  ): Promise<TaskMcpStatus>;
  install(
    input: TaskMcpInstallInput,
    context: ToolExecutionContext,
  ): Promise<TaskMcpStatus>;
  remove(name: string, context: ToolExecutionContext): Promise<void>;
  list(context: ToolExecutionContext): Promise<TaskMcpStatus[]>;
  closeTask(instanceId: string, taskId: string, reason: string): Promise<void>;
  revoke(previous: CodeExecutionScope, next: CodeExecutionScope): Promise<void>;
  shutdown(reason: string): Promise<void>;
}

type StartInput = ReturnType<typeof taskMcpInstallSchema.parse> & {
  path?: string;
};
interface Connection {
  key: string;
  owner: McpTaskContext;
  input: StartInput;
  signature: string;
  sourceName?: string;
  status: TaskMcpStatus["status"];
  error?: string;
  closing: boolean;
  scope: CodeExecutionScope;
  toolNames: string[];
  modelToolVersions: Map<string, string>;
  disposeTools: Array<() => void>;
  client: Client;
  transport?: ScopedMcpTransport;
  transportReady: Promise<ScopedMcpTransport | null>;
  ready: Promise<TaskMcpStatus>;
  stopping?: Promise<void> | undefined;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function createTaskMcpService(deps: {
  sandbox: Pick<ProcessSandbox, "spawnStdio">;
  registry: ToolRegistry;
  settings: Pick<SettingsService, "getInstanceSettings">;
  version: string;
  pages?: McpAppPages;
}): TaskMcpService {
  const records = new Map<string, Connection>();
  const closedTasks = new Set<string>();
  let closed = false;
  let shutdown: Promise<void> | undefined;
  const taskKey = (scope: Pick<CodeExecutionScope, "instanceId" | "taskId">) =>
    JSON.stringify([scope.instanceId, scope.taskId]);
  const publicStatus = (record: Connection): TaskMcpStatus => ({
    name: record.input.name,
    taskId: record.scope.taskId,
    status: record.status,
    envKeys: Object.keys(record.input.env),
    toolNames: [...record.toolNames],
    ...(record.error ? { error: record.error } : {}),
  });
  const ensureOpen = (record: Connection) => {
    if (closed || record.closing || closedTasks.has(taskKey(record.scope)))
      throw new TaskMcpError(
        "mcp_closed",
        "MCP连接或Task已关闭，禁止迟到启动/调用。",
      );
  };
  const forget = (record: Connection) => {
    deps.pages?.closeSource(record.client);
    for (const dispose of record.disposeTools.splice(0).reverse()) dispose();
    if (records.get(record.key) === record) records.delete(record.key);
  };
  const requestOptions = async (
    owner: McpTaskContext,
  ): Promise<RequestOptions> => {
    const settings = await deps.settings.getInstanceSettings(
      owner.actor,
      owner.scope.instanceId,
    );
    return {
      timeout: settings.executeTimeoutMs,
      maxTotalTimeout: settings.executeTimeoutMs,
      ...(owner.signal ? { signal: owner.signal } : {}),
    };
  };

  const requireConnection = async (
    record: Connection,
    execution: ToolExecutionContext,
  ) => {
    const owner = taskMcpContext(execution);
    if (
      taskKey(owner.scope) !== taskKey(record.scope) ||
      owner.actor.instanceId !== record.owner.actor.instanceId ||
      owner.branchGeneration !== record.owner.branchGeneration
    )
      throw new TaskMcpError(
        "mcp_owner_mismatch",
        "MCP工具不属于当前Task、用户或分支身份。",
        403,
      );
    await refreshMcpScope(owner);
    ensureOpen(record);
    if (
      records.get(record.key) !== record ||
      losesExecutionRights(record.scope, owner.scope)
    )
      throw new TaskMcpError(
        "mcp_closed",
        "MCP工具所属授权已经收紧或连接已失效。",
      );
    return owner;
  };

  const call = async (
    record: Connection,
    name: string,
    args: Record<string, unknown>,
    execution: ToolExecutionContext,
    tool?: McpServerToolLike,
  ) => {
    const owner = await requireConnection(record, execution);
    if (!record.modelToolVersions.has(name))
      throw new TaskMcpError(
        "mcp_tool_not_model_visible",
        "MCP工具未向模型开放，请检查工具声明。",
        403,
      );
    if (!record.sourceName)
      assertMcpContribution(
        deps.registry,
        `mcp:${record.key}:${name}`,
        execution,
      );
    try {
      const result = await callMcpTool(
        record.client,
        { name, arguments: args },
        await requestOptions(owner),
      );
      if (!tool || !deps.pages) return result;
      return deps.pages.capture({
        source: {
          client: record.client,
          current: () => !record.closing && records.get(record.key) === record,
          options: (signal) => requestOptions({ ...owner, signal }),
        },
        tool,
        serverName: record.sourceName ?? record.input.name,
        context: execution,
        args,
        result,
      });
    } catch (error) {
      throw mcpFailure(error, record.input.env, "mcp_call_failed");
    }
  };

  const readResource = async (
    record: Connection,
    request: McpResourceRequest,
    execution: ToolExecutionContext,
  ): Promise<McpResourceResult> => {
    try {
      const config = await requestOptions(taskMcpContext(execution));
      await requireConnection(record, execution);
      const result = await requestMcpResource(record.client, request, config);
      await requireConnection(record, execution);
      return result;
    } catch (error) {
      execution.signal?.throwIfAborted();
      throw mcpFailure(error, record.input.env, "mcp_resource_failed");
    }
  };

  const prepareTransport = async (
    record: Connection,
  ): Promise<ScopedMcpTransport> => {
    await refreshMcpScope(record.owner);
    ensureOpen(record);
    const cwd = await record.owner.handle.resolvePath(
      record.input.cwd ?? ".",
      "read",
    );
    let args = record.input.args;
    if (record.input.path) {
      const script = await record.owner.handle.resolvePath(
        record.input.path,
        "read",
      );
      if (!(await stat(script)).isFile())
        throw new Error("MCP脚本必须是Task授权目录内的普通文件。");
      if (
        (await record.owner.handle.resolvePath(record.input.path, "read")) !==
        script
      )
        throw new Error("MCP脚本的真实路径已改变。");
      args = [script, ...args];
    }
    const settings = await deps.settings.getInstanceSettings(
      record.owner.actor,
      record.owner.scope.instanceId,
    );
    await refreshMcpScope(record.owner);
    ensureOpen(record);
    record.scope = record.owner.scope;
    return createScopedMcpTransport({
      sandbox: deps.sandbox,
      maxMessageBytes: settings.processMaxOutputBytes,
      request: {
        scope: record.scope,
        agentId: record.owner.handle.agentId,
        invocationId: `mcp:${randomUUID()}`,
        argv: { executable: record.input.command, args },
        cwd,
        env: record.input.env,
        background: true,
        timeoutMs: null,
        limits: {
          maxOutputBytes: settings.processMaxOutputBytes,
          previewMaxChars: settings.processPreviewMaxChars,
          yieldMs: settings.processYieldMs,
          killGraceMs: settings.processKillGraceMs,
        },
      },
    });
  };

  const registerTools = (
    record: Connection,
    tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  ): void => {
    // 摘要/标签长度是<=64 ASCII的函数标识编码，非运行预算；权限始终核对完整身份。
    const namespace = `task_${createHash("sha256")
      .update(
        JSON.stringify([
          record.scope.instanceId,
          record.scope.taskId,
          record.input.name,
        ]),
      )
      .digest("hex")
      .slice(0, 12)}`;
    for (const metadata of tools) {
      const alias = `${metadata.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24)}_${createHash("sha256").update(metadata.name).digest("hex").slice(0, 8)}`;
      const tool = createMcpToolDefinition(
        namespace,
        {
          ...metadata,
          name: alias,
          description: `${record.input.name}/${metadata.name}: ${metadata.description ?? "MCP工具"}`,
        },
        "shared",
        (args, context) => call(record, metadata.name, args, context, metadata),
      );
      record.toolNames.push(tool.name);
      record.disposeTools.push(
        deps.registry.registerDynamic({
          id: `mcp:${record.key}:${metadata.name}`,
          scope: "shared",
          configurationVersion: mcpConfigurationVersion({
            configuration: record.signature,
            branchGeneration: record.owner.branchGeneration,
            contract: mcpToolContractVersion(metadata),
          }),
          resolve(run) {
            const handle = run.scopeHandle;
            if (
              !handle ||
              record.closing ||
              closed ||
              record.status !== "connected" ||
              taskKey(handle.describe()) !== taskKey(record.scope) ||
              handle.role === "explore" ||
              handle.role === "review" ||
              handle.describe().sandboxMode === "read-only"
            )
              return null;
            return tool;
          },
        }),
      );
    }
  };

  const connect = async (
    record: Connection,
    transportReady: (value: ScopedMcpTransport | null) => void,
  ): Promise<TaskMcpStatus> => {
    try {
      record.transport = await prepareTransport(record);
      transportReady(record.transport);
      record.client.onerror = (error) => {
        record.error = mcpFailure(
          error,
          record.input.env,
          "mcp_protocol_failed",
        ).message;
      };
      record.client.onclose = () => {
        record.closing = true;
        forget(record);
      };
      await record.client.connect(
        record.transport,
        await requestOptions(record.owner),
      );
      ensureOpen(record);
      const discovered = record.client.getServerCapabilities()?.tools
        ? await record.client.listTools(
            undefined,
            await requestOptions(record.owner),
          )
        : { tools: [] };
      ensureOpen(record);
      const tools = discovered.tools.filter(isModelVisibleMcpTool);
      for (const tool of tools)
        record.modelToolVersions.set(tool.name, mcpToolContractVersion(tool));
      if (!record.sourceName) {
        registerTools(record, tools);
        if (record.client.getServerCapabilities()?.resources) {
          const resources = registerMcpResourceTools({
            registry: deps.registry,
            sourceId: `task:${record.key}`,
            sourceName: record.input.name,
            configurationVersion: mcpConfigurationVersion({
              configuration: record.signature,
              branchGeneration: record.owner.branchGeneration,
            }),
            allowRun: ({ scopeHandle }) =>
              !closed &&
              !record.closing &&
              record.status === "connected" &&
              Boolean(
                scopeHandle &&
                  taskKey(scopeHandle.describe()) === taskKey(record.scope) &&
                  scopeHandle.branchGeneration ===
                    record.owner.branchGeneration,
              ),
            call: (request, context) => readResource(record, request, context),
          });
          record.toolNames.push(...resources.names);
          record.disposeTools.push(resources.dispose);
        }
      }
      record.status = "connected";
      return publicStatus(record);
    } catch (error) {
      record.closing = true;
      record.status = "error";
      record.error = mcpFailure(
        error,
        record.input.env,
        "mcp_connect_failed",
      ).message;
      if (record.transport) {
        try {
          await record.transport.stop("MCP创建/握手失败");
        } catch (stopError) {
          record.error = mcpFailure(
            stopError,
            record.input.env,
            "stop_unconfirmed",
          ).message;
          throw mcpFailure(stopError, record.input.env, "stop_unconfirmed");
        }
      }
      forget(record);
      throw mcpFailure(error, record.input.env, "mcp_connect_failed");
    } finally {
      transportReady(record.transport ?? null);
    }
  };

  const start = (
    input: StartInput,
    context: ToolExecutionContext,
    sourceName?: string,
  ): Promise<TaskMcpStatus> => {
    const owner = taskMcpContext(context);
    if (closed || closedTasks.has(taskKey(owner.scope)))
      throw new TaskMcpError("mcp_closed", "MCP宿主或Task已关闭。");
    const key = JSON.stringify([
      owner.scope.instanceId,
      owner.scope.taskId,
      input.name,
    ]);
    const signature = mcpConfigurationVersion(input);
    const prior = records.get(key);
    if (prior) {
      ensureOpen(prior);
      if (
        prior.signature !== signature ||
        prior.owner.actor.instanceId !== owner.actor.instanceId ||
        prior.sourceName !== sourceName ||
        prior.owner.branchGeneration !== owner.branchGeneration
      )
        throw new TaskMcpError(
          "mcp_config_conflict",
          "同名MCP已安装，请先卸载再更改启动配置或分支。",
        );
      return refreshMcpScope(owner).then(() => {
        ensureOpen(prior);
        return prior.ready;
      });
    }
    const ready = deferred<TaskMcpStatus>();
    const transport = deferred<ScopedMcpTransport | null>();
    const record: Connection = {
      key,
      owner,
      input,
      signature,
      ...(sourceName ? { sourceName } : {}),
      status: "connecting",
      closing: false,
      scope: owner.scope,
      toolNames: [],
      modelToolVersions: new Map(),
      disposeTools: [],
      client: new Client(
        { name: "kenfutwork-task", version: deps.version },
        deps.pages ? { capabilities: mcpAppClientCapabilities } : undefined,
      ),
      ready: ready.promise,
      transportReady: transport.promise,
    };
    deps.pages?.observeSource(record.client);
    records.set(key, record);
    void ready.promise.catch(() => {});
    void connect(record, transport.resolve).then(ready.resolve, ready.reject);
    return record.ready;
  };

  const stop = (record: Connection, reason: string): Promise<void> => {
    record.closing = true;
    deps.pages?.closeSource(record.client);
    record.status = "closing";
    if (record.stopping) return record.stopping;
    record.stopping = (async () => {
      const transport = await record.transportReady;
      if (transport) await transport.stop(reason);
      try {
        await record.ready;
      } catch {
        /* 启动失败也已完成受控进程清理。 */
      }
      forget(record);
    })().catch((error) => {
      record.stopping = undefined;
      record.status = "error";
      record.error = mcpFailure(
        error,
        record.input.env,
        "stop_unconfirmed",
      ).message;
      throw mcpFailure(error, record.input.env, "stop_unconfirmed");
    });
    return record.stopping;
  };
  const closeRecords = async (selected: Connection[], reason: string) => {
    for (const record of selected) record.closing = true;
    const results = await Promise.allSettled(
      selected.map((record) => stop(record, reason)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };

  const configuredConnection = async (
    source: McpConnectionConfiguration,
    context: ToolExecutionContext,
  ) => {
    const owner = taskMcpContext(context);
    const input = taskMcpInstallSchema.parse({
      name: `instance_${source.name}`,
      command: source.command,
      args: source.args,
      env: source.env,
    });
    await start(input, context, source.name);
    const record = records.get(
      JSON.stringify([owner.scope.instanceId, owner.scope.taskId, input.name]),
    );
    if (!record)
      throw new TaskMcpError("mcp_closed", "MCP连接已关闭，请重新连接。");
    return record;
  };

  return {
    async readConfiguredResource(source, request, context) {
      return readResource(
        await configuredConnection(source, context),
        request,
        context,
      );
    },
    async callConfigured(source, tool, args, context) {
      assertModelVisibleMcpTool(tool);
      const record = await configuredConnection(source, context);
      if (
        record.modelToolVersions.get(tool.name) !== mcpToolContractVersion(tool)
      )
        throw new TaskMcpError(
          "mcp_schema_changed",
          "MCP在当前Task返回了不同工具定义，请重新连接后发起新运行。",
        );
      return call(record, tool.name, args, context, tool);
    },
    async closeSource(name) {
      await closeRecords(
        [...records.values()].filter((record) => record.sourceName === name),
        "实例MCP配置或连接已改变",
      );
    },
    async computerUseConnections(context) {
      const owner = taskMcpContext(context);
      await refreshMcpScope(owner);
      return [...records.values()].flatMap((record) => {
        const capability = record.client.getServerCapabilities()
          ?.experimental?.["kenfutwork.computer-use"] as
          | { version?: number }
          | undefined;
        if (
          record.closing ||
          record.sourceName ||
          record.status !== "connected" ||
          taskKey(record.scope) !== taskKey(owner.scope) ||
          capability?.version !== 1
        )
          return [];
        return [
          {
            id: `task:${createHash("sha256").update(record.key).digest("hex")}`,
            name: record.input.name,
            call: (
              name: string,
              args: Record<string, unknown>,
              execution: ToolExecutionContext,
            ) => call(record, name, args, execution),
          },
        ];
      });
    },
    async create(input, context) {
      const parsed = taskMcpCreateSchema.parse(input);
      return start(
        { ...parsed, command: parsed.command ?? inferMcpCommand(parsed.path) },
        context,
      );
    },
    async install(input, context) {
      return start(taskMcpInstallSchema.parse(input), context);
    },
    async list(context) {
      const owner = taskMcpContext(context, false);
      await refreshMcpScope(owner, false);
      return [...records.values()]
        .filter(
          (record) =>
            !record.sourceName &&
            taskKey(record.scope) === taskKey(owner.scope) &&
            record.owner.actor.instanceId === owner.actor.instanceId,
        )
        .map(publicStatus);
    },
    async remove(name, context) {
      const owner = taskMcpContext(context);
      await refreshMcpScope(owner);
      const record = records.get(
        JSON.stringify([owner.scope.instanceId, owner.scope.taskId, name]),
      );
      if (!record) return;
      if (
        record.owner.actor.instanceId !== owner.actor.instanceId ||
        record.owner.branchGeneration !== owner.branchGeneration ||
        (owner.handle.role !== "main" &&
          record.owner.handle.agentId !== owner.handle.agentId)
      )
        throw new TaskMcpError(
          "mcp_owner_mismatch",
          "子代理只能卸载自己安装的MCP连接。",
          403,
        );
      await stop(record, "Task MCP已卸载");
    },
    async closeTask(instanceId, taskId, reason) {
      const key = taskKey({ instanceId, taskId });
      closedTasks.add(key);
      await closeRecords(
        [...records.values()].filter((record) => taskKey(record.scope) === key),
        reason,
      );
    },
    async revoke(previous, next) {
      await closeRecords(
        [...records.values()].filter(
          (record) =>
            taskKey(record.scope) === taskKey(previous) &&
            losesExecutionRights(record.scope, next),
        ),
        "Task目录或权限已收紧",
      );
    },
    shutdown(reason) {
      closed = true;
      shutdown ??= closeRecords([...records.values()], reason).catch(
        (error) => {
          shutdown = undefined;
          throw error;
        },
      );
      return shutdown;
    },
  };
}
