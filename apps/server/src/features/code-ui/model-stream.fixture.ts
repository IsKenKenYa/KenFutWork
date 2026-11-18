import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export async function heldModel(
  options: {
    initialTool?: {
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    toolsByRequest?: Record<
      number,
      { id: string; name: string; arguments: Record<string, unknown> }
    >;
    usage?: { promptTokens: number; completionTokens: number };
  } = {},
) {
  const requests: Array<{ closed: boolean; body: Record<string, unknown> }> =
    [];
  const responses: ServerResponse[] = [];
  const writeUsage = (response: ServerResponse, index: number) => {
    if (!options.usage) return;
    response.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-${index + 1}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "stop-model",
        choices: [],
        usage: {
          prompt_tokens: options.usage.promptTokens,
          completion_tokens: options.usage.completionTokens,
          total_tokens:
            options.usage.promptTokens + options.usage.completionTokens,
        },
      })}\n\n`,
    );
  };
  let firstRequestReceived!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    firstRequestReceived = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    const entry = { closed: false, body };
    requests.push(entry);
    responses.push(response);
    firstRequestReceived();
    response.on("close", () => {
      entry.closed = true;
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const tool =
      options.toolsByRequest?.[requests.length - 1] ??
      (requests.length === 1 ? options.initialTool : undefined);
    if (tool) {
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
                tool_calls: [
                  {
                    index: 0,
                    id: tool.id,
                    type: "function",
                    function: {
                      name: tool.name,
                      arguments: JSON.stringify(tool.arguments),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "stop-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
      );
      writeUsage(response, requests.length - 1);
      response.end("data: [DONE]\n\n");
      return;
    }
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
    // 默认保留外部模型流；只有真实取消或显式finish才关闭，无工具调用。
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    firstRequest,
    writeText(index: number, text: string) {
      const response = responses[index];
      if (!response || response.destroyed || response.writableEnded)
        throw new Error("指定外部模型流不可写。");
      response.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${index + 1}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "stop-model",
          choices: [
            { index: 0, delta: { content: text }, finish_reason: null },
          ],
        })}\n\n`,
      );
    },
    // index与requests一致，从0开始；旧消费者不调用时仍永久保留流。
    finish(index: number) {
      const response = responses[index];
      if (!response || response.destroyed || response.writableEnded)
        throw new Error("指定的模型流尚未打开或已经结束。");
      response.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${index + 1}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "stop-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      writeUsage(response, index);
      response.end("data: [DONE]\n\n");
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
