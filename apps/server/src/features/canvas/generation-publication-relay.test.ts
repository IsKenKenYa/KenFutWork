import { randomUUID } from "node:crypto";
import { backgroundJobSchema } from "@kenfutwork/shared";
import { expect, it, vi } from "vitest";
import {
  CANVAS_DOCUMENT_NOTIFICATION_CHANNEL,
  CANVAS_GENERATION_NOTIFICATION_CHANNEL,
  createCanvasPublicationRelay,
} from "./generation-publication-relay.js";

function fixture() {
  const canvasId = randomUUID(),
    projectId = randomUUID(),
    jobId = randomUUID(),
    instanceId = randomUUID();
  const job = backgroundJobSchema.parse({
    id: jobId,
    instance_id: instanceId,
    project_id: projectId,
    session_id: null,
    canvas_id: canvasId,
    thread_id: null,
    file_target: { kind: "project", projectId, sessionId: null, canvasId },
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "succeeded",
    payload: {},
    result: { element_id: "actual-element" },
    error_code: null,
    error_message: null,
    provider_job_id: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by_client_id: null,
    created_at: "now",
    updated_at: "now",
    started_at: "now",
    completed_at: "now",
    failed_at: null,
    canceled_at: null,
  });
  const listeners = new Map<string, (payload: string) => void>();
  const controllers = new Map<string, AbortController>();
  const subscribe = vi.fn(
    async (channel: string, listener: (payload: string) => void) => {
      listeners.set(channel, listener);
      const controller = new AbortController();
      controllers.set(channel, controller);
      return {
        signal: controller.signal,
        release: async () => {
          controller.abort();
        },
      };
    },
  );
  const target = {
    instance_id: instanceId,
    project_id: projectId,
    deleted_at: null as string | null,
  };
  const getCanvas = vi.fn(async () => ({
    id: canvasId,
    name: "文档",
    projectId,
    revision: "a".repeat(64),
    content: { elements: [{ id: "actual-element" }], files: {}, appState: {} },
  }));
  const push = vi.fn(),
    sse = vi.fn(async () => {}),
    report = vi.fn();
  const relay = createCanvasPublicationRelay({
    persistence: { subscribeNotifications: subscribe },
    jobs: { getJobForWorker: async () => job },
    canvas: { getCanvas },
    canvases: { notificationTarget: async () => target },
    connections: { sendCanvasDocumentUpdatedToInstance: push },
    codeUi: { notifyCanvasDocumentUpdated: sse },
    reportError: report,
  });
  return {
    relay,
    subscribe,
    getCanvas,
    push,
    sse,
    report,
    job,
    target,
    instanceId,
    canvasId,
    projectId,
    notify: (channel = CANVAS_GENERATION_NOTIFICATION_CHANNEL) =>
      listeners.get(channel)?.(
        channel === CANVAS_GENERATION_NOTIFICATION_CHANNEL ? jobId : canvasId,
      ),
    lose: (channel = CANVAS_DOCUMENT_NOTIFICATION_CHANNEL) =>
      controllers.get(channel)?.abort(new Error("连接丢失")),
  };
}

it("独立worker终态通知只发送权威资源更新，重复通知不生成Run事件或重放写入", async () => {
  const f = fixture();
  await f.relay.start();
  f.notify();
  f.notify();
  await vi.waitFor(() => expect(f.push).toHaveBeenCalledTimes(2));
  expect(f.push).toHaveBeenCalledWith(f.instanceId, {
    type: "canvas.document.updated",
    canvasId: f.canvasId,
    projectId: f.projectId,
    deleted: false,
    revision: "a".repeat(64),
  });
  expect(f.sse).toHaveBeenCalledTimes(2);
  expect(f.getCanvas).toHaveBeenCalledTimes(2);
  expect(f.report).not.toHaveBeenCalled();
  await f.relay.close();
});

it("创建和编辑通知到达无画布订阅的实例连接，软删除仍能通知且不再读文件", async () => {
  const f = fixture();
  await f.relay.start();
  f.notify(CANVAS_DOCUMENT_NOTIFICATION_CHANNEL);
  await vi.waitFor(() => expect(f.sse).toHaveBeenCalledTimes(1));
  f.target.deleted_at = "deleted";
  f.notify(CANVAS_DOCUMENT_NOTIFICATION_CHANNEL);
  await vi.waitFor(() => expect(f.sse).toHaveBeenCalledTimes(2));
  expect(f.push).toHaveBeenLastCalledWith(f.instanceId, {
    type: "canvas.document.updated",
    canvasId: f.canvasId,
    projectId: f.projectId,
    deleted: true,
  });
  expect(f.getCanvas).toHaveBeenCalledTimes(1);
  await f.relay.close();
});

it("成果元素已被删除、跨项目或Job取消时不发送成果更新", async () => {
  const f = fixture();
  f.getCanvas.mockResolvedValueOnce({
    id: f.canvasId,
    name: "文档",
    projectId: f.projectId,
    revision: "a".repeat(64),
    content: { elements: [], files: {}, appState: {} },
  });
  await f.relay.start();
  f.notify();
  await vi.waitFor(() => expect(f.getCanvas).toHaveBeenCalledTimes(1));
  expect(f.push).not.toHaveBeenCalled();
  f.target.project_id = randomUUID();
  f.notify();
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledTimes(1));
  f.job.status = "canceled";
  f.notify();
  await f.relay.close();
  expect(f.push).not.toHaveBeenCalled();
});

it("两个通知连接独立恢复，关闭后不再发送或重连", async () => {
  const f = fixture();
  await f.relay.start();
  expect(f.subscribe).toHaveBeenCalledTimes(2);
  f.lose();
  await vi.waitFor(() => expect(f.subscribe).toHaveBeenCalledTimes(3));
  f.notify(CANVAS_DOCUMENT_NOTIFICATION_CHANNEL);
  await vi.waitFor(() => expect(f.push).toHaveBeenCalledTimes(1));
  await f.relay.close();
  f.notify();
  f.lose();
  expect(f.subscribe).toHaveBeenCalledTimes(3);
  expect(f.push).toHaveBeenCalledTimes(1);
});
