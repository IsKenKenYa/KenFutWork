import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { createSummarizationMiddleware } from "deepagents";
import { createAgent } from "langchain";
import { describe, expect, it } from "vitest";

import { resolveCompactionPlan } from "./auto-compact.js";

/**
 * 自动压缩的**真实机制**验证（不是替身）：用 deepagents 的 summarization middleware +
 * 我们 `resolveCompactionPlan` 算出的阈值，跑一个真 agent（`langchain` 的 createAgent），
 * 断言三件事：
 * 1. 上下文没过线 → 中间件**什么都不做**（模型收到的还是原样历史）；
 * 2. 过线 → 下一次模型调用的输入里出现摘要消息（`lc_source="summarization"`），
 *    且旧消息被 offload 到 `/conversation_history/`；
 * 3. **状态里的历史不被改写**（转录保持完整——这是我们对用户的承诺）。
 *
 * 这条必须真的跑一遍：`trigger: {type:"tokens"}` 在没有模型 profile 的模型上会不会
 * 静默失效，光看类型签名看不出来。
 */

/** 记录每次调用收到的消息（= 模型真正看到的上下文），并返回一句固定的回复。 */
class RecordingChatModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = [];
  constructor() {
    super({});
  }
  _llmType(): string {
    return "recording";
  }
  /** langchain 的 createAgent 要求模型可绑定工具；这条测试没有工具，绑到自己即可。 */
  bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.seen.push(messages);
    return {
      generations: [{ text: "收到", message: new AIMessage("收到") }],
    };
  }
}

/**
 * 极简 backend 替身：中间件把它当**工厂**调用（`(config) => StateBackend`），
 * offload 时调 `write(path, content)`。用真方法名（不是万能 Proxy）——
 * 上一版用 Proxy 冒充工厂，结果 middleware 把工厂的返回值当 backend，
 * 报出 `backend.write is not a function`，offload 静默失败。
 */
function backendStub(record: string[]) {
  const backend = {
    write: async (path: string, content: string) => {
      record.push(path);
      void content;
      return { path, ok: true };
    },
    read: async () => null,
    edit: async () => ({ ok: true }),
    ls: async () => [],
    glob: async () => [],
    grep: async () => [],
    uploadFiles: async () => ({ ok: true }),
  };
  return (() => backend) as never;
}

/** 造 n 条长消息（近似 token 数 = 字符数 / 4，见依赖里的 countTokensApproximately）。 */
function longHistory(count: number, charsEach: number): BaseMessage[] {
  const filler = "x".repeat(charsEach);
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? new HumanMessage(`第 ${index} 条：${filler}`)
      : new AIMessage(`第 ${index} 条回复：${filler}`),
  );
}

async function runWith(
  plan: ReturnType<typeof resolveCompactionPlan>,
  history: BaseMessage[],
) {
  const model = new RecordingChatModel();
  const offloads: string[] = [];
  const agent = createAgent({
    model,
    tools: [],
    middleware: [
      createSummarizationMiddleware({
        backend: backendStub(offloads) as never,
        trigger: plan.trigger,
        keep: plan.keep,
      }),
    ],
  });
  const result = (await agent.invoke({
    messages: [new SystemMessage("系统提示"), ...history],
  })) as { messages: BaseMessage[] };
  return { model, offloads, result };
}

