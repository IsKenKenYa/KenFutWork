import type { StreamEvent } from "@kenfutwork/shared";
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Message } from "../src/hooks/use-chat-sessions";
import { useChatStream } from "../src/hooks/use-chat-stream";
import type { WebSocketHandle } from "../src/hooks/use-websocket";

it("preserves the server's readable run failure reason", () => {
  let messages: Message[] = [
    {
      id: "assistant",
      role: "assistant",
      contentBlocks: [{ type: "text", text: "已完成第一步。" }],
    },
  ];
  const { result } = renderHook(() =>
    useChatStream((_sessionId, update) => {
      messages = update(messages);
    }),
  );

  act(() => {
    result.current.applyStreamEvent(
      {
        type: "run.failed",
        runId: "00000000-0000-4000-8000-000000000001",
        error: {
          code: "run_failed",
          message: "设计任务权限已变化，请重新加载",
        },
        timestamp: "2026-10-11T00:00:00.000Z",
      },
      "assistant",
      "task",
    );
  });

  expect(messages[0]?.contentBlocks).toContainEqual({
    type: "text",
    text: "设计任务权限已变化，请重新加载",
  });
});

it("dispatches one Task event to the highest-priority run consumer", () => {
  const messages: Message[] = [
    { id: "assistant", role: "assistant", contentBlocks: [] },
  ];
  let dispatch: Parameters<WebSocketHandle["onEvent"]>[0] | undefined;
  const ws = {
    onEvent: vi.fn((callback: Parameters<WebSocketHandle["onEvent"]>[0]) => {
      dispatch = callback;
      return () => {};
    }),
  } as unknown as WebSocketHandle;
  const { result } = renderHook(() =>
    useChatStream((_taskId, update) => {
      messages.splice(0, messages.length, ...update(messages));
    }, ws),
  );
  const resumeConsumer = vi.fn(
    (event: StreamEvent, _seq?: number, taskId?: string) =>
      result.current.applyStreamEvent(event, "assistant", taskId ?? ""),
  );
  const sendConsumer = vi.fn(
    (event: StreamEvent, _seq?: number, taskId?: string) =>
      result.current.applyStreamEvent(event, "assistant", taskId ?? ""),
  );
  const unsubscribeResume = result.current.subscribeTaskEvents(
    "task",
    "resume",
    resumeConsumer,
  );
  const goalConsumer = vi.fn(
    (event: StreamEvent, _seq?: number, taskId?: string) =>
      result.current.applyStreamEvent(event, "assistant", taskId ?? ""),
  );
  const unsubscribeGoal = result.current.subscribeTaskEvents(
    "task",
    "goal",
    goalConsumer,
  );
  const unsubscribeSend = result.current.subscribeTaskEvents(
    "task",
    "send",
    sendConsumer,
  );

  act(() => {
    dispatch?.(
      {
        type: "message.delta",
        runId: "00000000-0000-4000-8000-000000000002",
        messageId: "assistant",
        delta: "wrong-task",
        timestamp: "2026-10-11T00:00:00.000Z",
      },
      1,
      "task-other",
    );
  });
  expect(sendConsumer).not.toHaveBeenCalled();
  expect(goalConsumer).not.toHaveBeenCalled();

  act(() => {
    dispatch?.(
      {
        type: "message.delta",
        runId: "00000000-0000-4000-8000-000000000001",
        messageId: "assistant",
        delta: "token",
        timestamp: "2026-10-11T00:00:00.000Z",
      },
      1,
      "task",
    );
  });

  expect(ws.onEvent).toHaveBeenCalledOnce();
  expect(resumeConsumer).not.toHaveBeenCalled();
  expect(sendConsumer).toHaveBeenCalledOnce();
  expect(messages[0]?.contentBlocks).toEqual([{ type: "text", text: "token" }]);
  expect(goalConsumer).not.toHaveBeenCalled();
  unsubscribeSend();
  act(() => {
    dispatch?.(
      {
        type: "message.delta",
        runId: "00000000-0000-4000-8000-000000000001",
        messageId: "assistant",
        delta: "goal-token",
        timestamp: "2026-10-11T00:00:01.000Z",
      },
      2,
      "task",
    );
  });
  expect(goalConsumer).toHaveBeenCalledOnce();
  expect(resumeConsumer).not.toHaveBeenCalled();
  expect(messages[0]?.contentBlocks).toEqual([
    { type: "text", text: "tokengoal-token" },
  ]);
  unsubscribeGoal();
  unsubscribeResume();
});

it("renders the platform stop reason without exposing provider details", () => {
  let messages: Message[] = [
    {
      id: "assistant",
      role: "assistant",
      contentBlocks: [
        {
          type: "tool",
          toolCallId: "tool-1",
          toolName: "render",
          status: "running",
        },
      ],
    },
  ];
  const { result } = renderHook(() =>
    useChatStream((_taskId, update) => {
      messages = update(messages);
    }),
  );

  act(() => {
    result.current.applyStreamEvent(
      {
        type: "run.canceled",
        runId: "00000000-0000-4000-8000-000000000001",
        stopReason: "host_shutdown",
        timestamp: "2026-10-11T00:00:00.000Z",
      },
      "assistant",
      "task",
    );
  });

  expect(messages[0]?.contentBlocks).toContainEqual({
    type: "text",
    text: "服务重启，本轮中断。",
  });
  expect(messages[0]?.contentBlocks).toContainEqual(
    expect.objectContaining({ type: "tool", status: "completed" }),
  );
});
