import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export async function heldModel() {
  const requests: Array<{ closed: boolean }> = [];
  let firstRequestReceived!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    firstRequestReceived = resolve;
  });
  const server = createServer((request, response) => {
    request.resume();
    const entry = { closed: false };
    requests.push(entry);
    firstRequestReceived();
    response.on("close", () => {
      entry.closed = true;
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-${requests.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "stop-model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: `正在运行 ${requests.length}`,
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    // 外部模型夹具保留流，只有真实取消才会关闭；无工具/外部模型请求。
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    firstRequest,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
