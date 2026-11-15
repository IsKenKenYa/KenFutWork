import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { expect, it } from "vitest";
import {
  consumeRetryEvents,
  modelRetryFixture,
  retryHistory,
} from "./model-retry-counts.fixture.js";

it.each([1, 2])(
  "Agent 总尝试次数 %s 与实际请求和观察身份一致",
  async (maxAttempts) => {
    const f = await modelRetryFixture([0]);
    try {
      const agent = await f.agent(maxAttempts, "agent");
      const result = await f.drive(
        consumeRetryEvents(
          agent.streamEvents(
            {
              messages: [new HumanMessage("验证请求次数")],
            },
            f.threadConfig,
          ),
        ),
      );
      expect(result.status).toBe(maxAttempts === 1 ? "rejected" : "fulfilled");
      expect(f.provider.requests).toHaveLength(maxAttempts);
      expect(f.starts.map((item) => item.purpose)).toEqual(
        Array(maxAttempts).fill("agent"),
      );
      expect(new Set(f.starts.map((item) => item.id)).size).toBe(maxAttempts);
      expect(f.errors).toEqual([f.starts[0]?.id]);
      expect(f.ends).toEqual(maxAttempts === 1 ? [] : [f.starts[1]?.id]);
    } finally {
      await f.close();
    }
  },
);

it("普通请求重试不重复执行已经成功的自动摘要", async () => {
  const f = await modelRetryFixture([1]);
  try {
    const agent = await f.agent(2, "automatic");
    const result = await f.drive(
      consumeRetryEvents(
        agent.streamEvents({ messages: retryHistory() }, f.threadConfig),
      ),
    );
    expect(result.status).toBe("fulfilled");
    expect(f.provider.requests).toHaveLength(3);
    expect(f.starts.map((item) => item.purpose)).toEqual([
      "automatic-compaction",
      "agent",
      "agent",
    ]);
    expect(f.errors).toEqual([f.starts[1]?.id]);
  } finally {
    await f.close();
  }
});

it("未安装模型观察者时自动摘要仍消费相同重试设置", async () => {
  const f = await modelRetryFixture([0]);
  try {
    const agent = await f.agent(2, "automatic", false);
    const result = await f.drive(
      consumeRetryEvents(
        agent.streamEvents({ messages: retryHistory() }, f.threadConfig),
      ),
    );
    expect(result.status).toBe("fulfilled");
    expect(f.provider.requests).toHaveLength(3);
    expect(f.starts).toEqual([]);
  } finally {
    await f.close();
  }
});

it("包装后的配额错误不触发普通请求重试", async () => {
  const f = await modelRetryFixture([0], {
    status: 429,
    code: "insufficient_quota",
  });
  try {
    const agent = await f.agent(3, "agent");
    const result = await f.drive(
      consumeRetryEvents(
        agent.streamEvents(
          { messages: [new HumanMessage("检查配额")] },
          f.threadConfig,
        ),
      ),
    );
    expect(result.status).toBe("rejected");
    expect(f.provider.requests).toHaveLength(1);
    expect(f.errors).toEqual([f.starts[0]?.id]);
  } finally {
    await f.close();
  }
});

it("独立评估的用量发布失败不重新请求模型", async () => {
  const f = await modelRetryFixture([]);
  try {
    const missing = join(tmpdir(), randomUUID(), "network-usage.json");
    const result = await f.drive(
      f.port(2, async () => {
        await writeFile(missing, "receipt");
      })({ ...f.request, purpose: "goal-evaluation" }),
    );
    expect(result.status).toBe("rejected");
    expect(result).toMatchObject({ reason: { code: "ENOENT" } });
    expect(f.provider.requests).toHaveLength(1);
    expect(f.usage.take(f.runId)).toMatchObject([
      { inputTokens: 31, outputTokens: 4 },
    ]);
  } finally {
    await f.close();
  }
});

it("独立评估重试前重新验证冻结的供应商修订", async () => {
  const f = await modelRetryFixture([0]);
  f.onRequest((index) => {
    if (index === 0) f.reviseProvider();
  });
  try {
    const result = await f.drive(
      f.port(3)({ ...f.request, purpose: "goal-evaluation" }),
    );
    expect(result.status).toBe("rejected");
    expect(result).toMatchObject({
      reason: { message: expect.stringContaining("配置已改变") },
    });
    expect(f.provider.requests).toHaveLength(1);
    expect(f.published).toEqual([]);
  } finally {
    await f.close();
  }
});

