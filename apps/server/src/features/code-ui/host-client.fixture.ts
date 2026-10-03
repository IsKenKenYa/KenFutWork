import { expect } from "vitest";

const base = process.env.CODE_UI_TEST_BASE ?? "http://127.0.0.1:3001";
const origin = process.env.CODE_UI_TEST_ORIGIN ?? "http://localhost:3000";

export async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin,
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

export async function openCodeStream(streams: AbortController[]) {
  const controller = new AbortController();
  streams.push(controller);
  const response = await fetch(`${base}/api/code-ui/events`, {
    headers: { origin },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
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
  return { next, rpc, controller, ready };
}
