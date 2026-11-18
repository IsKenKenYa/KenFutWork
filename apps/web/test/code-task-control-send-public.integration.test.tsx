// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CodeTaskProjectMoveInput,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import {
  clickOn,
  dispatchKey,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import type { createCodeSessionFixture } from "../../server/src/features/code-ui/host-session.fixture.js";
import type { heldModel } from "../../server/src/features/code-ui/model-stream.fixture.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import type { PublicFixture } from "./setup/code-public-session";

type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
type Model = Awaited<ReturnType<typeof heldModel>>;
type Fixture = PublicFixture & { origin: string; directory: string };
type BrowserTarget = Pick<OriginalSessionBrowser, "cdp" | "target">;
const inputSelector = '[role="textbox"][contenteditable="true"]';
const sendSelector = '[data-testid="v4-composer-send"]';
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);

async function readCommandAck(page: BrowserTarget, requestId: string) {
  const response = await page.cdp.send(
    "Network.getResponseBody",
    { requestId },
    page.target.sessionId,
  );
  if (typeof response.body !== "string")
    throw new Error("原发送请求缺少实际 HTTP 回执。");
  const body = JSON.parse(
    response.base64Encoded
      ? Buffer.from(response.body, "base64").toString("utf8")
      : response.body,
  );
  return protocol.commandAckSchema.parse(body.result);
}