it("取消一项独立评估后同 Run 的另一用途仍可请求", async () => {
  const f = await modelRetryFixture([0]);
  const caller = new AbortController();
  f.onRequest((index) => {
    if (index === 0) caller.abort();
  });
  try {
    const first = await f.drive(
      f.port(3)({
        ...f.request,
        purpose: "goal-evaluation",
        signal: caller.signal,
      }),
    );
    expect(first.status).toBe("rejected");
    expect(f.signal.aborted).toBe(false);
    const second = await f.drive(
      f.port(2)({ ...f.request, purpose: "approval-review" }),
    );
    expect(second.status).toBe("fulfilled");
    expect(f.provider.requests).toHaveLength(2);
    expect(f.starts.map((item) => item.purpose)).toEqual([
      "goal-evaluation",
      "approval-review",
    ]);
  } finally {
    await f.close();
  }
});

it.each(
  (["goal-evaluation", "approval-review"] as const).flatMap((purpose) =>
    [1, 2].map((maxAttempts) => ({ purpose, maxAttempts })),
  ),
)(
  "$purpose 总尝试次数 $maxAttempts 与实际请求和用量一致",
  async ({ purpose, maxAttempts }) => {
    const f = await modelRetryFixture([0]);
    try {
      const result = await f.drive(
        f.port(maxAttempts)({ ...f.request, purpose }),
      );
      expect(result.status).toBe(maxAttempts === 1 ? "rejected" : "fulfilled");
      expect(f.provider.requests).toHaveLength(maxAttempts);
      expect(f.starts.map((item) => item.purpose)).toEqual(
        Array(maxAttempts).fill(purpose),
      );
      expect(new Set(f.starts.map((item) => item.id)).size).toBe(maxAttempts);
      expect(f.errors).toEqual([f.starts[0]?.id]);
      expect(f.ends).toEqual(maxAttempts === 1 ? [] : [f.starts[1]?.id]);
      expect(f.published).toHaveLength(maxAttempts === 1 ? 0 : 1);
      if (maxAttempts === 2)
        expect(f.usage.take(f.runId)).toMatchObject([
          { inputTokens: 31, outputTokens: 4 },
        ]);
    } finally {
      await f.close();
    }
  },
);

it.each([1, 2])(
  "自动摘要总尝试次数 %s 独立于后续 Agent 请求",
  async (maxAttempts) => {
    const f = await modelRetryFixture([0]);
    try {
      const agent = await f.agent(maxAttempts, "automatic");
      const result = await f.drive(
        consumeRetryEvents(
          agent.streamEvents({ messages: retryHistory() }, f.threadConfig),
        ),
      );
      expect(result.status).toBe(maxAttempts === 1 ? "rejected" : "fulfilled");
      expect(f.provider.requests).toHaveLength(maxAttempts === 1 ? 1 : 3);
      expect(f.starts.map((item) => item.purpose)).toEqual(
        maxAttempts === 1
          ? ["automatic-compaction"]
          : ["automatic-compaction", "automatic-compaction", "agent"],
      );
      expect(f.errors).toEqual([f.starts[0]?.id]);
    } finally {
      await f.close();
    }
  },
);

it.each([1, 2])(
  "手动摘要总尝试次数 %s 与 checkpoint 提交结果一致",
  async (maxAttempts) => {
    const f = await modelRetryFixture([1]);
    try {
      const agent = await f.agent(maxAttempts, "manual");
      expect(
        (
          await f.drive(
            consumeRetryEvents(
              agent.streamEvents({ messages: retryHistory() }, f.threadConfig),
            ),
          )
        ).status,
      ).toBe("fulfilled");
      if (!agent.contextHistory) throw new Error("缺少原生历史接口");
      const before = await agent.contextHistory.captureCurrentReference(
        f.threadConfig.configurable.thread_id,
      );
      const result = await f.drive(
        agent.contextHistory.compactCurrent({
          threadId: f.threadConfig.configurable.thread_id,
          signal: f.signal,
        }),
      );
      expect(result.status).toBe(maxAttempts === 1 ? "rejected" : "fulfilled");
      expect(f.provider.requests).toHaveLength(maxAttempts + 1);
      expect(f.starts.map((item) => item.purpose)).toEqual([
        "agent",
        ...Array(maxAttempts).fill("manual-compaction"),
      ]);
      expect(f.errors).toEqual([f.starts[1]?.id]);
      if (maxAttempts === 1)
        expect(
          await agent.contextHistory.captureCurrentReference(
            f.threadConfig.configurable.thread_id,
          ),
        ).toEqual(before);
      else expect(result).toMatchObject({ value: { status: "applied" } });
    } finally {
      await f.close();
    }
  },
);
