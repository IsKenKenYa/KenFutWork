import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  ManagedStdioProcess,
  ProcessExit,
  ProcessSpawnRequest,
  ProcessStdioSpawnRequest,
  TerminalOutputListener,
} from "../process-sandbox/types.js";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** SDK Server真实JSON-RPC；仅ProcessSandbox受控句柄使用测试替身。 */
export async function stdioProcess(
  request: ProcessSpawnRequest,
  options: {
    stopGate?: Promise<void>;
    ownerTaskId?: string;
    confirmed?: () => boolean;
    toolName?: string;
  } = {},
) {
  const exited = deferred<ProcessExit>();
  const stopEntered = deferred<void>();
  const stdout = new Set<TerminalOutputListener>();
  const stderr = new Set<TerminalOutputListener>();
  const requests: string[] = [];
  const reader = new ReadBuffer();
  let bytes = 0;
  let sequence = 0;
  let exit: ProcessExit | null = null;
  const server = new Server(
    { name: "受控MCP夹具", version: "1" },
    { capabilities: { tools: {} } },
  );
  const transport: Transport = {
    async start() {},
    async send(message) {
      const text = serializeMessage(message);
      // 按完整Unicode code point碎片送达，验证stdio consumer正确拼接UTF8消息。
      for (const data of Array.from(text)) {
        const offset = bytes;
        bytes += Buffer.byteLength(data);
        const cursor = { sequence: ++sequence, offset, nextOffset: bytes };
        for (const callback of stdout) await callback(data, cursor);
      }
    },
    async close() {
      transport.onclose?.();
    },
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: options.toolName ?? "echo",
        annotations: { readOnlyHint: true },
        description: "受控Task回声",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (message) => {
    if (message.params.name !== (options.toolName ?? "echo"))
      throw new Error("MCP原始RPC方法名称不匹配。");
    return {
      content: [
        { type: "text", text: String(message.params.arguments?.text ?? "") },
      ],
    };
  });
  await server.connect(transport);
  const process: ManagedStdioProcess = {
    id: randomUUID(),
    onStdout(callback) {
      stdout.add(callback);
      return () => {
        stdout.delete(callback);
      };
    },
    onStderr(callback) {
      stderr.add(callback);
      return () => {
        stderr.delete(callback);
      };
    },
    async readOutput() {
      throw new Error("MCP协议不得轮询有界capture。");
    },
    async writeStdin(data) {
      if (exit) throw new Error("进程已关闭。");
      requests.push(data);
      for (const callback of stderr)
        await callback("stderr不是JSON-RPC\n", {
          sequence: 1,
          offset: 0,
          nextOffset: 19,
        });
      reader.append(Buffer.from(data));
      let message = reader.readMessage();
      while (message) {
        transport.onmessage?.(message);
        message = reader.readMessage();
      }
    },
    async endStdin() {},
    async stop(reason) {
      stopEntered.resolve();
      await options.stopGate;
      const value = {
        exitCode: null,
        signal: "SIGTERM",
        reason,
        stopped: true,
        rangeEmpty: options.confirmed?.() ?? true,
      };
      if (value.rangeEmpty && !exit) {
        exit = value;
        await server.close();
        exited.resolve(value);
      }
      return value;
    },
    waitForExit: () => exited.promise,
    snapshot: () => ({
      id: process.id,
      ownerTaskId: options.ownerTaskId ?? request.scope.taskId,
      agentId: request.agentId,
      invocationId: request.invocationId,
      generation: request.scope.generation,
      state: exit ? "stopped" : "running",
      pid: 123,
      startedAt: "2026-10-03",
      finishedAt: exit ? "2026-10-03" : null,
      enforcement: {
        backend: "srt-seatbelt",
        filesystem: "enforced",
        processRange: "process-group",
        permissionsGeneration: request.scope.generation,
      },
      exit,
      retainedBytes: Math.min(bytes, request.limits.maxOutputBytes),
      totalBytes: bytes,
      discardedBytes: Math.max(0, bytes - request.limits.maxOutputBytes),
      outputPath: "private-capture",
    }),
  };
  return { process, requests, stopEntered };
}

export function stdioSandbox(
  options: Parameters<typeof stdioProcess>[1] & {
    spawnGate?: Promise<void>;
  } = {},
) {
  const children: Array<Awaited<ReturnType<typeof stdioProcess>>> = [];
  const calls: ProcessStdioSpawnRequest[] = [];
  const sandbox = {
    async spawnStdio(request: ProcessStdioSpawnRequest) {
      calls.push(request);
      const child = await stdioProcess(request, options);
      children.push(child);
      await options.spawnGate;
      return child.process;
    },
  };
  return { sandbox, children, calls };
}
