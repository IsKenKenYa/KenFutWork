import type { CodeGoalControlState } from "@kenfutwork/shared";
import { afterEach, expect, it, vi } from "vitest";
import { ServiceChannels } from "../../../packages/zcode-shared/dist/channels.js";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";

afterEach(() => vi.unstubAllGlobals());
function hostFixture() {
  const requests: Array<Record<string, unknown>> = [];
  const senders = new Map<string, (state: CodeGoalControlState) => void>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const host = new URL(url).host;
      if (!url.endsWith("/events")) {
        requests.push(JSON.parse(String(options.body)));
        return new Response(JSON.stringify({ result: { status: "accepted" } }));
      }
      let closed = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (value: unknown) =>
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`),
              );
            send({ event: "ready", hello: { connectionId: host } });
            senders.set(host, (data) =>
              send({
                event: "service",
                service: "zcodeAgentService",
                name: "onGoalControlState",
                data,
              }),
            );
            options.signal?.addEventListener(
              "abort",
              () => {
                if (!closed) {
                  closed = true;
                  controller.close();
                }
              },
              { once: true },
            );
          },
          cancel() {
            closed = true;
          },
        }),
      );
    }),
  );
  return {
    requests,
    async observe(
      client: CodeHttpChannelClient,
      goal: CodeGoalControlState["goal"],
      taskId = "task",
    ) {
      await client.connect();
      const channel = client.getChannel(ServiceChannels.ZCodeAgent);
      await new Promise<void>((resolve) => {
        const listener = channel.listen("onGoalControlState")(() => {
          listener.dispose();
          resolve();
        });
        senders.get(new URL(client.config.apiBase).host)!({
          taskId,
          goal,
        });
      });
    },
  };
}
function sendGoal(
  client: CodeHttpChannelClient,
  commandId: string,
  taskId = "task",
) {
  return client
    .getChannel(ServiceChannels.ZCodeAgent)
    .call("sendConversationCommandV4", [
      {
        workspacePath: "/project",
        envelope: {
          type: "sendGoalCommand",
          sessionId: taskId,
          commandId,
          clientId: "client",
          payload: { text: "目标" },
          issuedAt: 1,
        },
      },
    ]);
}

it("没有已观察Goal状态时拒绝发送，不能在发送时读取新状态自动补fence", async () => {
  const f = hostFixture();
  const client = new CodeHttpChannelClient({ apiBase: "http://left.test" });
  try {
    await expect(sendGoal(client, "missing")).rejects.toThrow(
      "目标状态尚未同步",
    );
    expect(f.requests).toEqual([]);
    await f.observe(client, null);
    await sendGoal(client, "initial");
    expect(f.requests[0]?.args).toMatchObject([
      { goalControl: { expectedGoal: null } },
    ]);
  } finally {
    client.dispose();
  }
});

it("两客户端分别携已观察fence；同命令重试保留首次fence而不重基", async () => {
  const f = hostFixture();
  const old = new CodeHttpChannelClient({ apiBase: "http://left.test" });
  const current = new CodeHttpChannelClient({ apiBase: "http://right.test" });
  try {
    await f.observe(old, { goalId: "goal", revision: 3 });
    await f.observe(current, { goalId: "goal", revision: 4 });
    await sendGoal(old, "old-request");
    await sendGoal(current, "current-request");
    expect(f.requests[0]?.args).toMatchObject([
      { goalControl: { expectedGoal: { goalId: "goal", revision: 3 } } },
    ]);
    expect(f.requests[1]?.args).toMatchObject([
      { goalControl: { expectedGoal: { goalId: "goal", revision: 4 } } },
    ]);
    await f.observe(old, { goalId: "new-goal", revision: 1 });
    await sendGoal(old, "old-request");
    await sendGoal(old, "new-request");
    expect(f.requests[2]?.args).toMatchObject([
      { goalControl: { expectedGoal: { goalId: "goal", revision: 3 } } },
    ]);
    expect(f.requests[3]?.args).toMatchObject([
      { goalControl: { expectedGoal: { goalId: "new-goal", revision: 1 } } },
    ]);
    expect(f.requests).toHaveLength(4);
  } finally {
    old.dispose();
    current.dispose();
  }
});

it("两个Task复用客户端和命令ID时分别缓存自己的Goal fence", async () => {
  const f = hostFixture();
  const client = new CodeHttpChannelClient({ apiBase: "http://left.test" });
  try {
    await f.observe(client, { goalId: "goal-a", revision: 3 }, "task-a");
    await f.observe(client, { goalId: "goal-b", revision: 7 }, "task-b");
    await sendGoal(client, "same-command", "task-a");
    await sendGoal(client, "same-command", "task-b");
    expect(f.requests[0]?.args).toMatchObject([
      {
        envelope: { sessionId: "task-a" },
        goalControl: { expectedGoal: { goalId: "goal-a", revision: 3 } },
      },
    ]);
    expect(f.requests[1]?.args).toMatchObject([
      {
        envelope: { sessionId: "task-b" },
        goalControl: { expectedGoal: { goalId: "goal-b", revision: 7 } },
      },
    ]);
    await f.observe(client, { goalId: "new-goal-a", revision: 1 }, "task-a");
    await sendGoal(client, "same-command", "task-a");
    await sendGoal(client, "same-command", "task-b");
    expect(f.requests[2]?.args).toMatchObject([
      {
        envelope: { sessionId: "task-a" },
        goalControl: { expectedGoal: { goalId: "goal-a", revision: 3 } },
      },
    ]);
    expect(f.requests[3]?.args).toMatchObject([
      {
        envelope: { sessionId: "task-b" },
        goalControl: { expectedGoal: { goalId: "goal-b", revision: 7 } },
      },
    ]);
  } finally {
    client.dispose();
  }
});
