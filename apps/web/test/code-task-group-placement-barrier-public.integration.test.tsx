// @vitest-environment node
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clickOn,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import type { OriginalSessionBrowser } from "./setup/code-public-browser.fixture.mjs";
import {
  clickExactText,
  selectAll,
} from "./setup/code-public-browser-actions.js";
import {
  createGroupFromUi,
  dismissGroupSetup,
  readGroups,
  readScope,
  type TaskGroupPublicPageContext,
  withTaskGroupPublicPage,
} from "./setup/code-task-groups-public.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';
const sendSelector = '[data-testid="v4-composer-send"]';
type CommandResponse = {
  networkId: string;
  envelope: protocol.CommandEnvelope;
};
type HeldResponse = CommandResponse & { requestId: string; status: number };

function conversationCommand(request: unknown) {
  const postData = z
    .object({ postData: z.string().optional() })
    .parse(request).postData;
  if (!postData) return null;
  const rpc = z
    .object({
      service: z.string(),
      method: z.string(),
      args: z.array(z.unknown()),
    })
    .parse(JSON.parse(postData));
  if (
    rpc.service !== "zcodeAgentService" ||
    rpc.method !== "sendConversationCommandV4"
  )
    return null;
  return z
    .object({ envelope: protocol.commandEnvelopeSchema })
    .parse(rpc.args[0]).envelope;
}

async function readCommandAck(page: OriginalSessionBrowser, networkId: string) {
  const response = z
    .object({
      body: z.string(),
      base64Encoded: z.boolean().optional(),
    })
    .parse(
      await page.cdp.send(
        "Network.getResponseBody",
        { requestId: networkId },
        page.target.sessionId,
      ),
    );
  const body = JSON.parse(
    response.base64Encoded
      ? Buffer.from(response.body, "base64").toString("utf8")
      : response.body,
  );
  return protocol.commandAckSchema.parse(
    z.object({ result: z.unknown() }).parse(body).result,
  );
}

