/**
 * 最小复现：deepagents createDeepAgent + MemorySaver 两轮记忆。
 * 用法（apps/server 目录下）：
 *   REPRO_API_KEY=... pnpm exec tsx test-repro/repro.ts
 */

async function main() {
  const baseUrl = process.env.REPRO_BASE_URL ?? "https://matchfit.top/v1";
  const apiKey = process.env.REPRO_API_KEY ?? "";
  const modelId = process.env.REPRO_MODEL ?? "glm-5.3-flash";
  if (!apiKey) {
    console.error("需要 REPRO_API_KEY");
    process.exit(1);
  }

  const { ChatOpenAI } = await import("@langchain/openai");
  const { MemorySaver } = await import("@langchain/langgraph");
  const { HumanMessage } = await import("@langchain/core/messages");
  const deepagents = await import("deepagents");

  const model = new ChatOpenAI({
    model: modelId,
    configuration: { baseURL: baseUrl, apiKey },
    apiKey,
    temperature: 0,
  });

  const checkpointer = new MemorySaver();
  const storeVariant = process.env.REPRO_WITH_STORE === "1";
  const store = storeVariant
    ? new (await import("@langchain/langgraph-checkpoint")).InMemoryStore()
    : undefined;
  console.log("[变体] withStore =", storeVariant);
  const graph = deepagents.createDeepAgent({
    model,
    checkpointer,
    ...(store ? { store } : {}),
    systemPrompt: "你是记忆测试助手。严格按用户要求执行。",
  });

  const thread = { configurable: { thread_id: "repro-thread-1" } };

  const r1 = await graph.invoke(
    { messages: [new HumanMessage("记住数字 42。只回复：已记住")] },
    { ...thread },
  );
  console.log(
    "[R1 最后回复]",
    r1.messages[r1.messages.length - 1]?.content?.toString().slice(0, 80),
  );
  console.log("[R1 消息总数]", r1.messages.length);

  const r2 = await graph.invoke(
    { messages: [new HumanMessage("我让你记住的数字是多少？只输出数字")] },
    { ...thread },
  );
  const last = r2.messages[r2.messages.length - 1]?.content?.toString();
  console.log("[R2 消息总数]", r2.messages.length);
  console.log("[R2 最后回复]", last?.slice(0, 120));
  console.log(
    "[结论]",
    last?.includes("42") ? "上下文延续成功" : "上下文未延续",
  );
}

main().catch((e) => {
  console.error("repro failed:", e?.message ?? e);
  process.exit(1);
});
