"use client";

import type { StreamEvent, ToolBlock } from "@kenfutwork/shared";
import { useCallback, useEffect, useRef } from "react";
import type { Message } from "./use-chat-sessions";
import type { WebSocketHandle } from "./use-websocket";

type MessageUpdater = (
  targetSessionId: string,
  updater: (prev: Message[]) => Message[],
) => void;

type StreamConsumerOwner = "resume" | "replay" | "goal" | "send";
type StreamEventConsumer = Parameters<WebSocketHandle["onEvent"]>[0];
const consumerPriority: Record<StreamConsumerOwner, number> = {
  resume: 1,
  goal: 2,
  send: 3,
  replay: 4,
};

/**
 * Extracts the stream event handling logic into a reusable hook.
 * Used by both the main send flow and the reconnection resume flow,
 * eliminating the ~70 lines of duplicated event-handling code.
 */
export function useChatStream(
  updateSessionMessages: MessageUpdater,
  ws?: WebSocketHandle,
) {
  const consumersRef = useRef(
    new Map<
      string,
      Map<StreamConsumerOwner, { token: symbol; callback: StreamEventConsumer }>
    >(),
  );
  const subscribeTaskEvents = useCallback(
    (
      taskId: string,
      owner: StreamConsumerOwner,
      callback: StreamEventConsumer,
    ) => {
      let consumers = consumersRef.current.get(taskId);
      if (!consumers) {
        consumers = new Map();
        consumersRef.current.set(taskId, consumers);
      }
      const token = Symbol(owner);
      consumers.set(owner, { token, callback });
      return () => {
        const registered = consumersRef.current.get(taskId);
        if (registered?.get(owner)?.token !== token) return;
        registered.delete(owner);
        if (registered.size === 0) consumersRef.current.delete(taskId);
      };
    },
    [],
  );

  const onWsEvent = ws?.onEvent;
  useEffect(() => {
    if (!onWsEvent) return;
    return onWsEvent((event, seq, eventTaskId) => {
      const taskId =
        eventTaskId ?? (event.type === "run.started" ? event.sessionId : null);
      if (!taskId) return;
      const consumers = consumersRef.current.get(taskId);
      if (!consumers?.size) return;
      const selected = [...consumers.entries()].sort(
        ([ownerA], [ownerB]) =>
          consumerPriority[ownerB] - consumerPriority[ownerA],
      )[0]?.[1];
      selected?.callback(event, seq, taskId);
    });
  }, [onWsEvent]);
  /**
   * Apply a single StreamEvent to the assistant message identified by assistantId
   * in the given session. This is the single source of truth for how events
   * mutate the message list.
   *
   * Edge case handling:
   * - Empty deltas are ignored to prevent unnecessary re-renders
   * - Missing assistantId in message list is tolerated (logged, not thrown)
   * - Duplicate tool.started events for the same toolCallId are safely deduplicated
   * - Unknown event types from newer server versions are silently ignored
   */
  const applyStreamEvent = useCallback(
    (event: StreamEvent, assistantId: string, sessionId: string) => {
      if (!assistantId || !sessionId) {
        console.warn(
          "[chat-stream] applyStreamEvent called with missing ids:",
          {
            assistantId,
            sessionId,
            eventType: event.type,
          },
        );
        return;
      }

      const update = (updater: (prev: Message[]) => Message[]) =>
        updateSessionMessages(sessionId, updater);

      switch (event.type) {
        case "message.delta": {
          // Skip truly empty deltas -- they cause unnecessary re-renders
          const delta = event.delta;
          if (delta === undefined || delta === null) break;

          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              const blocks = [...m.contentBlocks];
              const last = blocks[blocks.length - 1];
              if (last && last.type === "text") {
                blocks[blocks.length - 1] = {
                  ...last,
                  text: last.text + delta,
                };
              } else {
                blocks.push({ type: "text", text: delta });
              }
              return { ...m, contentBlocks: blocks };
            }),
          );
          break;
        }

        case "thinking.delta": {
          const delta = event.delta;
          if (delta === undefined || delta === null) break;

          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              const blocks = [...m.contentBlocks];
              const last = blocks[blocks.length - 1];
              if (last && last.type === "thinking") {
                blocks[blocks.length - 1] = {
                  ...last,
                  thinking: last.thinking + delta,
                };
              } else {
                blocks.push({ type: "thinking", thinking: delta });
              }
              return { ...m, contentBlocks: blocks };
            }),
          );
          break;
        }

        case "tool.started":
          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              // Guard against duplicate tool.started events for the same toolCallId
              const alreadyExists = m.contentBlocks.some(
                (b) => b.type === "tool" && b.toolCallId === event.toolCallId,
              );
              if (alreadyExists) {
                console.warn(
                  "[chat-stream] duplicate tool.started for:",
                  event.toolCallId,
                );
                return m;
              }
              const newBlock: ToolBlock = {
                type: "tool",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                status: "running",
                ...(event.input ? { input: event.input } : {}),
              };
              return {
                ...m,
                contentBlocks: [...m.contentBlocks, newBlock],
              };
            }),
          );
          break;

        case "tool.completed":
          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              return {
                ...m,
                contentBlocks: m.contentBlocks.map((block) => {
                  if (
                    block.type === "tool" &&
                    block.toolCallId === event.toolCallId
                  ) {
                    return {
                      ...block,
                      status: "completed" as const,
                      output: event.output,
                      outputSummary: event.outputSummary,
                      ...(event.artifacts
                        ? { artifacts: event.artifacts }
                        : {}),
                    };
                  }
                  return block;
                }),
              };
            }),
          );
          break;

        case "run.failed":
          console.error("[chat-stream] run.failed:", event.error);
          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              // Mark all running tool blocks as completed so spinners stop
              const blocks = m.contentBlocks.map((block) =>
                block.type === "tool" && block.status === "running"
                  ? {
                      ...block,
                      status: "completed" as const,
                      outputSummary: "\u5904\u7406\u5931\u8d25",
                    }
                  : block,
              );
              const hasFailureReason = blocks.some(
                (block) =>
                  block.type === "text" &&
                  block.text.includes(event.error.message),
              );
              return {
                ...m,
                contentBlocks: hasFailureReason
                  ? blocks
                  : [
                      ...blocks,
                      {
                        type: "text" as const,
                        text: event.error.message,
                      },
                    ],
              };
            }),
          );
          break;

        case "run.canceled":
          update((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              const message =
                event.stopReason === "user_cancelled"
                  ? "本轮已停止。"
                  : event.stopReason === "task_stopped"
                    ? "任务已停止。"
                    : event.stopReason === "host_shutdown"
                      ? "服务重启，本轮中断。"
                      : null;
              const hasRunning = m.contentBlocks.some(
                (block) => block.type === "tool" && block.status === "running",
              );
              const hasReason =
                message &&
                m.contentBlocks.some(
                  (block) =>
                    block.type === "text" && block.text.includes(message),
                );
              if (!hasRunning && (!message || hasReason)) return m;
              return {
                ...m,
                contentBlocks: [
                  ...m.contentBlocks.map((block) =>
                    block.type === "tool" && block.status === "running"
                      ? { ...block, status: "completed" as const }
                      : block,
                  ),
                  ...(message && !hasReason
                    ? [{ type: "text" as const, text: message }]
                    : []),
                ],
              };
            }),
          );
          break;

        case "run.completed":
          if (event.stopReason === "output_limit")
            update((prev) =>
              prev.map((message) => {
                if (message.id !== assistantId) return message;
                const note = "达到输出长度上限，本轮内容可能不完整。";
                if (
                  message.contentBlocks.some(
                    (block) =>
                      block.type === "text" && block.text.includes(note),
                  )
                )
                  return message;
                return {
                  ...message,
                  contentBlocks: [
                    ...message.contentBlocks,
                    { type: "text" as const, text: note },
                  ],
                };
              }),
            );
          break;

        default:
          // Unknown event types are silently ignored -- new event types may be
          // added server-side before the frontend is updated
          break;
      }
    },
    [updateSessionMessages],
  );

  return { applyStreamEvent, subscribeTaskEvents };
}
