import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { ChainValues } from "@langchain/core/utils/types";
import { expect, it } from "vitest";
import { heldModel } from "../../features/code-ui/model-stream.fixture.js";
import { createInstanceChatModel } from "./index.js";

it.each([true, false])(
  "直接 invoke 使用原生流聚合，供应商上报用量=%s 时不引入估算计量",
  async (reportsUsage) => {
    const provider = await heldModel(
      reportsUsage ? { usage: { promptTokens: 31, completionTokens: 4 } } : {},
    );
    const output: Array<ChainValues | undefined> = [];
    const callback = BaseCallbackHandler.fromMethods({
      handleLLMEnd(result) {
        output.push(result.llmOutput);
      },
    });
    callback.awaitHandlers = true;
    const model = createInstanceChatModel("stream-invocation-model", {
      apiKey: "fixture-key",
      baseUrl: provider.baseUrl,
      useResponsesApi: false,
      invocationMaxRetries: 0,
    });
    const controller = new AbortController();
    try {
      const pending = model.invoke(
        [new SystemMessage("检查完整输入"), new HumanMessage("回答")],
        { callbacks: [callback], signal: controller.signal },
      );
      await Promise.race([provider.firstRequest, pending]);
      provider.finish(0);
      const response = await pending;
      if (!AIMessage.isInstance(response))
        throw new Error("模型没有返回助手消息");
      expect(response.content).toBe("正在运行 1");
      expect(response.response_metadata.finish_reason).toBe("stop");
      expect(output).toEqual(
        reportsUsage
          ? [
              {
                tokenUsage: {
                  promptTokens: 31,
                  completionTokens: 4,
                  totalTokens: 35,
                },
              },
            ]
          : [undefined],
      );
      expect(provider.requests).toHaveLength(1);
      expect(response.usage_metadata).toEqual(
        reportsUsage
          ? {
              input_tokens: 31,
              output_tokens: 4,
              total_tokens: 35,
              input_token_details: {},
              output_token_details: {},
            }
          : undefined,
      );
    } finally {
      controller.abort();
      await provider.close();
    }
  },
);
