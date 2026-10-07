// @vitest-environment node
import { fileURLToPath } from "node:url";
import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeUiTestClient } from "../../server/src/features/code-ui/host-client.fixture.js";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import { installCodePublicHostDom } from "./setup/code-public-host-dom";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type PublicFixture = { client: CodeUiTestClient; close(): Promise<void> };
// Node服务装配由Vitest加载；Web编译只消费公开测试边界，避免Next环境类型进入服务端模块。
const httpFixtureModule = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
const historyFixtureModule = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/history-fork.fixture.ts",
    import.meta.url,
  ),
);
type HttpModule = { createCodeUiHttpFixture(): Promise<PublicFixture> };
type HistoryModule = {
  snapshot(
    fixture: PublicFixture,
    taskId: string,
  ): Promise<protocol.ConversationSnapshot>;
  waitPhase(
    fixture: PublicFixture,
    taskId: string,
    phase: string,
  ): Promise<protocol.ConversationSnapshot>;
};

let releaseDom: (() => void) | undefined;

afterEach(() => {
  cleanup();
  releaseDom?.();
  releaseDom = undefined;
  vi.unstubAllGlobals();
});

async function loadOriginalUi() {
  releaseDom = await installCodePublicHostDom();
  const [intl, tooltip, panel, trigger, status] = await Promise.all([
    import("@zui/i18n/IntlProvider"),
    import("@zui/components/ui/tooltip"),
    import("@zui/v4/ConversationStatusPanel"),
    import("@zui/v4/composer/ConversationBackgroundWorkTrigger"),
    import("@zui/v4/conversationStatusPanelModel"),
  ]);
  return {
    ZCodeIntlProvider: intl.ZCodeIntlProvider,
    TooltipProvider: tooltip.TooltipProvider,
    ConversationStatusPanel: panel.ConversationStatusPanel,
    ConversationBackgroundWorkTrigger:
      trigger.ConversationBackgroundWorkTrigger,
    buildConversationStatusPanelModel: status.buildConversationStatusPanelModel,
  };
}

