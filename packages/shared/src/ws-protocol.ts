import { z } from "zod";
import { runCreateRequestSchema, terminalShellSchema } from "./contracts.js";
import { streamEventSchema } from "./events.js";

// --- Server → Client: Push Event (replaces SSE) ---

export const wsServerEventSchema = z.object({
  type: z.literal("event"),
  event: streamEventSchema,
});

// --- Server → Client: RPC Request ---

export const wsRpcRequestSchema = z.object({
  type: z.literal("rpc.request"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

// --- Server → Client: Command Ack ---

export const wsCommandAckSchema = z.object({
  type: z.literal("command.ack"),
  action: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

// --- Client → Server: Command ---

export const wsRunCommandSchema = z.object({
  type: z.literal("command"),
  action: z.literal("agent.run"),
  payload: runCreateRequestSchema,
});

export const wsCancelCommandSchema = z.object({
  type: z.literal("command"),
  action: z.literal("agent.cancel"),
  payload: z.object({ runId: z.string().min(1) }),
});

export const wsResumeCommandSchema = z.object({
  type: z.literal("command"),
  action: z.literal("canvas.resume"),
  payload: z.object({
    canvasId: z.string().min(1),
    lastSeq: z.number().int().min(0).default(0),
  }),
});

/**
 * 终端会话（R3-1「终端」标签的交互式形态）：一条**持久 shell**（cd 保留、REPL 可用），
 * 输入输出都走这条已有的 WS 连接——不再为每条命令起一个进程。
 *
 * `sessionId` 由客户端生成（一个终端标签一个）：WS 重连后用同一个 id 重新
 * `terminal.start` 即可，界面上不会出现「一断线就多出一个终端」。
 */
export const wsTerminalStartCommandSchema = z.object({
  type: z.literal("command"),
  action: z.literal("terminal.start"),
  payload: z.object({
    sessionId: z.string().min(1).max(64),
    canvasId: z.string().min(1),
    shell: terminalShellSchema.optional(),
  }),
});

export const wsTerminalInputCommandSchema = z.object({
  type: z.literal("command"),
  action: z.literal("terminal.input"),
  payload: z.object({
    sessionId: z.string().min(1).max(64),
    /** 一行输入（换行由服务端补：客户端只发内容）。 */
    data: z.string().max(4096),
  }),
});

export const wsTerminalStopCommandSchema = z.object({
  type: z.literal("command"),
  action: z.literal("terminal.stop"),
  payload: z.object({ sessionId: z.string().min(1).max(64) }),
});

export const wsTerminalCommandSchemas = [
  wsTerminalStartCommandSchema,
  wsTerminalInputCommandSchema,
  wsTerminalStopCommandSchema,
] as const;

export const wsCommandSchema = z.discriminatedUnion("action", [
  wsRunCommandSchema,
  wsCancelCommandSchema,
  wsResumeCommandSchema,
  wsTerminalStartCommandSchema,
  wsTerminalInputCommandSchema,
  wsTerminalStopCommandSchema,
]);

// --- Client → Server: RPC Response ---

export const wsRpcResponseSchema = z.object({
  type: z.literal("rpc.response"),
  id: z.string().min(1),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

// --- Union: Client → Server ---
// Uses z.union instead of z.discriminatedUnion because wsCommandSchema is itself
// a discriminated union (by "action"), which Zod v3 does not support as a nested
// element in another discriminatedUnion.

export const wsClientMessageSchema = z.union([
  wsRunCommandSchema,
  wsCancelCommandSchema,
  wsResumeCommandSchema,
  wsTerminalStartCommandSchema,
  wsTerminalInputCommandSchema,
  wsTerminalStopCommandSchema,
  wsRpcResponseSchema,
]);

// --- Union: Server → Client ---

/**
 * 终端输出（服务端 → 客户端）。**不是** run 事件：它属于终端会话这条独立通道，
 * 与 agent 的 streamEvent 混在一起会让按 runId 过滤的消费方误判。
 */
export const wsTerminalOutputSchema = z.object({
  type: z.literal("terminal.output"),
  sessionId: z.string().min(1),
  /** 一段输出（服务端按 ≤ 8KB 切帧，客户端拼回）。 */
  data: z.string(),
});

export const wsTerminalExitSchema = z.object({
  type: z.literal("terminal.exit"),
  sessionId: z.string().min(1),
  /** shell 自己的退出码；被杀掉时为 null。 */
  exitCode: z.number().int().nullable(),
  reason: z.string().optional(),
});

export type WsTerminalOutput = z.infer<typeof wsTerminalOutputSchema>;
export type WsTerminalExit = z.infer<typeof wsTerminalExitSchema>;

export const wsServerMessageSchema = z.discriminatedUnion("type", [
  wsServerEventSchema,
  wsRpcRequestSchema,
  wsCommandAckSchema,
  wsTerminalOutputSchema,
  wsTerminalExitSchema,
]);

// --- Type exports ---

export type WsServerEvent = z.infer<typeof wsServerEventSchema>;
export type WsRpcRequest = z.infer<typeof wsRpcRequestSchema>;
export type WsCommandAck = z.infer<typeof wsCommandAckSchema>;
export type WsRunCommand = z.infer<typeof wsRunCommandSchema>;
export type WsCancelCommand = z.infer<typeof wsCancelCommandSchema>;
export type WsResumeCommand = z.infer<typeof wsResumeCommandSchema>;
export type WsTerminalStartCommand = z.infer<
  typeof wsTerminalStartCommandSchema
>;
export type WsTerminalInputCommand = z.infer<
  typeof wsTerminalInputCommandSchema
>;
export type WsTerminalStopCommand = z.infer<typeof wsTerminalStopCommandSchema>;
export type WsCommand = z.infer<typeof wsCommandSchema>;
export type WsRpcResponse = z.infer<typeof wsRpcResponseSchema>;
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;

// --- Screenshot-specific params/result ---

export const screenshotParamsSchema = z.object({
  mode: z.enum(["full", "region", "viewport"]),
  region: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  max_dimension: z.number().default(1024),
});

export const screenshotResultSchema = z.object({
  url: z.string().min(1),
  width: z.number(),
  height: z.number(),
});

export type ScreenshotParams = z.infer<typeof screenshotParamsSchema>;
export type ScreenshotResult = z.infer<typeof screenshotResultSchema>;
