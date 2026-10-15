import { randomUUID } from "node:crypto";
import type {
  IPlatformService,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { PlatformProvider } from "@zui/hooks/usePlatform.js";
import { useDraftSessionPrewarm } from "@zui/v4/composer/useDraftSessionPrewarm.js";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(cleanup);
type CommandAck = protocol.CommandAck;
type CommandType = protocol.CommandType;
type ConversationWorkContext = protocol.ConversationWorkContext;
const ack = (): CommandAck => ({
  commandId: randomUUID(),
  status: "accepted",
  revisionAtDecision: 0,
  result: { type: "createSession", sessionId: randomUUID() },
});

it("Design-only项目预热冻结当前platform方式，正确传递明确项目身份", async () => {
  const projectId = randomUUID();
  const workspaceKey = JSON.stringify([projectId, "/fixed/task-root"]);
  const context: ConversationWorkContext = { preset: "design" };
  const resolve = vi.fn(() => context);
  const platform = {
    getConversationWorkContext: resolve,
  } as unknown as IPlatformService;
  const dispatch = vi.fn(
    async (
      _type: CommandType,
      payload: Record<string, unknown>,
    ): Promise<CommandAck> => {
      if (
        (payload.workContext as ConversationWorkContext | undefined)?.preset !==
        "design"
      )
        throw new Error("项目未启用Code");
      return ack();
    },
  );
  const view = renderHook(
    () =>
      useDraftSessionPrewarm({
        enabled: true,
        workspaceKey,
        paneId: "shared-session",
        transportIdentity: platform,
        dispatchCommand: dispatch,
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <PlatformProvider platform={platform}>{children}</PlatformProvider>
      ),
    },
  );
  await waitFor(() =>
    expect(view.result.current.binding?.sessionId).toEqual(expect.any(String)),
  );
  expect(resolve).toHaveBeenCalledWith({
    workspacePath: "/fixed/task-root",
    workspaceIdentity: workspaceKey,
  });
  expect(dispatch).toHaveBeenCalledWith(
    "createSession",
    { workspaceId: workspaceKey, workContext: { preset: "design" } },
    null,
  );
  view.result.current.binding!.promote();
});

it("预热创建在ACK前切方式/画布不改已经发出的冻结上下文，不重复创建", async () => {
  const projectId = randomUUID();
  const originalCanvas = randomUUID();
  let context: ConversationWorkContext = {
    preset: "design",
    canvasId: originalCanvas,
    selectedCanvasElements: [{ id: "selected" }],
  };
  const platform = {
    getConversationWorkContext: () => context,
  } as unknown as IPlatformService;
  let release!: (value: CommandAck) => void;
  const pending = new Promise<CommandAck>((resolve) => {
    release = resolve;
  });
  const dispatch = vi.fn(
    (_type: CommandType, _payload: Record<string, unknown>) => pending,
  );
  const view = renderHook(
    () =>
      useDraftSessionPrewarm({
        enabled: true,
        workspaceKey: JSON.stringify([projectId, "/fixed/task-root"]),
        paneId: "shared-session",
        transportIdentity: platform,
        dispatchCommand: dispatch,
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <PlatformProvider platform={platform}>{children}</PlatformProvider>
      ),
    },
  );
  try {
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    context.canvasId = randomUUID();
    context.selectedCanvasElements![0]!.id = "changed";
    context = { preset: "code" };
    view.rerender();
    expect(dispatch.mock.calls[0]?.[1].workContext).toEqual({
      preset: "design",
      canvasId: originalCanvas,
      selectedCanvasElements: [{ id: "selected" }],
    });
    release(ack());
    await waitFor(() =>
      expect(view.result.current.binding?.sessionId).toEqual(
        expect.any(String),
      ),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    view.result.current.binding!.promote();
  } finally {
    release(ack());
  }
});
