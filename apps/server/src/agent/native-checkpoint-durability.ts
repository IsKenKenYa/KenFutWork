import type { RunnableConfig } from "@langchain/core/runnables";
import type { createDeepAgent } from "deepagents";

/**
 * 公共持久化语义：每个superstep先确认checkpoint再推进。
 * 固定SDK async模式延后join拒绝的tracked Promise；sync保留原失败并立即join。
 * 代价是每步等待一次存储，不把SDK durability配置暴露到产品接口。
 */
export function attachNativeCheckpointDurability(
  agent: ReturnType<typeof createDeepAgent>,
): void {
  const originalEvents = agent.streamEvents.bind(agent);
  const streamEvents = (...args: Parameters<typeof agent.streamEvents>) => {
    const config = args[1] as RunnableConfig | undefined;
    const forwarded: Parameters<typeof agent.streamEvents> = [...args];
    forwarded[1] = { ...config, durability: "sync" } as (typeof args)[1];
    return originalEvents(...forwarded);
  };
  const originalStream = agent.stream.bind(agent);
  const stream = (...args: Parameters<typeof agent.stream>) => {
    const config = args[1] as RunnableConfig | undefined;
    const forwarded: Parameters<typeof agent.stream> = [...args];
    forwarded[1] = { ...config, durability: "sync" } as (typeof args)[1];
    return originalStream(...forwarded);
  };
  // SDK重载仍由原方法负责；包装不创建额外async/adopting Promise。
  agent.streamEvents = streamEvents as typeof agent.streamEvents;
  agent.stream = stream as typeof agent.stream;
}
