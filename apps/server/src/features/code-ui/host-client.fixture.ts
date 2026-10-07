import { expect } from "vitest";

export function createCodeUiTestClient(input: {
  baseUrl: string;
  origin: string;
  headers?: Readonly<Record<string, string>>;
}) {
  const base = new URL(input.baseUrl).toString().replace(/\/$/u, "");
  const origin = new URL(input.origin).origin;
  const ownedStreams = new Set<AbortController>();
  const streamClosures = new Set<Promise<void>>();

  async function request(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        connection: "close",
        origin,
        ...input.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body:
        response.status === 204
          ? {}
          : ((await response.json()) as Record<string, any>),
    };
  }

  async function openCodeStream(streams: AbortController[] = []) {
    const controller = new AbortController();
    streams.push(controller);
    ownedStreams.add(controller);
    const response = await fetch(`${base}/api/code-ui/events`, {
      headers: { origin, connection: "close", ...input.headers },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const closeReader = async () => {
      try {
        await reader.cancel();
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        reader.releaseLock();
      }
    };
    const closed = new Promise<void>((resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          void closeReader().then(resolve, reject);
        },
        { once: true },
      );
    });
    void closed.catch(() => {});
    streamClosures.add(closed);
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) {
        const part = await reader.read();
        if (part.done) throw new Error("Code 通道提前关闭");
        buffer += decoder.decode(part.value, { stream: true });
      }
      const boundary = buffer.indexOf("\n\n");
      const record = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      return JSON.parse(record.slice("data: ".length));
    };
    const ready = await next();
    const rpc = (method: string, args: unknown[] = []) =>
      request("/api/code-ui/rpc", {
        connectionId: ready.hello.connectionId,
        service: "zcodeAgentService",
        method,
        args,
      });
    expect(ready.hello).toMatchObject({
      kind: "hello",
      protocolVersion: 3,
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
    });
    return { next, rpc, controller, ready, closed };
  }

  return {
    request,
    openCodeStream,
    async close() {
      for (const controller of ownedStreams) controller.abort();
      await Promise.all(streamClosures);
      ownedStreams.clear();
      streamClosures.clear();
    },
  };
}
export type CodeUiTestClient = ReturnType<typeof createCodeUiTestClient>;

/** 公共 SSE 多路服务帧按原 channel/事件身份选取，不能把其它服务通知当成本场景帧。 */
export async function nextHostServiceEvent(
  stream: Awaited<ReturnType<CodeUiTestClient["openCodeStream"]>>,
  service: string,
  name: string,
  scope?: { workspacePath?: string; taskId?: string },
) {
  for (;;) {
    const event = await stream.next();
    if (
      event.event === "service" &&
      event.service === service &&
      event.name === name &&
      (!scope?.workspacePath || event.workspacePath === scope.workspacePath) &&
      (!scope?.taskId || event.data?.taskId === scope.taskId)
    )
      return event;
  }
}