function originalControls(
  ui: Awaited<ReturnType<typeof loadOriginalUi>>,
  current: protocol.ConversationSnapshot,
  host: Host,
  onCancel: (workId: string) => void,
  onOpen: () => void,
) {
  const {
    ZCodeIntlProvider,
    TooltipProvider,
    ConversationStatusPanel,
    ConversationBackgroundWorkTrigger,
    buildConversationStatusPanelModel,
  } = ui;
  const model = buildConversationStatusPanelModel({
    backgroundWorks: current.backgroundWorks,
    runningSubagents: current.subagents?.running ?? [],
  });
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <ConversationStatusPanel
          workspacePath={host.workspacePath}
          rootSessionId={host.sessionId}
          parentSessionId={host.sessionId}
          backgroundWorks={current.backgroundWorks}
          runningSubagents={current.subagents?.running ?? []}
          endedSubagentCount={current.subagents?.endedTotal ?? 0}
          summaryPanelVariantOverride="panel"
          agentSectionOpen
          onCancelBackgroundWork={onCancel}
          onOpenSubagentSession={onOpen}
        />
        <ConversationBackgroundWorkTrigger
          backgroundWorks={current.backgroundWorks}
          runningSubagentCount={model.runningSubagentWorks.length}
          onOpen={onOpen}
        />
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

function assertUniqueOriginalControl(
  ui: Awaited<ReturnType<typeof loadOriginalUi>>,
  view: ReturnType<typeof render>,
  current: protocol.ConversationSnapshot,
  workId: string,
  childSessionId: string,
) {
  const model = ui.buildConversationStatusPanelModel({
    backgroundWorks: current.backgroundWorks,
    runningSubagents: current.subagents?.running ?? [],
  });
  expect(model.runningBashWorks).toEqual([]);
  expect(model.runningSubagentWorks).toMatchObject([
    { childSessionId, controlWorkId: workId, cancellable: true },
  ]);
  expect(model.runningSubagentWorks).toHaveLength(1);
  expect(view.getAllByTestId(`v4-background-work-item-${workId}`)).toHaveLength(
    1,
  );
  expect(
    view.getAllByTestId(`v4-background-work-cancel-${workId}`),
  ).toHaveLength(1);
  expect(
    view.getAllByRole("button", { name: "停止运行中的后台任务" }),
  ).toHaveLength(1);
  const panel = view.getByTestId("chat-summary-panel");
  expect(panel.getAttribute("data-running-agent-count")).toBe("1");
  expect(panel.getAttribute("data-running-terminal-count")).toBe("0");
  expect(panel.getAttribute("data-running-background-count")).toBe("1");
  const trigger = view.getByTestId("v4-composer-background-work-trigger");
  expect(trigger.getAttribute("data-background-subagent-count")).toBe("1");
  expect(trigger.getAttribute("data-background-total-count")).toBe("1");
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原前台子独立Stop GUI公开接线 integration",
  () => {
    it("真实snapshot只显示一个子Stop，原按钮只关闭子模型，父在同一Run继续并自然完成", async () => {
      // 默认 skipped 不加载服务端装配，启用时复用真实 HTTP/SSE 与独占 PG。
      const httpLoading: Promise<HttpModule> = import(httpFixtureModule);
      const historyLoading: Promise<HistoryModule> = import(
        historyFixtureModule
      );
      const [http, sessions, streams, history] = await Promise.all([
        httpLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
        import("../../server/src/features/code-ui/model-stream.fixture.js"),
        historyLoading,
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      let host: Host | undefined;
      let model: Awaited<ReturnType<typeof streams.heldModel>> | undefined;
      try {
        model = await streams.heldModel({
          initialTool: {
            id: "foreground-widget-child",
            name: "Task",
            arguments: {
              subagent_type: "explore",
              description: "FOREGROUND_WIDGET_CHILD",
              ownership: ["."],
              completion_criteria: "返回调研证据",
              run_in_background: false,
            },
          },
        });
        const externalModel = model;
        host = await sessions.createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const currentHost = host;
        const sent = await host.command("sendText", {
          text: "PARENT_WAIT_FOREGROUND_WIDGET_CHILD",
        });
        expect(sent.body.result.status).toBe("accepted");
        await vi.waitFor(() => expect(externalModel.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        const parent = await history.snapshot(fixture, host.sessionId);
        const child = parent.subagents?.running[0];
        if (!child) throw new Error("真实前台子身份缺失。");
        const control = parent.backgroundWorks.find(
          (work) =>
            work.kind === "subagent" &&
            work.childSessionId === child.childSessionId,
        );
        if (!control) throw new Error("真实前台子Stop控制缺失。");
        const parentExecution = parent.control.activeWorks.find(
          (work) => work.kind === "primaryTurn",
        )?.foregroundExecutionId;
        if (!parentExecution) throw new Error("真实父Run标识缺失。");
        const cancellations: Array<{
          workId: string;
          reply: ReturnType<Host["command"]>;
        }> = [];
        const cancel = (workId: string) => {
          cancellations.push({
            workId,
            reply: currentHost.command("cancelBackgroundWork", { workId }),
          });
        };
        const open = vi.fn();
        const ui = await loadOriginalUi();
        const view = render(originalControls(ui, parent, host, cancel, open));
        assertUniqueOriginalControl(
          ui,
          view,
          parent,
          control.workId,
          child.childSessionId,
        );
        fireEvent.click(
          view.getByTestId(`v4-background-work-cancel-${control.workId}`),
        );
        expect(cancellations.map((call) => call.workId)).toEqual([
          control.workId,
        ]);
        expect(open).not.toHaveBeenCalled();
        const request = cancellations[0];
        if (!request) throw new Error("原Stop未发出宿主命令。");
        const stopped = await request.reply;
        expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
        expect(stopped.body.result.status).toBe("accepted");
        await vi.waitFor(
          () => expect(externalModel.requests[1]?.closed).toBe(true),
          {
            timeout: 30_000,
          },
        );
        await vi.waitFor(() => expect(externalModel.requests).toHaveLength(3), {
          timeout: 30_000,
        });
        const waiting = await history.snapshot(fixture, host.sessionId);
        expect(waiting.control.phase).toBe("running");
        expect(waiting.control.activeWorks).toContainEqual(
          expect.objectContaining({ foregroundExecutionId: parentExecution }),
        );
        expect(waiting.backgroundWorks).toEqual([]);
        expect(waiting.subagents?.running).toEqual([]);
        expect(
          waiting.rows.window.find(
            (row) =>
              row.kind === "subagent" &&
              row.childSessionId === child.childSessionId,
          ),
        ).toMatchObject({ status: "cancelled" });
        expect(
          (await history.snapshot(fixture, child.childSessionId)).control.phase,
        ).toBe("completedInterrupted");
        view.rerender(originalControls(ui, waiting, host, cancel, open));
        expect(
          view.queryByTestId(`v4-background-work-cancel-${control.workId}`),
        ).toBeNull();
        expect(
          view.queryByTestId("v4-composer-background-work-trigger"),
        ).toBeNull();
        expect(externalModel.requests[2]?.closed).toBe(false);
        externalModel.finish(2);
        const completed = await history.waitPhase(
          fixture,
          host.sessionId,
          "completedSuccess",
        );
        expect(completed.backgroundWorks).toEqual([]);
        expect(externalModel.requests).toHaveLength(3);
        view.rerender(originalControls(ui, completed, host, cancel, open));
        expect(
          view.queryByRole("button", { name: "停止运行中的后台任务" }),
        ).toBeNull();
      } finally {
        cleanup();
        try {
          await host?.dispose();
        } finally {
          try {
            await model?.close();
          } finally {
            await fixture.close();
          }
        }
      }
    }, 120_000);
  },
);