describe("自动压缩机制（deepagents summarization middleware）", () => {
  // 触发线压到 4000（= MIN_TRIGGER_TOKENS），保留 20 条
  const plan = resolveCompactionPlan({
    contextWindow: 1_000_000,
    maxOutputTokens: 996_000,
  });

  it("阈值口径先钉住：这份 plan 是 4000 tokens / 保留 20 条", () => {
    expect(plan.trigger).toEqual({ type: "tokens", value: 4_000 });
    expect(plan.keep).toEqual({ type: "messages", value: 20 });
  });

  it("没过线：不摘要（模型看到的就是原样历史），也不 offload", async () => {
    const { model, offloads, result } = await runWith(plan, longHistory(4, 40));
    const summarized = model.seen.some((messages) =>
      messages.some(
        (message) =>
          (message.additional_kwargs as { lc_source?: string } | undefined)
            ?.lc_source === "summarization",
      ),
    );
    expect(summarized).toBe(false);
    expect(offloads).toEqual([]);
    // 状态里的历史完整
    expect(result.messages.length).toBeGreaterThanOrEqual(5);
  });

  it("过线：下一次调用带摘要消息、旧消息被 offload，但**状态里的历史保持完整**", async () => {
    // 30 条 × 800 字符 ≈ 6000 tokens（> 4000 触发线），且超过保留条数才有可压的部分
    const history = longHistory(30, 800);
    const { model, offloads, result } = await runWith(plan, history);

    // 摘要调用 + 正式调用：至少有一次调用看到了摘要消息
    const summarySeen = model.seen.some((messages) =>
      messages.some(
        (message) =>
          (message.additional_kwargs as { lc_source?: string } | undefined)
            ?.lc_source === "summarization",
      ),
    );
    expect(summarySeen).toBe(true);

    // 旧消息被存到工作区的 /conversation_history/（offload）
    expect(offloads.some((path) => path.includes("conversation_history"))).toBe(
      true,
    );

    // 状态（= 用户转录）不被改写：原先那 30 条仍在
    const humanCount = result.messages.filter((message) =>
      HumanMessage.isInstance(message),
    ).length;
    expect(humanCount).toBeGreaterThanOrEqual(15);
  }, 20_000);
});

/**
 * 装配接线验证：`createKenFutWorkDeepAgent` 拿到压缩口径时**真的把中间件挂上**，
 * 没给时**一个都不挂**（设置里关掉的效果就是这条）。
 *
 * 上面那条只证明「框架的中间件按我们的数字干活」，这条证明「我们的装配真的用了它」——
 * 两者缺一，功能都可能只是看起来存在。
 */
describe("自动压缩的装配接线", () => {
  async function buildAgent(autoCompact?: ReturnType<typeof resolveCompactionPlan>) {
    const { createKenFutWorkDeepAgent } = await import("./deep-agent.js");
    const { loadServerEnv } = await import("../config/env.js");
    const { createAgentBackend } = await import("./backends/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const env = loadServerEnv({
      agentBackendMode: "filesystem",
      agentFilesRoot: mkdtempSync(join(tmpdir(), "kfw-compact-")),
    });
    const backendResult = createAgentBackend(env, "canvas-compact-test");
    const model = new RecordingChatModel();
    const agent = createKenFutWorkDeepAgent({
      backendResult,
      blob: {
        bucket: () => ({
          upload: async () => {},
          resolveUrl: async () => "https://blob.test/x",
          getPublicUrl: () => "https://blob.test/x",
        }),
      } as never,
      env,
      model: model as never,
      ...(autoCompact ? { autoCompact } : {}),
    });
    return { agent, model };
  }

  const plan = resolveCompactionPlan({
    contextWindow: 1_000_000,
    maxOutputTokens: 996_000,
  });

  it("给了口径：长历史触发压缩，模型看到摘要消息", async () => {
    const { agent, model } = await buildAgent(plan);
    await agent.invoke({ messages: longHistory(30, 900) }, { configurable: { thread_id: "t-compact" } });
    const sawSummary = model.seen.some((messages) =>
      messages.some(
        (message) =>
          (message.additional_kwargs as { lc_source?: string } | undefined)
            ?.lc_source === "summarization",
      ),
    );
    expect(sawSummary).toBe(true);
  }, 30_000);

  it("没给口径（设置里关掉）：不挂中间件，长历史也不压缩", async () => {
    const { agent, model } = await buildAgent();
    await agent.invoke({ messages: longHistory(30, 900) }, { configurable: { thread_id: "t-nocompact" } });
    const sawSummary = model.seen.some((messages) =>
      messages.some(
        (message) =>
          (message.additional_kwargs as { lc_source?: string } | undefined)
            ?.lc_source === "summarization",
      ),
    );
    expect(sawSummary).toBe(false);
  }, 30_000);
});
