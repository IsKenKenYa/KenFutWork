// @vitest-environment node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clickOn,
  pressKey,
  typeText,
} from "../../server/src/features/browser/cdp-client.js";
import {
  type OriginalSessionBrowser,
  openOriginalSessionBrowser,
} from "./setup/code-public-browser.fixture.mjs";
import {
  clickExactText,
  selectAll,
} from "./setup/code-public-browser-actions.js";
import {
  expectContentPreserved,
  readScope,
  type TaskGroupPublicPageContext,
} from "./setup/code-task-groups-public.fixture.js";
import {
  type ProjectionContext,
  withProjectionResources,
} from "./setup/code-task-project-projection.fixture.js";

const inputSelector = '[role="textbox"][contenteditable="true"]';
const titleInput = '[role="dialog"] input[placeholder="任务名称"]';
const rpcSchema = z.object({
  service: z.string(),
  method: z.string(),
  args: z.array(z.unknown()),
});
type RenameRequest = {
  taskId: string;
  title: string;
  service: string;
  method: string;
  input: unknown;
  command?: protocol.CommandEnvelope;
};
type RenameExchange = RenameRequest & {
  requestId: string;
  status?: number;
  finished?: boolean;
  error?: string;
};

function renameRequest(request: unknown): RenameRequest | undefined {
  const { url, postData } = z
    .object({ url: z.string(), postData: z.string().optional() })
    .parse(request);
  if (new URL(url).pathname !== "/api/code-ui/rpc" || !postData) return;
  const rpc = rpcSchema.parse(JSON.parse(postData));
  if (rpc.service === "zcode-task" && rpc.method === "renameTask") {
    const input = z
      .object({ taskId: z.string(), title: z.string() })
      .parse(rpc.args[0]);
    return {
      ...input,
      service: rpc.service,
      method: rpc.method,
      input: rpc.args[0],
    };
  }
  if (
    rpc.service !== "zcodeAgentService" ||
    rpc.method !== "sendConversationCommandV4"
  )
    return;
  const { envelope } = z
    .object({ envelope: protocol.commandEnvelopeSchema })
    .parse(rpc.args[0]);
  if (envelope.type !== "renameSession") return;
  const { title } = protocol.commandPayloadSchemas.renameSession.parse(
    envelope.payload,
  );
  return {
    taskId: z.string().parse(envelope.sessionId),
    title,
    service: rpc.service,
    method: rpc.method,
    input: rpc.args[0],
    command: envelope,
  };
}

async function readResponse(page: OriginalSessionBrowser, requestId: string) {
  const payload = z
    .object({ body: z.string(), base64Encoded: z.boolean().optional() })
    .parse(
      await page.cdp.send(
        "Network.getResponseBody",
        { requestId },
        page.target.sessionId,
      ),
    );
  return JSON.parse(
    payload.base64Encoded
      ? Buffer.from(payload.body, "base64").toString("utf8")
      : payload.body,
  );
}

function observeRename(page: OriginalSessionBrowser, taskId: string) {
  const requests = new Map<string, RenameExchange>();
  const failures: unknown[] = [];
  const offRequested = page.cdp.on(
    "Network.requestWillBeSent",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      try {
        const input = renameRequest(params.request);
        if (input?.taskId === taskId)
          requests.set(params.requestId, {
            ...input,
            requestId: params.requestId,
          });
      } catch (cause) {
        failures.push(cause);
      }
    },
  );
  const offResponse = page.cdp.on(
    "Network.responseReceived",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      const request = requests.get(params.requestId);
      if (!request) return;
      try {
        request.status = z
          .object({ status: z.number() })
          .parse(params.response).status;
      } catch (cause) {
        failures.push(cause);
      }
    },
  );
  const offCompleted = page.cdp.on(
    "Network.loadingFinished",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      const request = requests.get(params.requestId);
      if (request) request.finished = true;
    },
  );
  const offFailed = page.cdp.on(
    "Network.loadingFailed",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      const request = requests.get(params.requestId);
      if (request) request.error = String(params.errorText);
    },
  );
  return {
    async wait() {
      const response = await vi.waitFor(
        () => {
          expect(failures).toEqual([]);
          const ready = [...requests.values()].find(
            (entry) => entry.finished || entry.error,
          );
          if (!ready)
            throw new Error(
              `原改名请求尚无回执：${JSON.stringify({ requests: [...requests.values()], errors: page.pageErrors })}`,
            );
          return ready;
        },
        { timeout: 5_000 },
      ); // 仅等待实际响应到达；HTTP错误在轮询外立即报告。
      if (response.error)
        throw new Error(`原改名请求网络失败：${JSON.stringify(response)}`);
      const body: unknown = await readResponse(page, response.requestId);
      expect(response.status, JSON.stringify({ response, body })).toBe(200);
      expect(requests.size).toBe(1);
      if (response.command) {
        const { result } = z
          .object({ result: protocol.commandAckSchema })
          .parse(body);
        expect(result.status, JSON.stringify(result)).toBe("accepted");
        expect(result.commandId).toBe(response.command.commandId);
      } else {
        expect(
          z.object({ result: z.unknown() }).parse(body).result,
        ).toMatchObject({
          taskId,
          title: response.title,
        });
      }
      return response;
    },
    close() {
      offRequested();
      offResponse();
      offCompleted();
      offFailed();
    },
  };
}

