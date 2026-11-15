// @vitest-environment node
import { randomUUID } from "node:crypto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { InspectionCall } from "../src/components/workbench/zcode/host/contextInspectionReader.js";
import { useContextInspection } from "../src/components/workbench/zcode/host/useContextInspection.js";
import { installCodePublicHostDom } from "./setup/code-public-host-dom.js";

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "刷新已翻到的旧请求，保留选择并读到真实终态",
  async () => {
    const { createTaskWorkDatabase } = await import(
      "../../server/src/features/task-work/test-postgres-schema.js"
    );
    const { createContextInspectionService } = await import(
      "../../server/src/features/context-insights/service.js"
    );
    const db = await createTaskWorkDatabase();
    const taskId = db.context.scope.taskId;
    const owner = { instanceId: db.instanceId, taskId, runId: randomUUID() };
    const context = createContextInspectionService({
      persistence: db.persistence,
      localInstance: db.localInstance,
      readPageCharacters: async () => 128,
    });
    const start = async (label: string) => {
      const id = randomUUID();
      await context.writer.start({
        id,
        owner,
        startedAt: new Date().toISOString(),
        input: {
          messages: [[{ type: "human", data: { content: label } }]],
          model: "local",
          tools: [],
        },
      });
      return id;
    };
    let holdReply: Promise<void> | undefined;
    let onHold: (() => void) | undefined;
    const call: InspectionCall = async (method, args) => {
      if (method === "read") return context.read(db.actor, args?.[0]);
      const pending = holdReply;
      holdReply = undefined;
      const page = await context.list(db.actor, args?.[0]);
      if (pending) {
        onHold?.();
        await pending;
      }
      return page;
    };
    const releaseDom = await installCodePublicHostDom();
    try {
      await start("更早请求一");
      await start("更早请求二");
      const oldest = await start("旧请求");
      for (let i = 0; i < 99; i++) await start(`请求 ${i + 4}`);
      const hook = renderHook(({ task }) => useContextInspection(call, task), {
        initialProps: { task: taskId },
      });
      try {
        await waitFor(() =>
          expect(hook.result.current.requests).toHaveLength(50),
        );
        await act(async () => hook.result.current.loadMore());
        act(() => hook.result.current.select(oldest));
        await waitFor(() =>
          expect(hook.result.current.content?.output).toBe("null"),
        );
        await context.writer.finish({
          id: oldest,
          owner,
          endedAt: new Date().toISOString(),
          status: "completed",
          output: [{ type: "ai", data: { content: "真实终态响应" } }],
          usage: { inputTokens: 9, outputTokens: 4 },
        });
        const newest = await start("刷新期间的新请求");
        await act(async () => hook.result.current.refresh());
        expect(hook.result.current.requests[0]?.id).toBe(newest);
        expect(hook.result.current.requests).toHaveLength(101);
        expect(hook.result.current.nextBefore).toBe(
          hook.result.current.selected?.sequence,
        );
        expect(hook.result.current.selected).toMatchObject({
          id: oldest,
          status: "completed",
        });
        await waitFor(() =>
          expect(hook.result.current.content?.output).toContain("真实终态响应"),
        );
        expect(
          hook.result.current.inspected.find(
            (item) => item.summary.id === oldest,
          )?.summary.usage,
        ).toEqual({ inputTokens: 9, outputTokens: 4 });
        await act(async () => hook.result.current.loadMore());
        expect(
          new Set(hook.result.current.requests.map(({ id }) => id)).size,
        ).toBe(103);
        expect(hook.result.current.nextBefore).toBeNull();

        let release!: () => void;
        holdReply = new Promise<void>((resolve) => {
          release = resolve;
        });
        const held = new Promise<void>((resolve) => {
          onHold = resolve;
        });
        let late!: Promise<void>;
        act(() => {
          late = hook.result.current.refresh();
        });
        await held;
        hook.rerender({ task: randomUUID() });
        expect(hook.result.current.requests).toEqual([]);
        expect(hook.result.current.content).toBeNull();
        await waitFor(() =>
          expect(hook.result.current.error).toContain("请求列表读取失败"),
        );
        await act(async () => {
          release();
          await late;
        });
        expect(hook.result.current.requests).toEqual([]);
        expect(hook.result.current.content).toBeNull();
      } finally {
        hook.unmount();
      }
    } finally {
      releaseDom();
      await db.close();
    }
  },
  60_000,
);
