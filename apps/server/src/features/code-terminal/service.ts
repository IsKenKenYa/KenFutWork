import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import {
  detectTerminalShells,
  resolveTerminalShell,
} from "../code-git/terminal-runner.js";
import { interactiveInvocation } from "../code-git/terminal-session.js";
import { parameterFingerprint } from "../execution/parameter-fingerprint.js";
import type {
  ExecutionScopeHandle,
  ExecutionScopes,
} from "../execution/scope-service.js";
import type {
  ManagedTerminalProcess,
  ProcessSandbox,
  ProcessExit,
} from "../process-sandbox/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import type {
  CodeTerminalService,
  TerminalOpenRequest,
  TerminalOpenResult,
  TerminalSubscriber,
} from "./types.js";

export class CodeTerminalError extends Error {
  constructor(
    readonly code:
      | "closed"
      | "not_found"
      | "conflict"
      | "unavailable"
      | "stop_unconfirmed",
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
interface TerminalRecord {
  workspaceId: string;
  userId: string;
  connectionId: string;
  id: string;
  request: TerminalOpenRequest;
  fingerprint: string;
  closing: boolean;
  ready: Promise<TerminalOpenResult>;
  scope?: ExecutionScopeHandle;
  process?: ManagedTerminalProcess;
  stopping?: Promise<void>;
  subscriber?: TerminalSubscriber;
  unsubscribe?: () => void;
  delivery: Promise<void>;
  exit?: ProcessExit;
  exitDelivered: boolean;
  ordinal: number;
}

/** 人类终端没有假的Run/tool-call；Task域与连接各自拥有明确关闭责任。 */
export function createCodeTerminalService(deps: {
  scopes: ExecutionScopes;
  sandbox: ProcessSandbox;
  viewer: Pick<ViewerService, "resolveWorkspace">;
  settings: Pick<SettingsService, "getWorkspaceSettings">;
}): CodeTerminalService {
  const records = new Map<string, TerminalRecord>();
  const closedConnections = new Set<string>();
  let closed = false;
  let ordinal = 0;
  const ownerKey = (workspaceId: string, connectionId: string) =>
    JSON.stringify([workspaceId, connectionId]);
  const key = (workspaceId: string, connectionId: string, id: string) =>
    JSON.stringify([workspaceId, connectionId, id]);
  const ensureOpen = (record: TerminalRecord) => {
    if (
      closed ||
      record.closing ||
      closedConnections.has(ownerKey(record.workspaceId, record.connectionId))
    )
      throw new CodeTerminalError(
        "closed",
        "终端连接或Task已关闭，拒绝迟到启动。",
      );
  };
  const owned = async (
    actor: AuthenticatedUser,
    connectionId: string,
    id: string,
  ) => {
    const workspace = await deps.viewer.resolveWorkspace(actor);
    const record = records.get(key(workspace.id, connectionId, id));
    if (!record || record.userId !== actor.id)
      throw new CodeTerminalError("not_found", "终端不属于当前用户连接。", 404);
    return record;
  };
  const stopRecord = (
    record: TerminalRecord,
    reason: string,
  ): Promise<void> => {
    record.closing = true;
    if (record.stopping) return record.stopping;
    record.stopping = (async () => {
      try {
        await record.ready;
      } catch {
        if (!record.process) return;
      }
      if (!record.process) return;
      const exit = await record.process.stop(reason);
      if (!exit.rangeEmpty)
        throw new CodeTerminalError(
          "stop_unconfirmed",
          "终端的执行范围尚未确认清空。",
        );
      // 保留同一连接内的已关闭身份；重复dispose不启动新shell。
      record.unsubscribe?.();
    })().catch((error) => {
      delete record.stopping;
      throw error;
    });
    return record.stopping;
  };
  const closeRecords = async (selected: TerminalRecord[], reason: string) => {
    // 先同步夹紧所有准入，之后才等待各自的真实退出。
    for (const record of selected) record.closing = true;
    const results = await Promise.allSettled(
      selected.map((record) => stopRecord(record, reason)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  const deliverExit = async (record: TerminalRecord) => {
    if (!record.subscriber || !record.exit || record.exitDelivered) return;
    // 晚订阅的reader激活与首帧交付均为异步；真实drain完成后才交付退出。
    await record.process?.waitForExit();
    await record.delivery;
    if (record.exitDelivered) return;
    record.exitDelivered = true;
    await record.subscriber.exit(record.exit);
  };
  return {
    async create(actor, connectionId, input) {
      const workspace = await deps.viewer.resolveWorkspace(actor);
      if (closed || closedConnections.has(ownerKey(workspace.id, connectionId)))
        throw new CodeTerminalError("closed", "终端连接已关闭。");
      const request = { ...input, sessionId: input.sessionId ?? randomUUID() };
      const id = request.sessionId;
      const recordKey = key(workspace.id, connectionId, id);
      const fingerprint = parameterFingerprint(request);
      const existing = records.get(recordKey);
      if (existing) {
        if (
          existing.userId !== actor.id ||
          existing.fingerprint !== fingerprint
        )
          throw new CodeTerminalError(
            "conflict",
            "同一终端身份不能改变Task、目录或启动参数。",
          );
        ensureOpen(existing);
        return { ...(await existing.ready), reused: true };
      }
      let resolveReady!: (result: TerminalOpenResult) => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<TerminalOpenResult>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const record: TerminalRecord = {
        workspaceId: workspace.id,
        userId: actor.id,
        connectionId,
        id,
        request,
        fingerprint,
        closing: false,
        ready,
        delivery: Promise.resolve(),
        exitDelivered: false,
        ordinal: ++ordinal,
      };
      // reserve在第一个scope/FS等待之前；重放加入同一启动Promise。
      records.set(recordKey, record);
      void (async () => {
        const scope = await deps.scopes.openTask(actor, request.taskId);
        record.scope = scope;
        ensureOpen(record);
        const settings = await deps.settings.getWorkspaceSettings(
          actor,
          workspace.id,
        );
        const preceding = [...records.values()].filter(
          (candidate) =>
            candidate.workspaceId === workspace.id &&
            candidate.connectionId === connectionId &&
            candidate.ordinal <= record.ordinal &&
            !candidate.closing &&
            !candidate.exit,
        );
        if (preceding.length > settings.terminalMaxSessions)
          throw new CodeTerminalError(
            "unavailable",
            `此连接同时最多${settings.terminalMaxSessions}个终端，请先关闭一个。`,
            429,
          );
        const cwd = await scope.resolvePath(request.cwd ?? ".", "read");
        ensureOpen(record);
        const shell = resolveTerminalShell(
          request.shell ?? settings.terminalShell,
          detectTerminalShells(),
        );
        if (!shell)
          throw new CodeTerminalError(
            "unavailable",
            "未找到可执行的真实终端shell。",
            503,
          );
        const process = await deps.sandbox.spawnPty({
          scope: scope.describe(),
          agentId: `human-terminal:${connectionId}:${id}`,
          invocationId: `terminal:${id}`,
          argv: {
            executable: shell.executable,
            args: interactiveInvocation(shell),
          },
          pty: { cols: request.cols, rows: request.rows },
          cwd,
          background: true,
          timeoutMs: null,
          limits: {
            maxOutputBytes: settings.processMaxOutputBytes,
            previewMaxChars: settings.processPreviewMaxChars,
            yieldMs: settings.processYieldMs,
            killGraceMs: settings.processKillGraceMs,
          },
        });
        record.process = process;
        void process
          .waitForExit()
          .then(async (exit) => {
            record.exit = exit;
            await deliverExit(record);
          })
          .catch((error: unknown) =>
            console.warn("[code-terminal] 终端退出或通知失败：", error),
          );
        if (
          record.closing ||
          closed ||
          closedConnections.has(ownerKey(workspace.id, connectionId))
        ) {
          const exit = await process.stop("终端连接在启动期间关闭");
          if (!exit.rangeEmpty)
            throw new CodeTerminalError(
              "stop_unconfirmed",
              "迟到终端尚未确认退出。",
            );
          throw new CodeTerminalError("closed", "终端连接在启动期间关闭。");
        }
        return {
          id,
          taskId: request.taskId,
          shell: shell.id,
          executable: shell.executable,
          tty: true as const,
        };
      })()
        .catch((error) => {
          if (!record.process) records.delete(recordKey);
          throw error;
        })
        .then(resolveReady, rejectReady);
      return record.ready;
    },
    async write(actor, connectionId, id, data) {
      const record = await owned(actor, connectionId, id);
      ensureOpen(record);
      await record.ready;
      await record.scope?.resolvePath(".", "read");
      ensureOpen(record);
      if (record.process) await record.process.writeStdin(data);
    },
    async resize(actor, connectionId, id, cols, rows) {
      const record = await owned(actor, connectionId, id);
      ensureOpen(record);
      await record.ready;
      await record.scope?.resolvePath(".", "read");
      ensureOpen(record);
      if (record.process) await record.process.resize(cols, rows);
    },
    async subscribe(actor, connectionId, id, subscriber) {
      const record = await owned(actor, connectionId, id);
      await record.ready;
      if (record.subscriber) return;
      if (!record.process)
        throw new CodeTerminalError("unavailable", "终端未完成启动。", 503);
      record.subscriber = subscriber;
      record.unsubscribe = record.process.onOutput((data, cursor) => {
        record.delivery = record.delivery.then(() =>
          subscriber.output(data, cursor),
        );
        return record.delivery;
      });
      await deliverExit(record);
    },
    async stop(actor, connectionId, id, reason) {
      await stopRecord(await owned(actor, connectionId, id), reason);
    },
    async closeConnection(workspaceId, connectionId, reason) {
      closedConnections.add(ownerKey(workspaceId, connectionId));
      await closeRecords(
        [...records.values()].filter(
          (record) =>
            record.workspaceId === workspaceId &&
            record.connectionId === connectionId,
        ),
        reason,
      );
      for (const [id, record] of records)
        if (
          record.workspaceId === workspaceId &&
          record.connectionId === connectionId
        )
          records.delete(id);
    },
    async closeTask(workspaceId, taskId, reason) {
      await closeRecords(
        [...records.values()].filter(
          (record) =>
            record.workspaceId === workspaceId &&
            record.request.taskId === taskId,
        ),
        reason,
      );
    },
    async close(reason) {
      closed = true;
      await closeRecords([...records.values()], reason);
      records.clear();
    },
  };
}
