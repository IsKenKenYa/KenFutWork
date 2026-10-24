// @vitest-environment node
import { fileURLToPath } from "node:url";
import {
  type ExecutionMode,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { act, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import type { heldModel } from "../../server/src/features/code-ui/model-stream.fixture.js";
import {
  type OriginalSessionView,
  type PublicFixture,
  renderOriginalSession,
} from "./setup/code-public-session";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type SentInput = {
  executionMode?: ExecutionMode;
  envelope: protocol.CommandEnvelope;
};

const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
let releaseDom: (() => void) | undefined;
afterEach(() => {
  cleanup();
  releaseDom?.();
  releaseDom = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferredResponse() {
  let reject!: (error: Error) => void;
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function observeStrategyRequests(
  fixture: PublicFixture,
  host: Host,
  planPut: ReturnType<typeof deferredResponse>,
) {
  const token = await fixture.app.kernel.get("localAccess").getDesktopToken();
  const sent: SentInput[] = [];
  const nativeFetch = globalThis.fetch;
  let held = false;
  let started = false;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.origin !== fixture.baseUrl) return nativeFetch(input, init);
      if (
        url.pathname === "/api/code-ui/rpc" &&
        typeof init?.body === "string"
      ) {
        const request = JSON.parse(init.body) as {
          method?: string;
          args?: SentInput[];
        };
        const command = request.args?.[0];
        if (
          request.method === "sendConversationCommandV4" &&
          command?.envelope.type === "sendText"
        )
          sent.push(command);
      }
      if (!url.pathname.startsWith("/api/execution-modes"))
        return nativeFetch(input, init);
      // 只适配网络边界：真实surface接口使用与原CodeHttpChannel相同的桌面授权。
      const headers = new Headers(init?.headers);
      if (!headers.has("cookie") && !headers.has("authorization"))
        headers.set("authorization", `Bearer ${token}`);
      if (
        held &&
        url.pathname === `/api/execution-modes/${host.sessionId}` &&
        init?.method === "PUT" &&
        JSON.parse(String(init.body)).mode === "plan"
      ) {
        held = false;
        started = true;
        return planPut.promise;
      }
      return nativeFetch(input, { ...init, headers });
    });
  return {
    sent,
    holdPlanPut: () => {
      held = true;
    },
    planPutStarted: () => started,
    dispose: () => fetchSpy.mockRestore(),
  };
}

function seedTextDraft(host: Host) {
  // 仅提供真实已存正文；原Composer自行恢复草稿，不替换组件回调或发送函数。
  const identity = JSON.stringify([host.projectId, host.workspacePath]);
  localStorage.setItem(
    `zcode-v4-composer-drafts:v1:${encodeURIComponent(identity)}`,
    JSON.stringify({
      version: 1,
      scopes: {
        [host.sessionId]: {
          text: "PLAN_CLOSE_THROUGH_ORIGINAL_COMPOSER",
          updatedAt: Date.now(),
        },
      },
    }),
  );
}

async function waitForComposer(session: OriginalSessionView) {
  await waitFor(
    () => {
      expect(
        session.view.getByTestId("chat-mode-select-trigger").textContent,
      ).toContain("自主");
      expect(
        session.view.getByTestId("v4-composer-input").textContent,
      ).toContain("PLAN_CLOSE_THROUGH_ORIGINAL_COMPOSER");
      expect(
        session.view.getByTestId("v4-composer-send").hasAttribute("disabled"),
      ).toBe(false);
    },
    { timeout: 30_000 },
  );
}

async function withOriginalComposer(
  initialPlanning: boolean,
  run: (f: {
    host: Host;
    model: Model;
    session: OriginalSessionView;
    sent: SentInput[];
    planPut: ReturnType<typeof deferredResponse>;
    holdPlanPut(): void;
    planPutStarted(): boolean;
  }) => Promise<void>,
) {
  const httpLoading: Promise<{
    createCodeUiHttpFixture(): Promise<PublicFixture>;
  }> = import(fixturePath);
  const [http, sessions, streams, surface] = await Promise.all([
    httpLoading,
    import("../../server/src/features/code-ui/host-session.fixture.js"),
    import("../../server/src/features/code-ui/model-stream.fixture.js"),
    import("../src/components/workbench/zcode/host/surfaceApi.js"),
  ]);
  const fixture = await http.createCodeUiHttpFixture();
  const model = await streams.heldModel();
  const planPut = deferredResponse();
  let host: Host | undefined;
  let session: OriginalSessionView | undefined;
  let releaseFetch: (() => void) | undefined;
  try {
    host = await sessions.createCodeSessionFixture(model.baseUrl, {
      client: fixture.client,
      initialConfig: { mode: "yolo", planEnabled: initialPlanning },
    });
    const currentHost = host;
    expect(
      (
        await host.client.request(
          `/api/execution-modes/${host.sessionId}`,
          { mode: "agent" },
          "PUT",
        )
      ).status,
    ).toBe(200);
    const boundary = await observeStrategyRequests(fixture, host, planPut);
    releaseFetch = boundary.dispose;
    surface.setSurfaceApiBase(fixture.baseUrl);
    session = await renderOriginalSession(fixture, host, () =>
      seedTextDraft(currentHost),
    );
    releaseDom = session.releaseDom;
    await waitForComposer(session);
    await run({
      host,
      model,
      session,
      sent: boundary.sent,
      planPut,
      holdPlanPut: boundary.holdPlanPut,
      planPutStarted: boundary.planPutStarted,
    });
  } finally {
    // 准备或交互断言失败时也释放已截留的网络边界。
    planPut.resolve(Response.json({ mode: "plan" }));
    session?.dispose();
    releaseFetch?.();
    surface.setSurfaceApiBase("");
    if (host) await host.dispose();
    await model.close();
    await fixture.close();
  }
}

async function assertOriginalSend(f: {
  host: Host;
  model: Model;
  session: OriginalSessionView;
  sent: SentInput[];
}) {
  const user = userEvent.setup({ document });
  await user.click(f.session.view.getByTestId("v4-composer-send"));
  await vi.waitFor(() => expect(f.model.requests).toHaveLength(1), {
    timeout: 30_000,
  });
  expect.soft(f.sent).toHaveLength(1);
  expect.soft(f.sent[0]).toMatchObject({
    executionMode: "agent",
    envelope: {
      sessionId: f.host.sessionId,
      type: "sendText",
      payload: { mode: "yolo", planEnabled: false },
    },
  });
  const snapshot = protocol.conversationSnapshotSchema.parse(
    await f.host.snapshot(),
  );
  expect
    .soft(snapshot.config)
    .toMatchObject({ mode: "yolo", planEnabled: false });
  const messages = f.model.requests[0]!.body.messages as Array<{
    role: string;
    content: string;
  }>;
  const input = messages
    .filter((message) => message.role === "user")
    .at(-1)?.content;
  expect.soft(input).toContain("PLAN_CLOSE_THROUGH_ORIGINAL_COMPOSER");
  expect.soft(input).not.toContain('<execution_mode name="plan">');
  expect
    .soft(f.session.view.queryByTestId("v4-composer-plan-marker"))
    .toBeNull();
  expect
    .soft(f.session.view.getByTestId("chat-mode-select-trigger").textContent)
    .toContain("自主");
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原SessionPane执行策略与明确关闭规划 integration",
  () => {
    it("旧计划PUT失败不得覆盖期间实际Plan标记X关闭的规划与后续输入", async () => {
      await withOriginalComposer(false, async (f) => {
        const user = userEvent.setup({ document });
        f.holdPlanPut();
        await user.click(
          f.session.view.getByTestId("chat-mode-select-trigger"),
        );
        await user.click(
          await f.session.view.findByRole("menuitemradio", {
            name: "计划",
          }),
        );
        await waitFor(() => expect(f.planPutStarted()).toBe(true));
        await user.click(
          f.session.view.getByRole("button", {
            name: /^关闭计划模式$/,
          }),
        );
        await waitFor(() =>
          expect(
            f.session.view.queryByTestId("v4-composer-plan-marker"),
          ).toBeNull(),
        );
        await act(async () =>
          f.planPut.reject(new Error("旧策略偏好请求失败")),
        );
        await waitFor(() =>
          expect(
            f.session.view.getByTestId("chat-mode-select-trigger").textContent,
          ).toContain("自主"),
        );
        expect
          .soft(f.session.view.queryByTestId("v4-composer-plan-marker"))
          .toBeNull();
        await assertOriginalSend(f);
      });
    }, 120_000);

    it("策略plan保存成功后实际Plan标记X退出策略，原发送冻结关闭规划且保留基础权限", async () => {
      await withOriginalComposer(false, async (f) => {
        const user = userEvent.setup({ document });
        await user.click(
          f.session.view.getByTestId("chat-mode-select-trigger"),
        );
        await user.click(
          await f.session.view.findByRole("menuitemradio", {
            name: "计划",
          }),
        );
        await waitFor(() => {
          const chip = f.session.view.getByTestId("chat-mode-select-trigger");
          expect(chip.textContent).toContain("计划");
          expect(chip.getAttribute("data-execution-mode-saving")).toBe("false");
        });
        const persisted = await f.host.client.request(
          `/api/execution-modes/${f.host.sessionId}`,
        );
        expect(
          persisted.status,
          JSON.stringify({
            status: persisted.status,
            error: persisted.body.error?.code,
            keys: Object.keys(persisted.body),
          }),
        ).toBe(200);
        expect(persisted.body.mode).toBe("plan");
        await user.click(
          f.session.view.getByRole("button", {
            name: /^关闭计划模式$/,
          }),
        );
        await waitFor(() =>
          expect(
            f.session.view.queryByTestId("v4-composer-plan-marker"),
          ).toBeNull(),
        );
        // Soft assertions deliberately keep the original send path running on
        // the old implementation, so its real Run config is also observed.
        expect
          .soft(
            f.session.view.getByTestId("chat-mode-select-trigger").textContent,
          )
          .toContain("自主");
        await assertOriginalSend(f);
      });
    }, 120_000);
  },
);