/** 只等待首个真实订阅；首发和配置 CAS 均原样通过。 */
async function pauseFirstDraftSubscription(page: BrowserTarget) {
  let subscription: { requestId: string; sessionId: unknown } | undefined;
  let send:
    | { networkId: string; envelope: protocol.CommandEnvelope }
    | undefined;
  let released = false;
  let subscribeCount = 0;
  const completed = new Set<string>();
  const continuations: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  const continueRequest = (requestId: string) => {
    const operation = page.cdp.send(
      "Fetch.continueRequest",
      { requestId },
      page.target.sessionId,
    );
    continuations.push(operation);
    void operation.catch((error: unknown) => failures.push(error));
    return operation;
  };
  const releasePaused = page.cdp.on(
    "Fetch.requestPaused",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      const request = params.request;
      if (
        request &&
        typeof request === "object" &&
        "postData" in request &&
        typeof request.postData === "string"
      ) {
        const payload = JSON.parse(request.postData);
        if (payload.service === "zcodeAgentService") {
          if (payload.method === "subscribeConversationV4") {
            subscribeCount += 1;
            if (!subscription) {
              subscription = {
                requestId: params.requestId,
                sessionId: payload.args?.[0]?.sessionId,
              };
              return;
            }
          }
          if (
            payload.method === "sendConversationCommandV4" &&
            payload.args?.[0]?.envelope?.type === "sendText" &&
            typeof params.networkId === "string"
          ) {
            send = {
              networkId: params.networkId,
              envelope: protocol.commandEnvelopeSchema.parse(
                payload.args[0].envelope,
              ),
            };
          }
        }
      }
      void continueRequest(params.requestId);
    },
  );
  const releaseCompleted = page.cdp.on(
    "Network.loadingFinished",
    (params, sessionId) => {
      if (
        sessionId === page.target.sessionId &&
        typeof params.requestId === "string"
      )
        completed.add(params.requestId);
    },
  );
  await page.cdp.send("Network.enable", {}, page.target.sessionId);
  await page.cdp.send(
    "Fetch.enable",
    {
      patterns: [{ urlPattern: "*/api/code-ui/rpc", requestStage: "Request" }],
    },
    page.target.sessionId,
  );
  return {
    async waitForSubscription(expectedSessionId: string) {
      await vi.waitFor(
        () => {
          expect(failures).toEqual([]);
          expect(subscription?.sessionId).toBe(expectedSessionId);
        },
        { timeout: 30_000 },
      );
      if (!subscription) throw new Error("未暂停原草稿的首个订阅。");
      return subscription.sessionId;
    },
    async sentEnvelope() {
      await vi.waitFor(
        () => {
          expect(failures).toEqual([]);
          expect(send?.envelope.type).toBe("sendText");
        },
        { timeout: 30_000 },
      );
      if (!send) throw new Error("原草稿尚未发出真实首发命令。");
      return send.envelope;
    },
    async releaseSubscription() {
      if (!subscription || released) return;
      await continueRequest(subscription.requestId);
      released = true;
    },
    async sendAck() {
      if (!send) throw new Error("原草稿没有真实首发回执。");
      const { networkId } = send;
      await vi.waitFor(() => expect(completed.has(networkId)).toBe(true), {
        timeout: 30_000,
      });
      return readCommandAck(page, networkId);
    },
    subscriptionCount: () => subscribeCount,
    async dispose() {
      const cleanupFailures: unknown[] = [];
      for (const close of [
        () =>
          subscription && !released
            ? continueRequest(subscription.requestId)
            : undefined,
        () => Promise.all(continuations),
        () => page.cdp.send("Fetch.disable", {}, page.target.sessionId),
      ]) {
        try {
          await close();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      releasePaused();
      releaseCompleted();
      if (failures.length || cleanupFailures.length)
        throw new AggregateError(
          [...failures, ...cleanupFailures],
          "原草稿订阅暂停未完成清理。",
        );
    },
  };
}

/** 只暂停本次原按钮的精确命令；继续时不覆盖参数、状态码或正文。 */
async function pauseConversationCommand(
  page: OriginalSessionBrowser,
  commandType: "sendText" | "stop" | "setFollowupMode",
) {
  let paused:
    | {
        requestId: string;
        networkId: string;
        envelope: protocol.CommandEnvelope;
      }
    | undefined;
  let continued = false;
  const observed: {
    networkId: string;
    envelope: protocol.CommandEnvelope;
  }[] = [];
  const completed = new Set<string>();
  const continuations: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  const continueRequest = (requestId: string) => {
    const operation = page.cdp.send(
      "Fetch.continueRequest",
      { requestId },
      page.target.sessionId,
    );
    continuations.push(operation);
    void operation.catch((error: unknown) => failures.push(error));
    return operation;
  };
  const releasePaused = page.cdp.on(
    "Fetch.requestPaused",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      const request = params.request;
      if (
        request &&
        typeof request === "object" &&
        "postData" in request &&
        typeof request.postData === "string"
      ) {
        const payload = JSON.parse(request.postData);
        if (
          payload.service === "zcodeAgentService" &&
          payload.method === "sendConversationCommandV4" &&
          typeof params.networkId === "string"
        ) {
          const command = {
            networkId: params.networkId,
            envelope: protocol.commandEnvelopeSchema.parse(
              payload.args[0].envelope,
            ),
          };
          observed.push(command);
          if (!paused && command.envelope.type === commandType) {
            paused = { ...command, requestId: params.requestId };
            return;
          }
        }
      }
      void continueRequest(params.requestId);
    },
  );
  const releaseCompleted = page.cdp.on(
    "Network.loadingFinished",
    (params, sessionId) => {
      if (
        sessionId === page.target.sessionId &&
        typeof params.requestId === "string"
      )
        completed.add(params.requestId);
    },
  );
  await page.cdp.send("Network.enable", {}, page.target.sessionId);
  await page.cdp.send(
    "Fetch.enable",
    {
      patterns: [{ urlPattern: "*/api/code-ui/rpc", requestStage: "Request" }],
    },
    page.target.sessionId,
  );
  return {
    async originalEnvelope() {
      await vi.waitFor(
        () => {
          expect(failures).toEqual([]);
          expect(paused?.envelope.type).toBe(commandType);
        },
        { timeout: 30_000 },
      );
      if (!paused) throw new Error("未暂停原会话按钮请求。");
      return paused.envelope;
    },
    async resume() {
      if (!paused) throw new Error("原会话按钮请求尚未暂停。");
      const { requestId, networkId } = paused;
      await continueRequest(requestId);
      continued = true;
      await vi.waitFor(() => expect(completed.has(networkId)).toBe(true), {
        timeout: 30_000,
      });
      return readCommandAck(page, networkId);
    },
    envelopes: () => observed.map((request) => request.envelope),
    async sentCommand() {
      await vi.waitFor(
        () => {
          expect(failures).toEqual([]);
          expect(
            observed.some(
              (request) =>
                request.envelope.type === "sendText" &&
                completed.has(request.networkId),
            ),
          ).toBe(true);
        },
        { timeout: 30_000 },
      );
      const request = observed.find(
        (request) => request.envelope.type === "sendText",
      );
      if (!request) throw new Error("配置等待结束后尚未发出真实发送请求。");
      return {
        envelope: request.envelope,
        ack: await readCommandAck(page, request.networkId),
      };
    },
    async dispose() {
      const cleanupFailures: unknown[] = [];
      for (const close of [
        () =>
          paused && !continued ? continueRequest(paused.requestId) : undefined,
        () => Promise.all(continuations),
        () => page.cdp.send("Fetch.disable", {}, page.target.sessionId),
      ]) {
        try {
          await close();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      releasePaused();
      releaseCompleted();
      if (failures.length || cleanupFailures.length)
        throw new AggregateError(
          [...failures, ...cleanupFailures],
          "原发送请求暂停未完成清理。",
        );
    },
  };
}

async function moveTask(host: Host, input: CodeTaskProjectMoveInput) {
  const moved = await host.client.request("/api/code-ui/rpc", {
    service: "project",
    method: "moveTask",
    args: [input],
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body).toEqual({ result: null });
}

async function startObservedRun(
  host: Host,
  observed: protocol.ConversationSnapshot,
  text: string,
) {
  if (!observed.taskControl || !observed.config.modelSelection)
    throw new Error("公开快照缺少运行观察值或模型选择。");
  const response = await host.stream.rpc("sendConversationCommandV4", [
    {
      workspacePath: host.workspacePath,
      projectId: host.projectId,
      envelope: {
        commandId: randomUUID(),
        clientId: host.clientId,
        sessionId: host.sessionId,
        type: "sendText",
        taskControl: { ...observed.taskControl },
        payload: { text, modelSelection: observed.config.modelSelection },
        issuedAt: Date.now(),
      },
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(protocol.commandAckSchema.parse(response.body.result).status).toBe(
    "accepted",
  );
}

async function moveTaskRoundTrip(fixture: Fixture, host: Host) {
  const initial = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  const targetDirectory = join(fixture.directory, "原发送观察值往返目标");
  await mkdir(targetDirectory);
  const created = await host.client.request("/api/projects", {
    name: "原发送观察值目标",
    kind: "code",
    work_dir: targetDirectory,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const targetProjectId: unknown = created.body.project.id;
  if (typeof targetProjectId !== "string")
    throw new Error("目标项目缺少实际身份。");
  const task = { taskId: host.sessionId, workspacePath: host.workspacePath };
  await moveTask(host, {
    task,
    sourceProjectId: host.projectId,
    projectId: targetProjectId,
    observedRevision: initial.revision,
    addMissingRoot: true,
  });
  const atTarget = protocol.conversationSnapshotSchema.parse(
    await host.snapshot(),
  );
  expect(atTarget.taskControl?.projectId).toBe(targetProjectId);
  await moveTask(host, {
    task,
    sourceProjectId: targetProjectId,
    projectId: host.projectId,
    observedRevision: atTarget.revision,
    addMissingRoot: true,
  });
  return protocol.conversationSnapshotSchema.parse(await host.snapshot());
}

async function replaceComposerText(page: OriginalSessionBrowser, text: string) {
  await clickOn(page.cdp, page.target.sessionId, { selector: inputSelector });
  const previous = await page.evaluate<string>(
    `document.querySelector(${JSON.stringify(inputSelector)})?.textContent ?? ""`,
  );
  const modifiers = await page.evaluate<number>(
    'navigator.platform.includes("Mac") ? 4 : 2',
  );
  // 与原 CDP 按键一致发送完整键码，使用实际平台的 Command/Ctrl+A。
  await page.cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers,
    },
    page.target.sessionId,
  );
  await page.cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers,
    },
    page.target.sessionId,
  );
  await vi.waitFor(async () =>
    expect(await page.evaluate('window.getSelection()?.toString() ?? ""')).toBe(
      previous,
    ),
  );
  await dispatchKey(page.cdp, page.target.sessionId, { key: "Backspace" });
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(inputSelector)})?.textContent`,
      ),
    ).toBe(""),
  );
  await typeText(page.cdp, page.target.sessionId, text);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(inputSelector)})?.textContent`,
      ),
    ).toBe(text),
  );
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原输入框发送的 Task 控制观察值 integration",
  () => {
    it("点击发送后项目往返使原请求返回stale，期间新正文保留且不创建运行或模型请求", async () => {
      const httpLoading: Promise<{
        createCodeUiHttpFixture(): Promise<Fixture>;
      }> = import(fixturePath);
      const [http, sessions, models] = await Promise.all([
        httpLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
        import("../../server/src/features/code-ui/model-stream.fixture.js"),
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      let model: Model | undefined;
      let host: Host | undefined;
      let browser: OriginalSessionBrowser | undefined;
      let interception:
        | Awaited<ReturnType<typeof pauseConversationCommand>>
        | undefined;
      const failures: unknown[] = [];
      try {
        model = await models.heldModel();
        host = await sessions.createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const initial = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        if (!initial.taskControl)
          throw new Error("原公开快照缺少 Task 控制观察值。");
        browser = await openOriginalSessionBrowser({
          backendBaseUrl: fixture.baseUrl,
          backendOrigin: fixture.origin,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          sessionId: host.sessionId,
          clientId: host.clientId,
        });
        const page = browser;
        const sentText = "原点击发送观察值";
        const nextText = "等待原发送时编辑的新正文";
        await replaceComposerText(page, sentText);
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
            const send = document.querySelector(${JSON.stringify(sendSelector)});
            return Boolean(send && !send.disabled);
          })()`),
          ).toBe(true),
        );
        interception = await pauseConversationCommand(page, "sendText");
        await clickOn(page.cdp, page.target.sessionId, {
          selector: sendSelector,
        });
        const envelope = await interception.originalEnvelope();
        expect(envelope.sessionId).toBe(host.sessionId);
        expect(
          protocol.commandPayloadSchemas.sendText.parse(envelope.payload).text,
        ).toBe(sentText);
        await replaceComposerText(page, nextText);
        expect(
          await page.evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(inputSelector)});
          window.__taskControlSendInput = input;
          return input?.textContent;
        })()`),
        ).toBe(nextText);

        const returned = await moveTaskRoundTrip(fixture, host);
        expect(returned.taskControl?.projectId).toBe(host.projectId);
        expect(returned.taskControl?.branchGeneration).toBeGreaterThan(
          initial.taskControl.branchGeneration,
        );
        const ack = await interception.resume();
        expect(ack).toMatchObject({
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: "proto.staleTaskControl",
        });
        expect(envelope.taskControl).toEqual(initial.taskControl);
        const after = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(after.rows.window).toEqual(returned.rows.window);
        expect(after.control).toEqual(returned.control);
        expect(after.control.phase).toBe("draft");
        expect(after.control.activeWorks).toEqual([]);
        expect(after.pendingCommands).toEqual([]);
        expect(model.requests).toHaveLength(0);
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(inputSelector)});
          const send = document.querySelector(${JSON.stringify(sendSelector)});
          return {
            sameInput: input === window.__taskControlSendInput,
            text: input?.textContent,
            canSend: Boolean(send && !send.disabled),
          };
        })()`),
            JSON.stringify(page.pageErrors),
          ).toEqual({
            sameInput: true,
            text: nextText,
            canSend: true,
          }),
        );
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => interception?.dispose(),
          () => browser?.close(),
          () => host?.dispose(),
          () => fixture.close(),
          () => model?.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "原发送观察值验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);

    it("原Stop按钮的请求在项目往返后返回stale，新运行与真实模型流继续保持", async () => {
      const httpLoading: Promise<{
        createCodeUiHttpFixture(): Promise<Fixture>;
      }> = import(fixturePath);
      const [http, sessions, models] = await Promise.all([
        httpLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
        import("../../server/src/features/code-ui/model-stream.fixture.js"),
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      let model: Model | undefined;
      let host: Host | undefined;
      let browser: OriginalSessionBrowser | undefined;
      let interception:
        | Awaited<ReturnType<typeof pauseConversationCommand>>
        | undefined;
      const failures: unknown[] = [];
      try {
        model = await models.heldModel();
        host = await sessions.createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        const currentHost = host;
        const initial = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        await startObservedRun(host, initial, "原Stop按钮观察的旧运行");
        await vi.waitFor(() => expect(model?.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        await vi.waitFor(async () => {
          const snapshot = protocol.conversationSnapshotSchema.parse(
            await currentHost.snapshot(),
          );
          expect(snapshot.control.canStop).toBe(true);
          expect(snapshot.control.phase).toBe("running");
        });
        browser = await openOriginalSessionBrowser({
          backendBaseUrl: fixture.baseUrl,
          backendOrigin: fixture.origin,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          sessionId: host.sessionId,
          clientId: host.clientId,
        });
        const page = browser;
        const stopSelector = '[data-testid="v4-stop"]';
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
          const stop = document.querySelector(${JSON.stringify(stopSelector)});
          return Boolean(stop && !stop.disabled);
        })()`),
            JSON.stringify(page.pageErrors),
          ).toBe(true),
        );
        const beforeClick = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        if (!beforeClick.taskControl)
          throw new Error("停止前公开快照缺少 Task 观察值。");
        interception = await pauseConversationCommand(page, "stop");
        await clickOn(page.cdp, page.target.sessionId, {
          selector: stopSelector,
        });
        const original = await interception.originalEnvelope();
        expect(original.sessionId).toBe(host.sessionId);
        const oldForeground = beforeClick.control.activeWorks.find(
          (work) => work.foregroundExecutionId,
        )?.foregroundExecutionId;
        if (!oldForeground) throw new Error("原Stop按钮缺少实际前台执行身份。");
        expect(
          protocol.commandPayloadSchemas.stop.parse(original.payload),
        ).toMatchObject({
          expectedForegroundExecutionId: oldForeground,
        });

        const beforeIndependentStop = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        if (!beforeIndependentStop.taskControl)
          throw new Error("独立停止缺少当次公开观察值。");
        const stopped = await host.stream.rpc("sendConversationCommandV4", [
          {
            workspacePath: host.workspacePath,
            projectId: host.projectId,
            envelope: {
              commandId: randomUUID(),
              clientId: host.clientId,
              sessionId: host.sessionId,
              type: "stop",
              taskControl: { ...beforeIndependentStop.taskControl },
              payload: {},
              issuedAt: Date.now(),
            },
          },
        ]);
        expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
        expect(
          protocol.commandAckSchema.parse(stopped.body.result).status,
        ).toBe("accepted");
        await vi.waitFor(
          async () => {
            const snapshot = protocol.conversationSnapshotSchema.parse(
              await currentHost.snapshot(),
            );
            expect(snapshot.control.phase).toBe("completedInterrupted");
            expect(snapshot.control.activeWorks).toEqual([]);
            expect(model?.requests[0]?.closed).toBe(true);
          },
          { timeout: 30_000 },
        );
        const returned = await moveTaskRoundTrip(fixture, host);
        expect(returned.taskControl?.branchGeneration).toBeGreaterThan(
          beforeClick.taskControl.branchGeneration,
        );
        await startObservedRun(host, returned, "项目往返后的新运行");
        await vi.waitFor(() => expect(model?.requests).toHaveLength(2), {
          timeout: 30_000,
        });
        let running = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        await vi.waitFor(async () => {
          running = protocol.conversationSnapshotSchema.parse(
            await currentHost.snapshot(),
          );
          expect(running.control.phase).toBe("running");
          expect(running.control.activeWorks).toContainEqual(
            expect.objectContaining({
              kind: "primaryTurn",
              foregroundExecutionId: expect.any(String),
            }),
          );
          expect(model?.requests[1]?.closed).toBe(false);
        });
        const ack = await interception.resume();
        expect(ack).toMatchObject({
          commandId: original.commandId,
          status: "stale",
          reasonCode: "proto.staleTaskControl",
        });
        expect(original.taskControl).toEqual(beforeClick.taskControl);
        const after = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(after.control.phase).toBe("running");
        expect(after.control.activeWorks).toEqual(running.control.activeWorks);
        expect(model.requests).toHaveLength(2);
        expect(model.requests[1]?.closed).toBe(false);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => interception?.dispose(),
          () => browser?.close(),
          () => host?.dispose(),
          () => fixture.close(),
          () => model?.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "原Stop观察值验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);

    it("预热快照尚未到时原草稿首发使用创建ACK的观察值，同一预热Task只运行一次", async () => {
      const httpLoading: Promise<{
        createCodeUiHttpFixture(): Promise<Fixture>;
      }> = import(fixturePath);
      const [http, sessions, models] = await Promise.all([
        httpLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
        import("../../server/src/features/code-ui/model-stream.fixture.js"),
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      let model: Model | undefined;
      let host: Host | undefined;
      let browser: OriginalSessionBrowser | undefined;
      let interception:
        | Awaited<ReturnType<typeof pauseFirstDraftSubscription>>
        | undefined;
      const failures: unknown[] = [];
      try {
        model = await models.heldModel();
        host = await sessions.createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        browser = await openOriginalSessionBrowser({
          backendBaseUrl: fixture.baseUrl,
          backendOrigin: fixture.origin,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          sessionId: host.sessionId,
          clientId: host.clientId,
          newDraft: true,
          beforeNavigate: async (page) => {
            interception = await pauseFirstDraftSubscription(page);
          },
        });
        const page = browser;
        const created = await vi.waitFor(
          () => {
            const response = page.sessionCreateAcks[0];
            if (
              !response ||
              typeof response !== "object" ||
              !("result" in response)
            )
              throw new Error("尚未读取到真实创建 ACK。");
            const ack = protocol.commandAckSchema.parse(response.result);
            expect(ack.status).toBe("accepted");
            if (ack.result?.type !== "createSession" || !ack.result.taskControl)
              throw new Error("真实创建 ACK 缺少预热 Task 及控制观察值。");
            return {
              sessionId: ack.result.sessionId,
              taskControl: ack.result.taskControl,
            };
          },
          { timeout: 30_000 },
        );
        expect(created.sessionId).not.toBe(host.sessionId);
        if (!interception) throw new Error("导航前未启用原草稿订阅等待。");
        await interception.waitForSubscription(created.sessionId);
        expect(interception.subscriptionCount()).toBe(1);
        expect(
          await page.evaluate(
            'document.querySelector("[data-testid=v4-session-pane-actual-model-menu-pane]")?.dataset.sessionId',
          ),
        ).toBe("draft");
        const text = "预热快照未到时的原草稿首发";
        await replaceComposerText(page, text);
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
          const send = document.querySelector(${JSON.stringify(sendSelector)});
          return Boolean(send && !send.disabled);
        })()`),
            JSON.stringify(page.pageErrors),
          ).toBe(true),
        );
        await clickOn(page.cdp, page.target.sessionId, {
          selector: sendSelector,
        });
        const envelope = await interception.sentEnvelope();
        expect(envelope.sessionId).toBe(created.sessionId);
        expect(
          protocol.commandPayloadSchemas.sendText.parse(envelope.payload).text,
        ).toBe(text);
        expect(envelope.taskControl).toEqual(created.taskControl);
        expect(interception.subscriptionCount()).toBe(1);
        await interception.releaseSubscription();
        expect(await interception.sendAck()).toMatchObject({
          commandId: envelope.commandId,
          status: "accepted",
        });
        await vi.waitFor(() => expect(model?.requests).toHaveLength(1), {
          timeout: 30_000,
        });
        const result = await fixture.client.request(
          `/api/code-ui/sessions/${created.sessionId}`,
        );
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        const snapshot = protocol.conversationSnapshotSchema.parse(
          result.body.snapshot,
        );
        expect(snapshot.taskControl).toEqual(created.taskControl);
        expect(snapshot.control.phase).toBe("running");
        expect(
          snapshot.rows.window.filter((row) => row.kind === "userInput"),
        ).toHaveLength(1);
        expect(page.sessionCreateAcks).toHaveLength(1);
        expect(model.requests[0]?.closed).toBe(false);
        const originalTask = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(originalTask.control.phase).toBe("draft");
        expect(
          originalTask.rows.window.filter((row) => row.kind === "userInput"),
        ).toEqual([]);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => interception?.dispose(),
          () => browser?.close(),
          () => host?.dispose(),
          () => fixture.close(),
          () => model?.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "原草稿创建观察值验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);

    it("原配置等待期间点击发送，项目往返后配置不自动重试且发送保留点击观察值", async () => {
      const httpLoading: Promise<{
        createCodeUiHttpFixture(): Promise<Fixture>;
      }> = import(fixturePath);
      const [http, sessions, models] = await Promise.all([
        httpLoading,
        import("../../server/src/features/code-ui/host-session.fixture.js"),
        import("../../server/src/features/code-ui/model-stream.fixture.js"),
      ]);
      const fixture = await http.createCodeUiHttpFixture();
      let model: Model | undefined;
      let host: Host | undefined;
      let browser: OriginalSessionBrowser | undefined;
      let interception:
        | Awaited<ReturnType<typeof pauseConversationCommand>>
        | undefined;
      const failures: unknown[] = [];
      try {
        model = await models.heldModel();
        host = await sessions.createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        browser = await openOriginalSessionBrowser({
          backendBaseUrl: fixture.baseUrl,
          backendOrigin: fixture.origin,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
          workspacePath: host.workspacePath,
          projectId: host.projectId,
          sessionId: host.sessionId,
          clientId: host.clientId,
          workspaceShell: true,
        });
        const page = browser;
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
              const input = document.querySelector(${JSON.stringify(inputSelector)});
              return input?.closest('[data-session-id]')?.getAttribute('data-session-id');
            })()`),
            JSON.stringify(page.pageErrors),
          ).toBe(host?.sessionId),
        );
        await page.evaluate(`(() => {
          window.__taskControlConfigInput = document.querySelector(${JSON.stringify(inputSelector)});
        })()`);
        await clickOn(page.cdp, page.target.sessionId, {
          selector:
            '[data-root-workspace-surface="interactive"] [data-testid="task-settings-button"]',
        });
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              'Boolean(document.querySelector("[data-testid=settings-section-nav-general]"))',
            ),
            JSON.stringify(page.pageErrors),
          ).toBe(true),
        );
        await clickOn(page.cdp, page.target.sessionId, {
          selector: '[data-testid="settings-section-nav-general"]',
        });
        const control = await vi.waitFor(async () => {
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
          if (!found) throw new Error("原交互行为控件尚未显示。");
          expect(found.text).toBe("队列");
          return found;
        });
        interception = await pauseConversationCommand(page, "setFollowupMode");
        await clickOn(page.cdp, page.target.sessionId, control);
        const guide = await vi.waitFor(async () => {
          const selector = await page.evaluate<string | null>(`(() => {
            const option = Array.from(document.querySelectorAll('[role=option]'))
              .find(element => element.textContent === '引导');
            const label = option?.getAttribute('aria-labelledby');
            return label ? '[role=option][aria-labelledby=' + JSON.stringify(label) + ']' : null;
          })()`);
          if (!selector) throw new Error("原交互行为菜单尚未显示引导选项。");
          return selector;
        });
        await clickOn(page.cdp, page.target.sessionId, { selector: guide });
        const config = await interception.originalEnvelope();
        expect(config.sessionId).toBe(host.sessionId);
        expect(
          protocol.commandPayloadSchemas.setFollowupMode.parse(config.payload),
        ).toEqual({ mode: "guide" });
        await clickOn(page.cdp, page.target.sessionId, {
          selector: '[data-testid="settings-back-button"]',
        });
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(
              'Boolean(document.querySelector("[data-root-workspace-surface=interactive]"))',
            ),
          ).toBe(true),
        );
        const sentText = "原配置等待中的点击发送";
        const nextText = "配置等待期间编辑的新正文";
        await replaceComposerText(page, sentText);
        const beforeClick = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        if (!beforeClick.taskControl)
          throw new Error("配置等待期间缺少公开 Task 观察值。");
        expect(config.taskControl).toEqual(beforeClick.taskControl);
        expect(beforeClick.config.followupMode).toBe("queue");
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
              const send = document.querySelector(${JSON.stringify(sendSelector)});
              return Boolean(send && !send.disabled);
            })()`),
          ).toBe(true),
        );
        await clickOn(page.cdp, page.target.sessionId, {
          selector: sendSelector,
        });
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
              const send = document.querySelector(${JSON.stringify(sendSelector)});
              return Boolean(send?.disabled && send.querySelector('[role=status]'));
            })()`),
          ).toBe(true),
        );
        expect(
          interception
            .envelopes()
            .filter((envelope) => envelope.type === "sendText"),
        ).toEqual([]);
        await replaceComposerText(page, nextText);
        const returned = await moveTaskRoundTrip(fixture, host);
        expect(returned.taskControl?.branchGeneration).toBeGreaterThan(
          beforeClick.taskControl.branchGeneration,
        );
        const configAck = await interception.resume();
        const sent = await interception.sentCommand();
        const observed = interception.envelopes();
        const sendIndex = observed.findIndex(
          (envelope) => envelope.commandId === sent.envelope.commandId,
        );
        expect(sendIndex).toBeGreaterThan(0);
        expect(
          observed
            .slice(0, sendIndex)
            .filter((envelope) => envelope.type === "setFollowupMode"),
        ).toEqual([config]);
        expect(configAck).toMatchObject({
          commandId: config.commandId,
          status: "stale",
          reasonCode: "proto.staleTaskControl",
        });
        expect(sent.envelope.sessionId).toBe(host.sessionId);
        expect(sent.envelope.taskControl).toEqual(beforeClick.taskControl);
        expect(
          protocol.commandPayloadSchemas.sendText.parse(sent.envelope.payload)
            .text,
        ).toBe(sentText);
        expect(sent.ack).toMatchObject({
          commandId: sent.envelope.commandId,
          status: "stale",
          reasonCode: "proto.staleTaskControl",
        });
        const after = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        expect(after.config.followupMode).toBe("queue");
        expect(after.rows.window).toEqual(returned.rows.window);
        expect(after.control.phase).toBe("draft");
        expect(after.control.activeWorks).toEqual([]);
        expect(after.pendingCommands).toEqual([]);
        expect(model.requests).toHaveLength(0);
        await vi.waitFor(async () =>
          expect(
            await page.evaluate(`(() => {
              const input = document.querySelector(${JSON.stringify(inputSelector)});
              const send = document.querySelector(${JSON.stringify(sendSelector)});
              return {
                sameInput: input === window.__taskControlConfigInput,
                text: input?.textContent,
                canSend: Boolean(send && !send.disabled),
              };
            })()`),
            JSON.stringify(page.pageErrors),
          ).toEqual({ sameInput: true, text: nextText, canSend: true }),
        );
      } catch (error) {
        failures.push(error);
      } finally {
        for (const close of [
          () => interception?.dispose(),
          () => browser?.close(),
          () => host?.dispose(),
          () => fixture.close(),
          () => model?.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "原配置等待观察值验证或清理失败", {
          cause: failures[0],
        });
    }, 180_000);
  },
);