/** 仅延迟原配置命令的真实响应，状态码、参数及响应字节原样继续。 */
async function withHeldFollowupResponse(
  page: OriginalSessionBrowser,
  run: (pending: {
    waitForConfig(): Promise<protocol.CommandEnvelope>;
    release(): Promise<protocol.CommandAck>;
    commands(): readonly CommandResponse[];
    waitForInput(): Promise<{
      envelope: protocol.CommandEnvelope;
      ack: protocol.CommandAck;
    }>;
  }) => Promise<void>,
) {
  let held: HeldResponse | undefined;
  let released = false;
  const commands: CommandResponse[] = [];
  const completed = new Set<string>();
  const failures: unknown[] = [];
  const continuations: Promise<unknown>[] = [];
  const continueResponse = (requestId: string) => {
    const operation = page.cdp.send(
      "Fetch.continueResponse",
      { requestId },
      page.target.sessionId,
    );
    continuations.push(operation);
    void operation.catch((error: unknown) => failures.push(error));
    return operation;
  };
  const offPaused = page.cdp.on("Fetch.requestPaused", (params, sessionId) => {
    if (
      sessionId !== page.target.sessionId ||
      typeof params.requestId !== "string"
    )
      return;
    try {
      const envelope = conversationCommand(params.request);
      if (envelope && typeof params.networkId === "string") {
        const response = { networkId: params.networkId, envelope };
        commands.push(response);
        if (
          !held &&
          envelope.type === "setFollowupMode" &&
          params.responseStatusCode === 200
        ) {
          held = {
            ...response,
            requestId: params.requestId,
            status: params.responseStatusCode,
          };
          return;
        }
      }
    } catch (error) {
      failures.push(error);
    }
    void continueResponse(params.requestId);
  });
  const offCompleted = page.cdp.on(
    "Network.loadingFinished",
    (params, sessionId) => {
      if (
        sessionId === page.target.sessionId &&
        typeof params.requestId === "string"
      )
        completed.add(params.requestId);
    },
  );
  const waitForConfig = async () => {
    await vi.waitFor(
      () => {
        expect(failures).toEqual([]);
        expect(held?.status).toBe(200);
      },
      { timeout: 30_000 },
    ); // 只等待原设置产生的真实配置响应。
    if (!held) throw new Error("原配置响应尚未到达。");
    return held.envelope;
  };
  const waitForInput = async () => {
    const response = await vi.waitFor(
      () => {
        expect(failures).toEqual([]);
        const inputs = commands.filter(({ envelope }) =>
          isInputCommand(envelope),
        );
        expect(inputs).toHaveLength(1);
        const found = inputs[0];
        if (!found) throw new Error("原发送按钮尚未取得输入回执。");
        expect(completed.has(found.networkId)).toBe(true);
        return found;
      },
      { timeout: 30_000 },
    ); // 只等待原发送按钮的真实HTTP输入回执。
    return {
      envelope: response.envelope,
      ack: await readCommandAck(page, response.networkId),
    };
  };
  try {
    await page.cdp.send("Network.enable", {}, page.target.sessionId);
    await page.cdp.send(
      "Fetch.enable",
      {
        patterns: [
          { urlPattern: "*/api/code-ui/rpc", requestStage: "Response" },
        ],
      },
      page.target.sessionId,
    );
    await run({
      waitForConfig,
      commands: () => commands,
      waitForInput,
      async release() {
        if (!held) throw new Error("原配置响应尚未暂停。");
        const response = held;
        released = true;
        await continueResponse(response.requestId);
        await vi.waitFor(
          () => expect(completed.has(response.networkId)).toBe(true),
          {
            timeout: 30_000,
          },
        ); // 只等待原样释放的真实配置响应。
        return readCommandAck(page, response.networkId);
      },
    });
  } catch (error) {
    failures.push(error);
  } finally {
    for (const close of [
      () => (held && !released ? continueResponse(held.requestId) : undefined),
      () => Promise.all(continuations),
      () => page.cdp.send("Fetch.disable", {}, page.target.sessionId),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    offPaused();
    offCompleted();
  }
  if (failures.length)
    throw new AggregateError(failures, "原配置响应等待或清理失败", {
      cause: failures[0],
    });
}

function isInputCommand(envelope: protocol.CommandEnvelope) {
  return (
    envelope.type === "sendText" ||
    (envelope.type === "createSession" &&
      Boolean(
        protocol.commandPayloadSchemas.createSession.parse(envelope.payload)
          .firstInput,
      ))
  );
}

async function replaceText(page: OriginalSessionBrowser, text: string) {
  await clickOn(page.cdp, page.target.sessionId, { selector: inputSelector });
  await selectAll(page);
  await typeText(page.cdp, page.target.sessionId, text);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(inputSelector)})?.textContent`,
      ),
    ).toBe(text),
  );
}

async function startGroupDraft(page: OriginalSessionBrowser, groupId: string) {
  const selector = `[data-task-group-id=${JSON.stringify(groupId)}] [data-grouped-group-header-id] button[aria-label="新建任务"]`;
  await clickOn(page.cdp, page.target.sessionId, { selector });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(inputSelector)});
    const row = document.querySelector('[data-testid="grouped-draft-task"]');
    return {
      taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
      groupId: row?.closest('[data-task-group-id]')?.getAttribute('data-task-group-id'),
    };
  })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ taskId: "draft", groupId }),
  );
}

async function chooseFollowupGuide(page: OriginalSessionBrowser) {
  await clickOn(page.cdp, page.target.sessionId, {
    selector:
      '[data-root-workspace-surface="interactive"] [data-testid="task-settings-button"]',
  });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'Boolean(document.querySelector("[data-testid=settings-section-nav-general]"))',
      ),
    ).toBe(true),
  );
  await clickOn(page.cdp, page.target.sessionId, {
    selector: '[data-testid="settings-section-nav-general"]',
  });
  const point = await vi.waitFor(async () => {
    const found = await page.evaluate<{
      x: number;
      y: number;
      text: string | null;
    } | null>(`(() => {
      const label = Array.from(document.querySelectorAll('[data-settings-content-frame] div'))
        .find(element => element.textContent === '交互行为');
      const control = label?.parentElement?.parentElement?.querySelector('[role=combobox]');
      if (!control) return null;
      control.scrollIntoView({ block: 'center' });
      const rect = control.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: control.textContent };
    })()`);
    if (!found) throw new Error("原交互行为设置尚未显示。");
    expect(found.text).toBe("队列");
    return found;
  });
  await clickOn(page.cdp, page.target.sessionId, point);
  await clickExactText(page, '[role="option"]', "引导");
}

async function waitForSendButton(
  page: OriginalSessionBrowser,
  sending: boolean,
) {
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(sendSelector)});
    return Boolean(button?.checkVisibility() &&
      ${sending ? "button.disabled && button.querySelector('[role=status]')" : "!button.disabled"});
  })()`),
      JSON.stringify(page.pageErrors),
    ).toBe(true),
  );
}

async function expectDraftAndContent(
  context: TaskGroupPublicPageContext,
  groupId: string,
  text: string,
) {
  const { page, previewTitle } = context;
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(inputSelector)});
    const row = document.querySelector('[data-testid="grouped-draft-task"]');
    const preview = document.querySelector('[data-testid="preview-pane"]');
    const before = window.__taskGroupPublicBefore;
    const panel = preview?.closest('[role="tabpanel"]');
    return {
      taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id'),
      text: input?.textContent,
      groupId: row?.closest('[data-task-group-id]')?.getAttribute('data-task-group-id'),
      previewPreserved: Boolean(preview && preview === before.preview),
      previewConnected: Boolean(preview?.isConnected),
      previewPanelPreserved: Boolean(panel?.isConnected && panel.id === before.tab?.getAttribute('aria-controls')),
      previewTitle: preview?.querySelector(':scope > div:first-child span.truncate')?.textContent,
    };
  })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({
      taskId: "draft",
      text,
      groupId,
      previewPreserved: true,
      previewConnected: true,
      previewPanelPreserved: true,
      previewTitle,
    }),
  );
}

