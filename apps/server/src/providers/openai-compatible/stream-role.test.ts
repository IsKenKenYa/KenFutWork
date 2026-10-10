import { once } from "node:events";
import { createServer } from "node:http";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";
import { expect, it } from "vitest";
import { z } from "zod";
import { createInstanceChatModel } from "./index.js";

it.each(["missing", "leading-empty", "assistant"])(
  "%s role流保留分段工具调用并继续到最终答复",
  async (roleForm) => {
    const requests: Array<{
      messages: Array<{ role: string; content: unknown }>;
    }> = [];
    const observed: number[] = [];
    const server = createServer(async (request, response) => {
      const bytes: Buffer[] = [];
      for await (const chunk of request) bytes.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(bytes).toString()));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta: unknown, finishReason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({
            id: `reply-${requests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "test",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      if (roleForm === "leading-empty") frame({});
      const role = roleForm === "missing" ? {} : { role: "assistant" };
      if (requests.length === 1) {
        frame({
          ...role,
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "observe", arguments: '{"value":' },
            },
          ],
        });
        frame({ tool_calls: [{ index: 0, function: { arguments: "7}" } }] });
        frame({}, "tool_calls");
      } else {
        frame({ ...role, content: "已重新观察" });
        frame({}, "stop");
      }
      response.write(
        `data: ${JSON.stringify({ id: "usage", object: "chat.completion.chunk", created: 1, model: "test", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("模型HTTP夹具未就绪");
      const model = createInstanceChatModel("test", {
        apiKey: "fixture",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        useResponsesApi: false,
        invocationMaxRetries: 0,
      });
      const schema = z.object({ value: z.number() });
      const agent = createAgent({
        model,
        tools: [
          tool(
            (input) => {
              const { value } = schema.parse(input);
              observed.push(value);
              return "观察完成";
            },
            { name: "observe", schema },
          ),
        ],
      });
      const result = await agent.invoke({
        messages: [{ role: "user", content: "请观察" }],
      });
      expect(observed).toEqual([7]);
      expect(requests).toHaveLength(2);
      expect(
        requests[1]?.messages.some(
          (message) =>
            message.role === "tool" && message.content === "观察完成",
        ),
      ).toBe(true);
      const final = result.messages.at(-1);
      if (!AIMessage.isInstance(final))
        throw new Error("Agent未得到最终AI答复");
      expect(final.content).toBe("已重新观察");
      expect(final).toMatchObject({ usage_metadata: { total_tokens: 15 } });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
