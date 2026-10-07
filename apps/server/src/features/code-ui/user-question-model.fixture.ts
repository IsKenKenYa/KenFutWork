import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";

export const toolCallId = "ask-user-question-original-call";
export const questionText = "代码与设计模式应该如何共享运行内核？";
export const selectedOption = "共享内核并分离模式";
export const optionPreview = "共享运行内核，分别注册模式提示词与工具。";
export const questions = [
  {
    question: questionText,
    header: "运行内核",
    options: [
      {
        label: selectedOption,
        description: "共享运行能力，保留独立会话与工具集合。",
        preview: optionPreview,
      },
      {
        label: "分别维护内核",
        description: "两个模式分别维护运行能力。",
      },
    ],
    multiSelect: false,
  },
];

// 只读取模型网络边界中本案需要的OpenAI字段，不替换任何自家服务。
export const modelRequestSchema = z.object({
  tools: z
    .array(z.object({ function: z.object({ name: z.string() }) }))
    .optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.unknown().optional(),
      tool_call_id: z.string().optional(),
      tool_calls: z
        .array(
          z.object({
            id: z.string(),
            function: z.object({ name: z.string(), arguments: z.string() }),
          }),
        )
        .optional(),
    }),
  ),
});

export function writeModelChunk(
  response: ServerResponse,
  requestIndex: number,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-user-input-${requestIndex}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "stop-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}

export async function userQuestionModel() {
  const requests: z.infer<typeof modelRequestSchema>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(
      modelRequestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      ),
    );
    const requestIndex = requests.length;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      connection: "close",
    });
    if (requestIndex === 1) {
      writeModelChunk(response, requestIndex, {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: toolCallId,
            type: "function",
            function: {
              name: "AskUserQuestion",
              arguments: JSON.stringify({ questions }),
            },
          },
        ],
      });
      writeModelChunk(response, requestIndex, {}, "tool_calls");
    } else {
      writeModelChunk(response, requestIndex, {
        role: "assistant",
        content: "已按你的回答继续处理。",
      });
      writeModelChunk(response, requestIndex, {}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("私有模型HTTP地址不可用");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
