import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { vi } from "vitest";

type Emit = (index: number, data: unknown) => void;
interface Rpc {
  method: string;
  connectionId: string;
  args: Array<{ topic: string }>;
}

// 外部 HTTP/SSE 替身，原代理、registry、缓存与 Hook 全部使用真实实现。
function controllerSnapshot(
  topic: string,
  index: number,
  subscriptionId: string,
) {
  const frame = {
    topic,
    subscriptionId,
    logEpoch: `epoch-${index}`,
    fromSeq: 0,
    toSeq: 0,
    sentAt: 1,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        logEpoch: `epoch-${index}`,
        ...(topic === "controller/tasks-index"
          ? { tasks: [] }
          : { workspaces: [] }),
      },
    },
  };
  return topic === "controller/tasks-index"
    ? protocol.windowHostControllerTaskFrameSchema.parse(frame)
    : protocol.windowHostControllerWorkspaceFrameSchema.parse(frame);
}

function helloResponse(index: number) {
  return Response.json({
    result: protocol.helloMessageSchema.parse({
      kind: "hello",
      protocolVersion: 3,
      connectionId: `connection-${index}`,
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
      serverTime: 1,
      auth: {},
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
    }),
  });
}
function sessionsIndexResponse(index: number, emit: Emit) {
  const encoder = new TextEncoder();
  const subscriptionId = `sessions-${index}`;
  const topic = protocol.sessionsIndexTopic("/项目");
  for (const frame of protocol.encodeTopicWireFrames(
    {
      topic,
      subscriptionId,
      fromSeq: 0,
      toSeq: 0,
      sentAt: 1,
      payload: {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          workspaceId: "/项目",
          logEpoch: "index-epoch",
          sessions: [],
        },
      },
    },
    {
      deliveryKind: "initial",
      topic,
      subscriptionId,
      logicalFrameId: subscriptionId,
      logicalFrameOrdinal: 1,
      measurePhysicalFrameBytes: (frame) =>
        encoder.encode(JSON.stringify(frame)).byteLength,
    },
  ))
    emit(index - 1, {
      event: "onDynamicSessionsIndexFrame",
      workspacePath: "/项目",
      frame,
    });
  return Response.json({
    result: {
      ack: { subscriptionId, logEpoch: "index-epoch", mode: "snapshot" },
    },
  });
}
function rpcResponse(
  request: Rpc,
  index: number,
  emit: Emit,
  leases: string[],
) {
  if (request.method === "subscribeControllerV4") {
    const { topic } = protocol.controllerSubscribeParamsSchema.parse(
      request.args[0],
    );
    const id = `${request.connectionId}-${topic}`;
    leases.push(id);
    emit(index - 1, {
      event: "service",
      service: "window-controller",
      name: "onDynamicControllerFrame",
      data: controllerSnapshot(topic, index, id),
    });
    return Response.json({
      result: {
        ack: {
          subscriptionId: id,
          logEpoch: `epoch-${index}`,
          mode: "snapshot",
        },
      },
    });
  }
  if (request.method === "helloConversationV4") return helloResponse(index);
  if (request.method === "subscribeSessionsIndexV4")
    return sessionsIndexResponse(index, emit);
  if (request.method === "listTasks")
    return Response.json({
      result: (index === 1
        ? ["连接前任务"]
        : ["连接前任务", "断线期间新任务"]
      ).map((title) => ({
        taskId: title,
        title,
        workspacePath: "/项目",
        createdAt: 1,
        updatedAt: 1,
      })),
    });
  if (["listPinnedTasks", "listArchivedTasks"].includes(request.method))
    return Response.json({ result: [] });
  if (["listPinnedTaskIds", "listDeletedTaskIds"].includes(request.method))
    return Response.json({ result: [] });
  if (request.method === "listTaskList")
    return Response.json({
      result: {
        items: [
          ["连接前任务"],
          ["连接前任务", "断线期间新任务"],
          ["连接前任务", "断线期间新任务", "第二次断线新任务"],
        ][index - 1]?.map((title) => ({
          taskId: title,
          title,
          workspacePath: "/项目",
          createdAt: 1,
          updatedAt: 1,
          sourceAvailability: "online",
          liveStatus: "idle",
        })),
        total: index,
        hasMore: false,
      },
    });
  return Response.json({
    result: request.method === "getView" ? { revision: index } : null,
  });
}

export function createControllerHttpFixture() {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const encoder = new TextEncoder();
  const streamAt = (index: number) => {
    const stream = streams[index];
    if (!stream) throw new Error("测试通知连接尚未创建");
    return stream;
  };
  const emit = (index: number, data: unknown) =>
    streamAt(index).enqueue(
      encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
    );
  const leases: string[] = [];
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (url.endsWith("/events"))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
            emit(streams.length - 1, {
              event: "ready",
              hello: { connectionId: `connection-${streams.length}` },
              reconnectDelayMs: 100,
            });
          },
        }),
      );
    const request: Rpc = JSON.parse(String(options?.body));
    return rpcResponse(request, streams.length, emit, leases);
  });
  return { leases, disconnect: (index: number) => streamAt(index).close() };
}