async function finishAcceptedInput(
  context: TaskGroupPublicPageContext,
  sent: { envelope: protocol.CommandEnvelope; ack: protocol.CommandAck },
  text: string,
  laterDraft: string,
) {
  const { fixture, model, modelRequestCountBefore } = context;
  expect(sent.ack).toMatchObject({
    commandId: sent.envelope.commandId,
    status: "accepted",
  });
  const taskId = z
    .uuid()
    .parse(
      sent.ack.result?.type === "createSession"
        ? sent.ack.result.sessionId
        : sent.envelope.sessionId,
    );
  await vi.waitFor(
    () => expect(model.requests).toHaveLength(modelRequestCountBefore + 1),
    {
      timeout: 30_000,
    },
  ); // 只等待本次原发送的真实本机模型HTTP请求。
  const request = model.requests[modelRequestCountBefore];
  if (!request) throw new Error("本次原发送缺少实际模型请求。");
  const messages = z
    .object({
      messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
    })
    .parse(request.body)
    .messages.filter((message) => message.role === "user");
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages[0]?.content).split(text)).toHaveLength(2);
  expect(JSON.stringify(messages[0]?.content)).not.toContain(laterDraft);
  expect(JSON.stringify(messages[0]?.content)).not.toContain(context.draft);
  model.finish(modelRequestCountBefore);
  const snapshot = await vi.waitFor(
    async () => {
      const response = await fixture.client.request(
        `/api/code-ui/sessions/${taskId}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const current = protocol.conversationSnapshotSchema.parse(
        response.body.snapshot,
      );
      expect(current.control.phase).toBe("completedSuccess");
      return current;
    },
    { timeout: 30_000 },
  ); // 仅等待该真实输入和模型流完成。
  expect(
    snapshot.rows.window
      .filter((row) => row.kind === "userInput")
      .map((row) => row.text),
  ).toEqual([text]);
  return taskId;
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原组内首发配置等待的Root、HTTP、SSE与PostgreSQL integration",
  () => {
    it("配置等待期间改到另一组，原首发保留原组且后来草稿与内容保持", async () => {
      await withTaskGroupPublicPage(async (context) => {
        const {
          page,
          host,
          model,
          scopeBefore,
          snapshotBefore,
          modelRequestCountBefore,
        } = context;
        const first = await createGroupFromUi(context);
        await dismissGroupSetup(page);
        const second = await createGroupFromUi(context);
        await dismissGroupSetup(page);
        await startGroupDraft(page, first.id);
        const sentText = "配置等待前向第一组发送的唯一消息";
        const nextText = "第二组保留的后来草稿";
        await replaceText(page, sentText);
        await withHeldFollowupResponse(page, async (pending) => {
          await chooseFollowupGuide(page);
          const config = await pending.waitForConfig();
          expect(config.type).toBe("setFollowupMode");
          expect(config.sessionId).not.toBe(host.sessionId);
          z.uuid().parse(config.sessionId);
          expect(
            protocol.commandPayloadSchemas.setFollowupMode.parse(
              config.payload,
            ),
          ).toEqual({ mode: "guide" });
          await clickOn(page.cdp, page.target.sessionId, {
            selector: '[data-testid="settings-back-button"]',
          });
          await waitForSendButton(page, false);
          await clickOn(page.cdp, page.target.sessionId, {
            selector: sendSelector,
          });
          await waitForSendButton(page, true);
          expect(
            pending
              .commands()
              .filter(({ envelope }) => isInputCommand(envelope)),
          ).toEqual([]);
          expect(model.requests).toHaveLength(modelRequestCountBefore);
          await startGroupDraft(page, second.id);
          await replaceText(page, nextText);
          await expectDraftAndContent(context, second.id, nextText);
          const configAck = await pending.release();
          expect(configAck).toMatchObject({
            commandId: config.commandId,
            status: "accepted",
          });
          const sent = await pending.waitForInput();
          const taskId = await finishAcceptedInput(
            context,
            sent,
            sentText,
            nextText,
          );
          await vi.waitFor(async () => {
            const structure = await readGroups(host);
            expect(
              structure.members.filter((member) => member.taskId === taskId),
            ).toEqual([expect.objectContaining({ taskId, groupId: first.id })]);
          });
          await expectDraftAndContent(context, second.id, nextText);
          expect(
            pending
              .commands()
              .filter(({ envelope }) => isInputCommand(envelope)),
          ).toHaveLength(1);
          expect(model.requests).toHaveLength(modelRequestCountBefore + 1);
        });
        expect(await readScope(host)).toEqual(scopeBefore);
        const original = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(original.rows.window).toEqual(snapshotBefore.rows.window);
        expect(original.taskControl).toEqual(snapshotBefore.taskControl);
      });
    }, 180_000); // 原Root、独占浏览器、透明响应等待与真实HTTP/SSE/临时PG关闭期限。
  },
);