async function visiblePoint(page: OriginalSessionBrowser, selector: string) {
  const point = await vi.waitFor(
    async () => {
      const found = await page.evaluate<{ x: number; y: number } | null>(
        `(async () => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element?.checkVisibility() || element.disabled) return null;
          element.scrollIntoView({ block: 'center' });
          const first = element.getBoundingClientRect();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const rect = element.getBoundingClientRect();
          if (first.x !== rect.x || first.y !== rect.y || first.width !== rect.width || first.height !== rect.height)
            return null;
          const point = { x: rect.left + rect.width / 3, y: rect.top + rect.height / 2 };
          const hit = document.elementFromPoint(point.x, point.y);
          return hit && element.contains(hit) ? point : null;
        })()`,
      );
      expect(
        found,
        JSON.stringify({ selector, errors: page.pageErrors }),
      ).not.toBeNull();
      return found;
    },
    { timeout: 30_000 },
  );
  if (!point) throw new Error(`原改名操作入口尚未显示：${selector}`);
  return point;
}

async function prepareContent(
  context: ProjectionContext,
  page: OriginalSessionBrowser,
  previewPath: string,
  previewTitle: string,
): Promise<TaskGroupPublicPageContext> {
  const { fixture, session: host, model } = context;
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(inputSelector)})?.closest('[data-session-id]')?.getAttribute('data-session-id')`,
      ),
      JSON.stringify(page.pageErrors),
    ).toBe(host.sessionId),
  );
  const project = `section[data-project-id=${JSON.stringify(host.projectId)}]`;
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseMoved",
      ...(await visiblePoint(
        page,
        `${project} [data-testid="virtual-project-row"]`,
      )),
    },
    page.target.sessionId,
  );
  await clickOn(page.cdp, page.target.sessionId, {
    selector: `${project} [data-testid="virtual-project-files"]`,
  });
  const file = `[data-testid=${JSON.stringify(`workspace-file-tree-row-${previewPath}`)}]`;
  await clickOn(
    page.cdp,
    page.target.sessionId,
    await visiblePoint(page, file),
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
      const tab = document.querySelector('[data-side-pane-tab-id][data-state="active"]');
      return { title: tab?.querySelector('[data-side-pane-tab-title]')?.textContent,
        ready: Boolean(document.querySelector('[data-testid="preview-pane"]')?.checkVisibility()) };
    })()`),
    ).toEqual({ title: previewTitle, ready: true }),
  );
  await clickExactText(
    page,
    '[data-testid="workspace-file-tree-panel"] button',
    "返回任务",
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        'document.querySelector("[data-testid=workspace-file-tree-panel]")?.checkVisibility()',
      ),
    ).toBe(false),
  );
  const draft = "任务改名期间保留的正文草稿";
  await clickOn(page.cdp, page.target.sessionId, { selector: inputSelector });
  expect(
    await page.evaluate(
      `document.querySelector(${JSON.stringify(inputSelector)})?.textContent`,
    ),
  ).toBe("");
  await typeText(page.cdp, page.target.sessionId, draft);
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(inputSelector)})?.textContent`,
      ),
    ).toBe(draft),
  );
  await page.evaluate(`(() => {
    window.__taskGroupPublicBefore = {
      input: document.querySelector(${JSON.stringify(inputSelector)}),
      preview: document.querySelector('[data-testid="preview-pane"]'),
      tab: document.querySelector('[data-side-pane-tab-id][data-state="active"]'),
    };
  })()`);
  return {
    fixture,
    host,
    model,
    page,
    draft,
    previewTitle,
    scopeBefore: await readScope(host),
    snapshotBefore: protocol.conversationSnapshotSchema.parse(
      await host.snapshot(),
    ),
    modelRequestCountBefore: model.requests.length,
  };
}

async function openRename({ page, host }: TaskGroupPublicPageContext) {
  const row = `section[data-project-id=${JSON.stringify(host.projectId)}] [data-testid="task-item-${host.sessionId}"]`;
  const point = await visiblePoint(page, row);
  expect(
    await page.evaluate(`(() => {
    const row = document.querySelector(${JSON.stringify(row)});
    const hit = document.elementFromPoint(${point.x}, ${point.y});
    return Boolean(row && hit && row.contains(hit) && !hit.closest('button'));
  })()`),
  ).toBe(true);
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...point },
    page.target.sessionId,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await page.cdp.send(
      "Input.dispatchMouseEvent",
      { type, ...point, button: "right", clickCount: 1 },
      page.target.sessionId,
    );
  const action = await vi.waitFor(async () => {
    const target = await page.evaluate<{
      x: number;
      y: number;
    } | null>(`(() => {
      const item = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
        .find(node => node.checkVisibility() && node.textContent.trim() === '重命名任务');
      if (!item || item.getAttribute('aria-disabled') === 'true') return null;
      const rect = item.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      return hit && item.contains(hit) ? point : null;
    })()`);
    expect(target, JSON.stringify(page.pageErrors)).not.toBeNull();
    return target;
  });
  if (!action) throw new Error("原重命名任务菜单项尚未显示。");
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...action },
    page.target.sessionId,
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate("document.activeElement?.textContent?.trim()"),
    ).toBe("重命名任务"),
  );
  await pressKey(page.cdp, page.target.sessionId, "Enter");
  await visiblePoint(page, titleInput);
}

async function expectRenamed(
  surface: TaskGroupPublicPageContext,
  title: string,
) {
  const { host, page, snapshotBefore, scopeBefore, previewTitle } = surface;
  const after = await vi.waitFor(async () => {
    const current = protocol.conversationSnapshotSchema.parse(
      await host.snapshot(),
    );
    expect(current.meta).toMatchObject({ title, titleSource: "custom" });
    return current;
  });
  expect(after.sessionId).toBe(snapshotBefore.sessionId);
  expect(after.rows.window).toEqual(snapshotBefore.rows.window);
  expect(after.control).toEqual(snapshotBefore.control);
  expect(after.taskControl).toEqual(snapshotBefore.taskControl);
  expect(after.config).toEqual(snapshotBefore.config);
  expect(after.goal).toEqual(snapshotBefore.goal);
  expect(after.backgroundWorks).toEqual(snapshotBefore.backgroundWorks);
  expect(await readScope(host)).toEqual(scopeBefore);
  const meta = await host.client.request("/api/code-ui/rpc", {
    service: "zcode-task",
    method: "getTaskMeta",
    args: [{ taskId: host.sessionId, workspacePath: host.workspacePath }],
  });
  expect(meta.status, JSON.stringify(meta.body)).toBe(200);
  expect(meta.body.result).toMatchObject({
    taskId: host.sessionId,
    title,
    titleOverridden: true,
  });
  await vi.waitFor(async () => {
    expect(
      await page.evaluate(
        `document.querySelector(${JSON.stringify(titleInput)}) === null`,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        `document.querySelector('section[data-project-id=${JSON.stringify(host.projectId)}] [data-testid="task-item-${host.sessionId}"]')?.textContent`,
      ),
    ).toContain(title);
  });
  await expectContentPreserved(surface);
  const file = await host.client.request("/api/code-ui/rpc", {
    service: "file",
    method: "readTextFile",
    args: [
      {
        path: join(host.workspacePath, previewTitle),
        viewerScope: { kind: "task", taskId: host.sessionId },
      },
    ],
  });
  expect(file.status, JSON.stringify(file.body)).toBe(200);
  expect(file.body.result).toMatchObject({
    content: "任务改名保留原内容\n",
    truncated: false,
  });
  expect(surface.model.requests).toHaveLength(surface.modelRequestCountBefore);
}

/** 只持有首次原改名的实际响应，故障仅中断回包，不改状态码或响应内容。 */
async function holdRenameAck(page: OriginalSessionBrowser, taskId: string) {
  type HeldAck = {
    requestId: string;
    networkId: string;
    status: number;
    input: RenameRequest;
  };
  type ReadRequest = {
    requestId: string;
    rpc: z.infer<typeof rpcSchema>;
    afterFailure: boolean;
    status?: number;
    finished?: boolean;
  };
  const writes = new Map<string, RenameRequest>();
  const reads = new Map<string, ReadRequest>();
  const networkFailures = new Map<string, unknown>();
  const storageSnapshots: string[] = [];
  const failures: unknown[] = [];
  const continuations: Promise<unknown>[] = [];
  let held: HeldAck | undefined;
  let resolved = false;
  let lost = false;
  const send = (method: string, params: Record<string, unknown>) => {
    const operation = page.cdp.send(method, params, page.target.sessionId);
    continuations.push(operation);
    void operation.catch((cause: unknown) => failures.push(cause));
    return operation;
  };
  const offPaused = page.cdp.on("Fetch.requestPaused", (params, sessionId) => {
    if (
      sessionId !== page.target.sessionId ||
      typeof params.requestId !== "string"
    )
      return;
    try {
      const input = renameRequest(params.request);
      if (!held && input?.taskId === taskId && input.command) {
        held = {
          requestId: params.requestId,
          networkId: z.string().parse(params.networkId),
          status: z.number().parse(params.responseStatusCode),
          input,
        };
        return;
      }
    } catch (cause) {
      failures.push(cause);
    }
    void send("Fetch.continueResponse", { requestId: params.requestId });
  });
  const offRequested = page.cdp.on(
    "Network.requestWillBeSent",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      try {
        const input = renameRequest(params.request);
        if (input) writes.set(params.requestId, input);
        const request = z
          .object({ url: z.string(), postData: z.string().optional() })
          .parse(params.request);
        if (
          new URL(request.url).pathname !== "/api/code-ui/rpc" ||
          !request.postData
        )
          return;
        const rpc = rpcSchema.parse(JSON.parse(request.postData));
        if (
          (rpc.service === "zcodeAgentService" &&
            rpc.method === "queryConversationCommandsV4") ||
          (rpc.service === "zcode-task" && rpc.method === "getTaskMeta")
        )
          reads.set(params.requestId, {
            requestId: params.requestId,
            rpc,
            afterFailure: lost,
          });
      } catch (cause) {
        failures.push(cause);
      }
    },
  );
  const offResponse = page.cdp.on(
    "Network.responseReceived",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      const request = reads.get(params.requestId);
      if (!request) return;
      try {
        request.status = z
          .object({ status: z.number() })
          .parse(params.response).status;
      } catch (cause) {
        failures.push(cause);
      }
    },
  );
  const offFinished = page.cdp.on(
    "Network.loadingFinished",
    (params, sessionId) => {
      if (
        sessionId !== page.target.sessionId ||
        typeof params.requestId !== "string"
      )
        return;
      const request = reads.get(params.requestId);
      if (request) request.finished = true;
    },
  );
  const offFailed = page.cdp.on(
    "Network.loadingFailed",
    (params, sessionId) => {
      if (
        sessionId === page.target.sessionId &&
        typeof params.requestId === "string"
      )
        networkFailures.set(params.requestId, params);
    },
  );
  const captureStorage = (
    params: Record<string, unknown>,
    sessionId?: string,
  ) => {
    if (
      sessionId === page.target.sessionId &&
      params.key === "zcode-v4-pending-commands:v1" &&
      typeof params.newValue === "string"
    )
      storageSnapshots.push(params.newValue);
  };
  const offAdded = page.cdp.on(
    "DOMStorage.domStorageItemAdded",
    captureStorage,
  );
  const offUpdated = page.cdp.on(
    "DOMStorage.domStorageItemUpdated",
    captureStorage,
  );
  const releases = [
    offPaused,
    offRequested,
    offResponse,
    offFinished,
    offFailed,
    offAdded,
    offUpdated,
  ];
  try {
    await page.cdp.send("DOMStorage.enable", {}, page.target.sessionId);
    await page.cdp.send(
      "Fetch.enable",
      {
        patterns: [
          { urlPattern: "*/api/code-ui/rpc", requestStage: "Response" },
        ],
      },
      page.target.sessionId,
    );
  } catch (cause) {
    for (const release of releases) release();
    await page.cdp.send("DOMStorage.disable", {}, page.target.sessionId);
    throw cause;
  }
  const diagnostics = () =>
    JSON.stringify({
      writes: [...writes],
      reads: [...reads.values()],
      networkFailures: [...networkFailures.values()],
      failures: failures.map(String),
    });
  return {
    async waitForHeld() {
      const response = await vi.waitFor(
        () => {
          expect(failures, diagnostics()).toEqual([]);
          if (!held) throw new Error(`原改名响应尚未暂停：${diagnostics()}`);
          return held;
        },
        { timeout: 5_000 },
      );
      const payload = z
        .object({ body: z.string(), base64Encoded: z.boolean().optional() })
        .parse(
          await page.cdp.send(
            "Fetch.getResponseBody",
            { requestId: response.requestId },
            page.target.sessionId,
          ),
        );
      const body = JSON.parse(
        payload.base64Encoded
          ? Buffer.from(payload.body, "base64").toString("utf8")
          : payload.body,
      );
      expect(response.status, JSON.stringify({ response, body })).toBe(200);
      const ack = z
        .object({ result: protocol.commandAckSchema })
        .parse(body).result;
      const command = response.input.command;
      if (!command) throw new Error("暂停响应缺少原改名 Envelope。");
      expect(command).toMatchObject({
        type: "renameSession",
        sessionId: taskId,
      });
      expect(ack).toMatchObject({
        commandId: command.commandId,
        status: "accepted",
      });
      expect([...writes.keys()], diagnostics()).toEqual([response.networkId]);
      return { response, command, ack };
    },
    async expectPrivateSummary(
      command: protocol.CommandEnvelope,
      title: string,
    ) {
      await vi.waitFor(() => {
        const summaries = storageSnapshots.flatMap((raw) =>
          z
            .array(
              z.object({
                commandId: z.string(),
                sessionId: z.string().nullable(),
                replay: z.unknown(),
              }),
            )
            .parse(JSON.parse(raw))
            .filter((entry) => entry.commandId === command.commandId),
        );
        expect(
          summaries.length,
          JSON.stringify(storageSnapshots),
        ).toBeGreaterThan(0);
        for (const raw of storageSnapshots) expect(raw).not.toContain(title);
        for (const summary of summaries) {
          expect(summary.sessionId).toBe(command.sessionId);
          expect(
            z
              .object({
                kind: z.literal("sensitiveDigest"),
                type: z.literal("renameSession"),
                digest: z.string().min(1),
              })
              .strict()
              .parse(summary.replay),
          ).toMatchObject({ kind: "sensitiveDigest", type: "renameSession" });
          expect(JSON.stringify(summary)).not.toContain(title);
        }
      });
    },
    async loseResponse() {
      if (!held) throw new Error("原改名响应尚未暂停。");
      const response = held;
      resolved = true;
      lost = true;
      await send("Fetch.failRequest", {
        requestId: response.requestId,
        errorReason: "ConnectionReset",
      });
      await vi.waitFor(() => {
        expect(failures, diagnostics()).toEqual([]);
        expect(
          networkFailures.get(response.networkId),
          diagnostics(),
        ).toMatchObject({
          errorText: expect.any(String),
        });
      });
    },
    async expectRecovered(
      command: protocol.CommandEnvelope,
      ack: protocol.CommandAck,
      title: string,
    ) {
      const recovered = await vi.waitFor(
        () => {
          expect(failures, diagnostics()).toEqual([]);
          const queries = [...reads.values()].filter(
            (entry) =>
              entry.afterFailure &&
              entry.finished &&
              entry.rpc.method === "queryConversationCommandsV4",
          );
          const metas = [...reads.values()].filter(
            (entry) =>
              entry.afterFailure &&
              entry.finished &&
              entry.rpc.method === "getTaskMeta" &&
              z.object({ taskId: z.string() }).parse(entry.rpc.args[0])
                .taskId === taskId,
          );
          expect(queries.length, diagnostics()).toBeGreaterThan(0);
          expect(metas.length, diagnostics()).toBeGreaterThan(0);
          return { queries, metas };
        },
        { timeout: 5_000 },
      );
      const key = {
        sessionId: command.sessionId,
        commandId: command.commandId,
      };
      for (const query of recovered.queries) {
        expect(query.status, diagnostics()).toBe(200);
        expect(
          z.object({ commands: z.array(z.unknown()) }).parse(query.rpc.args[0])
            .commands,
        ).toEqual([key]);
        const body: unknown = await readResponse(page, query.requestId);
        const result = z
          .object({ result: protocol.commandsQueryResultSchema })
          .parse(body).result;
        expect(result.results).toContainEqual({ key, result: ack });
      }
      for (const read of recovered.metas) {
        expect(read.status, diagnostics()).toBe(200);
        const body: unknown = await readResponse(page, read.requestId);
        expect(
          z.object({ result: z.unknown() }).parse(body).result,
        ).toMatchObject({ taskId, title });
      }
      expect(writes.size, diagnostics()).toBe(1);
      expect([...writes.values()][0]?.command).toEqual(command);
    },
    async close() {
      for (const close of [
        () =>
          held && !resolved
            ? send("Fetch.continueResponse", { requestId: held.requestId })
            : undefined,
        () => Promise.all(continuations),
        () => page.cdp.send("Fetch.disable", {}, page.target.sessionId),
        () => page.cdp.send("DOMStorage.disable", {}, page.target.sessionId),
      ]) {
        try {
          await close();
        } catch (cause) {
          failures.push(cause);
        }
      }
      for (const release of releases) release();
      if (failures.length)
        throw new AggregateError(failures, "原改名未知回执观察未关闭");
    },
  };
}

async function expectNoInputRecovery(
  page: OriginalSessionBrowser,
  commandId: string,
) {
  await vi.waitFor(async () => {
    const state = await page.evaluate(`(() => {
      const raw = localStorage.getItem('zcode-v4-pending-commands:v1');
      const entries = raw ? JSON.parse(raw) : [];
      return {
        pending: entries.filter(entry => entry.commandId === ${JSON.stringify(commandId)}),
        banners: Array.from(document.querySelectorAll('[role="status"]'))
          .filter(element => element.checkVisibility() && element.textContent.includes('CLI 重启前已提交的输入没有进入对话'))
          .map(element => element.textContent),
        resend: Array.from(document.querySelectorAll('button'))
          .filter(element => element.checkVisibility() && element.textContent.trim() === '重新发送').length,
      };
    })()`);
    expect(state, JSON.stringify(state)).toEqual({
      pending: [],
      banners: [],
      resend: 0,
    });
  });
}

async function openHeaderRename(surface: TaskGroupPublicPageContext) {
  const { page, host } = surface;
  const selector =
    '[data-testid="workspace-header"] [data-testid="workspace-more-button"]';
  await vi.waitFor(async () =>
    expect(
      await page.evaluate(`(() => {
        const buttons = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
          .filter(button => button.checkVisibility());
        const input = document.querySelector(${JSON.stringify(inputSelector)});
        return { count: buttons.length, disabled: buttons[0]?.disabled,
          taskId: input?.closest('[data-session-id]')?.getAttribute('data-session-id') };
      })()`),
      JSON.stringify(page.pageErrors),
    ).toEqual({ count: 1, disabled: false, taskId: host.sessionId }),
  );
  await clickOn(
    page.cdp,
    page.target.sessionId,
    await visiblePoint(page, selector),
  );
  const action = await vi.waitFor(async () => {
    const point = await page.evaluate<{
      x: number;
      y: number;
    } | null>(`(() => {
      const item = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
        .find(node => node.checkVisibility() && node.textContent.trim() === '重命名任务');
      if (!item || item.getAttribute('aria-disabled') === 'true') return null;
      const rect = item.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      return hit && item.contains(hit) ? point : null;
    })()`);
    expect(point, JSON.stringify(page.pageErrors)).not.toBeNull();
    return point;
  });
  if (!action) throw new Error("原 Header 重命名任务菜单项尚未显示。");
  await page.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", ...action },
    page.target.sessionId,
  );
  await vi.waitFor(async () =>
    expect(
      await page.evaluate("document.activeElement?.textContent?.trim()"),
    ).toBe("重命名任务"),
  );
  await pressKey(page.cdp, page.target.sessionId, "Enter");
  await visiblePoint(page, titleInput);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原 Task 改名的 Root、HTTP、SSE 与 PostgreSQL integration",
  () => {
    it("原侧栏重命名中文标题持久为custom，原Task正文、运行、草稿、内容和权限保持", async () => {
      await withProjectionResources(async (context) => {
        const { fixture, session } = context;
        const previewTitle = "任务改名保留内容.txt";
        const previewPath = join(session.workspacePath, previewTitle);
        await writeFile(previewPath, "任务改名保留原内容\n", "utf8");
        const page = await openOriginalSessionBrowser({
          backendBaseUrl: fixture.baseUrl,
          backendOrigin: fixture.origin,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
          workspacePath: session.workspacePath,
          projectId: session.projectId,
          sessionId: session.sessionId,
          clientId: session.clientId,
          workspaceShell: true,
          beforeNavigate: async ({ cdp, target }) => {
            const preference = JSON.stringify({
              view: "projects",
              order: [],
              expanded: {},
            });
            await cdp.send(
              "Page.addScriptToEvaluateOnNewDocument",
              {
                source: `localStorage.setItem("zcode-project-sidebar-preferences", ${JSON.stringify(preference)});`,
              },
              target.sessionId,
            );
          },
        });
        const failures: unknown[] = [];
        try {
          const surface = await prepareContent(
            context,
            page,
            previewPath,
            previewTitle,
          );
          expect(surface.snapshotBefore.control.phase).toBe("completedSuccess");
          await expectContentPreserved(surface);
          await openRename(surface);
          const title = "原侧栏中文任务名称已保存";
          await clickOn(page.cdp, page.target.sessionId, {
            selector: titleInput,
          });
          await selectAll(page);
          await typeText(page.cdp, page.target.sessionId, title);
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(
                `document.querySelector(${JSON.stringify(titleInput)})?.value`,
              ),
            ).toBe(title),
          );
          const network = observeRename(page, session.sessionId);
          try {
            await clickExactText(page, '[role="dialog"] button', "确认");
            const response = await network.wait();
            expect(response).toMatchObject({
              taskId: session.sessionId,
              title,
            });
            await expectRenamed(surface, title);
          } finally {
            network.close();
          }
        } catch (cause) {
          failures.push(cause);
        } finally {
          try {
            await page.close();
          } catch (cause) {
            failures.push(cause);
          }
        }
        if (failures.length)
          throw new AggregateError(
            failures,
            "原 Task 改名验证或浏览器关闭失败",
            {
              cause: failures[0],
            },
          );
      });
    }, 180_000); // 原Root、实际改名HTTP回执、SSE、临时PG与全部资源关闭期限。

    it("真实改名200回包未知后仅查询原命令，标题持久且只有一次写入并不出现输入恢复", async () => {
      await withProjectionResources(async (context) => {
        const { fixture, session } = context;
        const previewTitle = "任务改名保留内容.txt";
        const previewPath = join(session.workspacePath, previewTitle);
        await writeFile(previewPath, "任务改名保留原内容\n", "utf8");
        const page = await openOriginalSessionBrowser({
          backendBaseUrl: fixture.baseUrl,
          backendOrigin: fixture.origin,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
          workspacePath: session.workspacePath,
          projectId: session.projectId,
          sessionId: session.sessionId,
          clientId: session.clientId,
          workspaceShell: true,
          beforeNavigate: async ({ cdp, target }) => {
            const preference = JSON.stringify({
              view: "projects",
              order: [],
              expanded: {},
            });
            await cdp.send(
              "Page.addScriptToEvaluateOnNewDocument",
              {
                source: `localStorage.setItem("zcode-project-sidebar-preferences", ${JSON.stringify(preference)});`,
              },
              target.sessionId,
            );
          },
        });
        const failures: unknown[] = [];
        try {
          const surface = await prepareContent(
            context,
            page,
            previewPath,
            previewTitle,
          );
          await expectContentPreserved(surface);
          await openRename(surface);
          const title = "未知回执仍只保存一次的中文任务名称";
          await clickOn(page.cdp, page.target.sessionId, {
            selector: titleInput,
          });
          await selectAll(page);
          await typeText(page.cdp, page.target.sessionId, title);
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(
                `document.querySelector(${JSON.stringify(titleInput)})?.value`,
              ),
            ).toBe(title),
          );
          const pending = await holdRenameAck(page, session.sessionId);
          try {
            await clickExactText(page, '[role="dialog"] button', "确认");
            const first = await pending.waitForHeld();
            expect(first.command.taskControl).toEqual(
              surface.snapshotBefore.taskControl,
            );
            expect(
              protocol.commandPayloadSchemas.renameSession.parse(
                first.command.payload,
              ),
            ).toEqual({ title });
            await pending.expectPrivateSummary(first.command, title);
            const saved = protocol.conversationSnapshotSchema.parse(
              await session.snapshot(),
            );
            expect(saved.meta).toMatchObject({ title, titleSource: "custom" });
            await expectContentPreserved(surface);
            await pending.loseResponse();
            await expectRenamed(surface, title);
            await pending.expectRecovered(first.command, first.ack, title);
            await expectNoInputRecovery(page, first.command.commandId);
          } finally {
            await pending.close();
          }
        } catch (cause) {
          failures.push(cause);
        } finally {
          try {
            await page.close();
          } catch (cause) {
            failures.push(cause);
          }
        }
        if (failures.length)
          throw new AggregateError(
            failures,
            "原 Task 改名未知回执验证或浏览器关闭失败",
            { cause: failures[0] },
          );
      });
    }, 180_000); // 原Root、真实200响应连接故障、原命令查询与资源关闭期限。

    it("原Header更多菜单改名经同一V4桥持久custom标题，原正文、权限和当前内容保持", async () => {
      await withProjectionResources(async (context) => {
        const { fixture, session } = context;
        const previewTitle = "任务改名保留内容.txt";
        const previewPath = join(session.workspacePath, previewTitle);
        await writeFile(previewPath, "任务改名保留原内容\n", "utf8");
        const page = await openOriginalSessionBrowser({
          backendBaseUrl: fixture.baseUrl,
          backendOrigin: fixture.origin,
          accessToken: await fixture.app.kernel
            .get("localAccess")
            .getDesktopToken(),
          workspacePath: session.workspacePath,
          projectId: session.projectId,
          sessionId: session.sessionId,
          clientId: session.clientId,
          workspaceShell: true,
          beforeNavigate: async ({ cdp, target }) => {
            const preference = JSON.stringify({
              view: "projects",
              order: [],
              expanded: {},
            });
            await cdp.send(
              "Page.addScriptToEvaluateOnNewDocument",
              {
                source: `localStorage.setItem("zcode-project-sidebar-preferences", ${JSON.stringify(preference)});`,
              },
              target.sessionId,
            );
          },
        });
        const failures: unknown[] = [];
        try {
          const surface = await prepareContent(
            context,
            page,
            previewPath,
            previewTitle,
          );
          expect(surface.snapshotBefore.control.phase).toBe("completedSuccess");
          await expectContentPreserved(surface);
          await openHeaderRename(surface);
          const title = "原Header中文任务名称已保存";
          await clickOn(page.cdp, page.target.sessionId, {
            selector: titleInput,
          });
          await selectAll(page);
          await typeText(page.cdp, page.target.sessionId, title);
          await vi.waitFor(async () =>
            expect(
              await page.evaluate(
                `document.querySelector(${JSON.stringify(titleInput)})?.value`,
              ),
            ).toBe(title),
          );
          const network = observeRename(page, session.sessionId);
          try {
            await clickExactText(page, '[role="dialog"] button', "确认");
            const response = await network.wait();
            expect(response).toMatchObject({
              service: "zcodeAgentService",
              method: "sendConversationCommandV4",
              taskId: session.sessionId,
              title,
            });
            expect(response.command).toMatchObject({
              type: "renameSession",
              sessionId: session.sessionId,
              taskControl: surface.snapshotBefore.taskControl,
            });
            await expectRenamed(surface, title);
            await vi.waitFor(
              async () =>
                expect(
                  await page.evaluate(
                    'document.querySelector("[data-testid=workspace-header] [data-testid=workspace-title]")?.getAttribute("title")',
                  ),
                ).toBe(title),
              { timeout: 30_000 },
            );
          } finally {
            network.close();
          }
        } catch (cause) {
          failures.push(cause);
        } finally {
          try {
            await page.close();
          } catch (cause) {
            failures.push(cause);
          }
        }
        if (failures.length)
          throw new AggregateError(
            failures,
            "原 Header 改名验证或浏览器关闭失败",
            {
              cause: failures[0],
            },
          );
      });
    }, 180_000); // 原Header消费者、真实V4改名、HTTP/SSE/临时PG与资源关闭期限。
  },
);
