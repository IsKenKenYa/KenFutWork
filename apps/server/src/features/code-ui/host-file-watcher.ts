import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  type CodeUiViewerScope,
  codeUiViewerScopeSchema,
} from "@kenfutwork/shared";
import type { FileWatchEvent } from "@zcode/shared";
import { z } from "zod";
import type { LocalActor } from "../local-instance/types.js";
import type {
  CodeUiHostConnection,
  CodeUiHostTarget,
} from "./host-service-rpc.js";

export interface CodeUiWatchTarget extends CodeUiHostTarget {
  path: string;
  /** Task授权代际；Project预览不伪造Task代际。 */
  generation?: number;
}
interface WatchEntry {
  id: string;
  actor: LocalActor;
  connection: CodeUiHostConnection;
  target: CodeUiWatchTarget;
  watcher: FSWatcher;
  active: boolean;
  refreshing: boolean;
  dirty: boolean;
  closed: Promise<void>;
}
export interface CodeUiFileWatchers {
  call(
    actor: LocalActor,
    method: string,
    args: unknown[],
    connection: CodeUiHostConnection,
  ): Promise<{ result: unknown } | null>;
  closeConnection(instanceId: string, connectionId: string): Promise<void>;
  closeTask(instanceId: string, taskId: string): Promise<void>;
  close(): Promise<void>;
}
const watchParams = z.object({
  path: z.string().min(1),
  recursive: z.boolean().optional(),
  viewerScope: codeUiViewerScopeSchema,
});
const idParams = z.object({ id: z.string().min(1) });

/** 只读Human watcher：事件不提供文件内容或Native Read observation。 */
export function createCodeUiFileWatchers(deps: {
  assertConnection(connection: CodeUiHostConnection): void;
  resolveTarget(
    actor: LocalActor,
    viewer: CodeUiViewerScope,
    path: string,
  ): Promise<CodeUiWatchTarget>;
  send(
    connection: CodeUiHostConnection,
    id: string,
    data: FileWatchEvent,
  ): Promise<void>;
}): CodeUiFileWatchers {
  const entries = new Map<string, WatchEntry>();
  const pending = new Set<{
    connection: CodeUiHostConnection;
    viewer: CodeUiViewerScope;
    cancelled: boolean;
  }>();
  let closed = false;
  const stop = async (entry: WatchEntry) => {
    if (entry.active) {
      entry.active = false;
      entries.delete(entry.id);
      entry.watcher.close();
    }
    await entry.closed;
  };
  const requireConnection = (
    actor: LocalActor,
    connection: CodeUiHostConnection,
  ) => {
    if (
      closed ||
      !connection.connectionId ||
      actor.instanceId !== connection.instanceId
    )
      throw new Error("文件监视连接已关闭或不属于当前用户。");
    deps.assertConnection(connection);
  };
  const refresh = async (entry: WatchEntry) => {
    if (!entry.active) return;
    entry.dirty = true;
    if (entry.refreshing) return;
    entry.refreshing = true;
    try {
      while (entry.active && entry.dirty) {
        entry.dirty = false;
        requireConnection(entry.actor, entry.connection);
        const current = await deps.resolveTarget(
          entry.actor,
          entry.target.viewerScope,
          entry.target.path,
        );
        if (
          current.instanceId !== entry.connection.instanceId ||
          current.path !== entry.target.path ||
          current.rootDirectory !== entry.target.rootDirectory ||
          current.generation !== entry.target.generation ||
          current.projectId !== entry.target.projectId
        )
          throw new Error("文件监视目标或授权代际已变化。");
        if (entry.active)
          await deps.send(entry.connection, entry.id, {
            dirPath: entry.target.path,
          });
      }
    } catch {
      await stop(entry);
    } finally {
      entry.refreshing = false;
    }
  };
  const closeMatching = async (
    match: (
      connection: CodeUiHostConnection,
      viewer: CodeUiViewerScope,
    ) => boolean,
  ) => {
    for (const item of pending)
      if (match(item.connection, item.viewer)) item.cancelled = true;
    await Promise.all(
      [...entries.values()]
        .filter((entry) => match(entry.connection, entry.target.viewerScope))
        .map(stop),
    );
  };
  return {
    async call(actor, method, args, connection) {
      if (!["watch", "unwatch", "disposeAll"].includes(method)) return null;
      requireConnection(actor, connection);
      if (method === "disposeAll") {
        await closeMatching(
          (owner) =>
            owner.instanceId === connection.instanceId &&
            owner.connectionId === connection.connectionId,
        );
        return { result: undefined };
      }
      if (method === "unwatch") {
        const { id } = idParams.parse(args[0]);
        const entry = entries.get(id);
        if (
          entry &&
          (entry.connection.instanceId !== connection.instanceId ||
            entry.connection.connectionId !== connection.connectionId)
        )
          throw new Error("文件监视不属于当前连接。");
        if (entry) await stop(entry);
        return { result: undefined };
      }
      const params = watchParams.parse(args[0]);
      const reservation = {
        connection,
        viewer: params.viewerScope,
        cancelled: false,
      };
      pending.add(reservation);
      try {
        const target = await deps.resolveTarget(
          actor,
          params.viewerScope,
          params.path,
        );
        requireConnection(actor, connection);
        if (
          reservation.cancelled ||
          target.instanceId !== connection.instanceId
        )
          throw new Error("文件监视启动期间连接或Task已关闭。");
        const watcher = watch(target.path, {
          recursive: params.recursive ?? false,
        });
        const id = randomUUID();
        const entry: WatchEntry = {
          id,
          actor,
          connection,
          target,
          watcher,
          active: true,
          refreshing: false,
          dirty: false,
          closed: new Promise<void>((resolve) =>
            watcher.once("close", resolve),
          ),
        };
        entries.set(id, entry);
        watcher.once("close", () => {
          entry.active = false;
          entries.delete(id);
        });
        watcher.on("change", (_event, filename) => {
          // 仅触发目录刷新；filename无法确认canonical目标时不签发changedPath。
          const changed = filename
            ? join(target.path, filename.toString())
            : target.path;
          const tail = relative(target.path, changed);
          if (
            isAbsolute(tail) ||
            tail === ".." ||
            tail.startsWith("../") ||
            tail.startsWith("..\\")
          )
            return;
          void refresh(entry);
        });
        watcher.on("error", () => {
          void stop(entry);
        });
        return { result: { id } };
      } finally {
        pending.delete(reservation);
      }
    },
    closeConnection: (instanceId, connectionId) =>
      closeMatching(
        (owner) =>
          owner.instanceId === instanceId &&
          owner.connectionId === connectionId,
      ),
    closeTask: (instanceId, taskId) =>
      closeMatching(
        (owner, viewer) =>
          owner.instanceId === instanceId &&
          viewer.kind === "task" &&
          viewer.taskId === taskId,
      ),
    async close() {
      closed = true;
      await closeMatching(() => true);
    },
  };
}
