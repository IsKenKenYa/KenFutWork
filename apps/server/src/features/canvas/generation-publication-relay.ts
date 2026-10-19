import { setTimeout as delay } from "node:timers/promises";
import {
  type CanvasDocumentUpdatedMessage,
  generationFileTargetSchema,
} from "@kenfutwork/shared";
import { z } from "zod";
import type { PluginDefinition } from "../../kernel/types.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
import type { CodeUiService } from "../code-ui/service.js";
import type { JobService } from "../jobs/job-service.js";
import type {
  PersistenceService,
  PersistenceSessionLock,
} from "../persistence/types.js";
import type { CanvasService } from "./canvas-service.js";
import { type CanvasRepository, createCanvasRepository } from "./repository.js";

export const CANVAS_GENERATION_NOTIFICATION_CHANNEL =
  "kenfutwork_generation_complete";
export const CANVAS_DOCUMENT_NOTIFICATION_CHANNEL = "kenfutwork_canvas_changed";
export interface CanvasPublicationRelay {
  start(): Promise<void>;
  close(): Promise<void>;
}

/** 通知只唤醒资源重读，不生成Agent事件或重放文档写入。 */
export function createCanvasPublicationRelay(deps: {
  persistence: Pick<PersistenceService, "subscribeNotifications">;
  jobs: Pick<JobService, "getJobForWorker">;
  canvas: Pick<CanvasService, "getCanvas">;
  canvases: Pick<CanvasRepository, "notificationTarget">;
  connections: Pick<ConnectionManager, "sendCanvasDocumentUpdatedToInstance">;
  codeUi: Pick<CodeUiService, "notifyCanvasDocumentUpdated">;
  reportError(error: unknown): void;
}): CanvasPublicationRelay {
  const stopped = new AbortController();
  const subscriptions = new Map<string, PersistenceSessionLock>();
  const reconnecting = new Map<string, Promise<void>>();
  let starting: Promise<void> | undefined;
  let pending = Promise.resolve();

  async function broadcast(
    canvasId: string,
    expectedProjectId?: string,
    expectedElementId?: string,
  ) {
    const target = await deps.canvases.notificationTarget(canvasId);
    if (!target || stopped.signal.aborted) return;
    if (expectedProjectId && target.project_id !== expectedProjectId)
      throw new Error("后台成果与画布项目不一致。");
    let revision: string | undefined;
    if (!target.deleted_at) {
      const canvas = await deps.canvas.getCanvas(
        { instanceId: target.instance_id, accessClientId: null },
        canvasId,
      );
      if (canvas.projectId !== target.project_id)
        throw new Error("画布文档归属已改变。");
      if (
        expectedElementId &&
        !canvas.content.elements.some(
          (element) => element.id === expectedElementId && !element.isDeleted,
        )
      )
        return;
      revision = canvas.revision;
    }
    if (stopped.signal.aborted) return;
    const message: CanvasDocumentUpdatedMessage = {
      type: "canvas.document.updated",
      canvasId,
      projectId: target.project_id,
      deleted: Boolean(target.deleted_at),
      ...(revision ? { revision } : {}),
    };
    deps.connections.sendCanvasDocumentUpdatedToInstance(
      target.instance_id,
      message,
    );
    await deps.codeUi.notifyCanvasDocumentUpdated(target.instance_id, message);
  }
  async function synchronize(channel: string, payload: string) {
    if (stopped.signal.aborted) return;
    const id = z.uuid().safeParse(payload);
    if (!id.success) throw new Error("画布更新通知缺少有效资源标识。");
    if (channel === CANVAS_DOCUMENT_NOTIFICATION_CHANNEL)
      return broadcast(id.data);
    const job = await deps.jobs.getJobForWorker(id.data);
    if (
      job.status !== "succeeded" ||
      typeof job.result?.element_id !== "string"
    )
      return;
    const target = generationFileTargetSchema.parse(job.file_target);
    if (target.kind !== "standalone" && target.canvasId)
      await broadcast(target.canvasId, target.projectId, job.result.element_id);
  }
  async function listen(channel: string) {
    const opened = await deps.persistence.subscribeNotifications(
      channel,
      (payload) => {
        pending = pending
          .then(() => synchronize(channel, payload))
          .catch(deps.reportError);
      },
    );
    if (stopped.signal.aborted) {
      await opened.release();
      return;
    }
    if (opened.signal.aborted) {
      await opened.release();
      throw opened.signal.reason;
    }
    subscriptions.set(channel, opened);
    opened.signal.addEventListener(
      "abort",
      () => {
        if (stopped.signal.aborted || reconnecting.has(channel)) return;
        deps.reportError(opened.signal.reason);
        const retry = (async () => {
          await opened.release();
          while (!stopped.signal.aborted) {
            try {
              await listen(channel);
              return;
            } catch (error) {
              deps.reportError(error);
            }
            await delay(1000, undefined, { signal: stopped.signal }).catch(
              () => {},
            );
          }
        })().finally(() => {
          reconnecting.delete(channel);
        });
        reconnecting.set(channel, retry);
      },
      { once: true },
    );
  }
  return {
    start() {
      starting ??= (async () => {
        try {
          await listen(CANVAS_DOCUMENT_NOTIFICATION_CHANNEL);
          await listen(CANVAS_GENERATION_NOTIFICATION_CHANNEL);
        } catch (error) {
          stopped.abort();
          await Promise.all(
            [...subscriptions.values()].map((subscription) =>
              subscription.release(),
            ),
          );
          throw error;
        }
      })();
      return starting;
    },
    async close() {
      stopped.abort();
      await starting?.catch(() => {});
      await Promise.all(
        [...subscriptions.values()].map((subscription) =>
          subscription.release(),
        ),
      );
      await Promise.all(reconnecting.values());
      await pending;
    },
  };
}

export function createCanvasPublicationRelayPlugin(): PluginDefinition {
  return {
    name: "canvas:publication-relay",
    enabled: (env) => Boolean(env.databaseUrl),
    inject: ["persistence", "jobs", "canvas", "ws", "codeUi"],
    apply() {},
    mounted(ctx) {
      const relay = createCanvasPublicationRelay({
        persistence: ctx.get("persistence"),
        jobs: ctx.get("jobs"),
        canvas: ctx.get("canvas"),
        canvases: createCanvasRepository(ctx.get("persistence")),
        connections: ctx.get("ws").connectionManager,
        codeUi: ctx.get("codeUi"),
        reportError: (error) =>
          ctx.app.log.error({ err: error }, "画布更新同步失败"),
      });
      ctx.app.addHook("onReady", () => relay.start());
      ctx.effect(() => () => relay.close());
    },
  };
}
