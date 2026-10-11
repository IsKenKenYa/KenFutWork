/** 仅替代外部模型HTTP服务；记录真正ChatOpenAI请求，不替换Harness/工具/OS。 */

import { once } from "node:events";
import { createServer } from "node:http";
import { CU_TOOL_PREFIX } from "../tools.js";

export async function createDesktopModelServer(
  pid: number,
  options: {
    beforeResponse?(stage: number): Promise<void>;
    screenshotRecovery?: boolean;
    omitRole?: boolean;
  } = {},
) {
  const requests: Record<string, unknown>[] = [];
  let inputIndex: number | undefined;
  const names = [
    "ToolSearch",
    "request_access",
    "get_app_state",
    "screenshot",
    ...(options.screenshotRecovery ? ["screenshot"] : []),
    "type",
    "get_app_state",
  ];
  const textOf = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(textOf).join("\n");
    if (value && typeof value === "object" && "text" in value)
      return String(value.text);
    return "";
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        unknown
      >;
      const stage = requests.length;
      requests.push(body);
      await options.beforeResponse?.(stage);
      const messages = body.messages as Array<{
        tool_call_id?: string;
        content: unknown;
      }>;
      const state = messages.find(
        (message) => message.tool_call_id === "desktop-model-2",
      );
      if (state)
        inputIndex = Number(
          textOf(state.content).match(/\[(\d+)\] textfield 验收输入/)?.[1],
        );
      const shortName = names[stage];
      const name = stage === 0 ? shortName : `${CU_TOOL_PREFIX}${shortName}`;
      const args =
        stage === 0
          ? { query: CU_TOOL_PREFIX }
          : shortName === "type"
            ? {
                app: { pid },
                text: "Task中文🙂🚀",
                target: { type: "element", index: inputIndex },
              }
            : {
                app: {
                  pid:
                    options.screenshotRecovery && stage === 3
                      ? 2_147_483_647
                      : pid,
                },
              };
      const role = options.omitRole ? {} : { role: "assistant" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: `desktop-response-${stage}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "desktop-fixture",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      response.write(
        chunk(
          shortName
            ? {
                ...role,
                tool_calls: [
                  {
                    index: 0,
                    id: `desktop-model-${stage}`,
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              }
            : { ...role, content: "macOS Task验收完成" },
          null,
        ),
      );
      response.write(chunk({}, shortName ? "tool_calls" : "stop"));
      response.end("data: [DONE]\n\n");
    } catch {
      response.writeHead(500);
      response.end("外部模型验收服务无法解析请求");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("模型HTTP夹具未监听");
  return {
    requests,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
