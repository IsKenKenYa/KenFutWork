import { randomUUID } from "node:crypto";
import {
  type CodeUiWorkspace,
  codeUiControllerTaskListQuerySchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import type { LocalActor } from "../local-instance/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import type { CodeUiConnections } from "./connections.js";
import {
  CodeUiControllerHost,
  type CodeUiControllerSource,
} from "./controller.js";
import {
  type CodeUiRepository,
  CodeUiRepositoryError,
  type CodeUiSessionRecord,
} from "./repository.js";
import { codeUiTaskMeta } from "./task-index.js";

/** 原 Controller 的 readonly source consumer；不创建 Task、运行、目录授权或第二套会话。 */
export function createCodeUiWindowController(options: {
  actor: LocalActor;
  instanceId: string;
  connectionId: string;
  connections: CodeUiConnections;
  repository: CodeUiRepository;
  settings: SettingsService;
  listWorkspaces(): Promise<CodeUiWorkspace[]>;
}) {
  const leases = new Map<string, ReturnType<CodeUiConnections["open"]>>();
  const readSources = async () => {
    const [projects, records] = await Promise.all([
      options.listWorkspaces(),
      options.repository.listRoots(options.instanceId),
    ]);
    const projectIds = new Set(projects.map((project) => project.projectId));
    const sources = new Map<
      string,
      { projectId: string; rootDirectory: string }
    >();
    const include = (projectId: string, rootDirectory: string) =>
      sources.set(JSON.stringify([projectId, rootDirectory]), {
        projectId,
        rootDirectory,
      });
    for (const project of projects) include(project.projectId, project.path);
    for (const record of records)
      if (
        projectIds.has(record.project_id) &&
        !record.deleted_at &&
        !record.parent_session_id &&
        record.root_directory
      )
        include(record.project_id, record.root_directory);
    return { records, sources };
  };
  const readRecords = async (source: CodeUiControllerSource) => {
    const { sources, records } = await readSources();
    if (!sources.has(source.workspaceIdentity))
      throw new CodeUiRepositoryError(
        "not_found",
        "Controller来源已经移除或归档。",
      );
    return records.filter(
      (record) =>
        record.project_id === source.projectId &&
        record.root_directory === source.rootDirectory &&
        !record.deleted_at &&
        !record.parent_session_id,
    );
  };
  const taskMeta = (
    source: CodeUiControllerSource,
    records: CodeUiSessionRecord[],
  ) =>
    records.flatMap((record) => {
      const meta = codeUiTaskMeta(record, source.rootDirectory);
      return meta
        ? [{ ...meta, workspaceIdentity: source.workspaceIdentity }]
        : [];
    });
  const readTaskList = async (
    source: CodeUiControllerSource,
    method: string,
    args: unknown[],
  ) => {
    const records = await readRecords(source);
    if (method !== "listTaskList")
      return taskMeta(
        source,
        records.filter((record) =>
          method === "listArchivedTasks"
            ? record.archived
            : method === "listPinnedTasks"
              ? record.pinned && !record.archived
              : !record.pinned && !record.archived,
        ),
      );
    const query = codeUiControllerTaskListQuerySchema.parse(args[0]);
    const settings = await options.settings.getInstanceSettings(
      options.actor,
      options.instanceId,
    );
    const visible = records.filter((record) =>
      protocol.matchesTaskListMembershipKind(record, query.kind),
    );
    let searchedBytes = 0;
    const search = query.search?.trim().toLocaleLowerCase();
    const items = visible.flatMap((record) => {
      const metas = taskMeta(source, [record]);
      if (!search || !metas.length) return metas;
      const meta = metas[0];
      const snapshot = record.state?.snapshots.find(
        (entry) => entry.sessionId === record.id,
      );
      if (!meta || !snapshot) return [];
      const texts = [
        meta.title,
        ...snapshot.rows.window.flatMap((row) =>
          row.kind === "userInput" || row.kind === "assistantText"
            ? [row.text]
            : [],
        ),
      ];
      const snippets: string[] = [];
      for (const text of texts) {
        searchedBytes += Buffer.byteLength(text, "utf8");
        if (searchedBytes > settings.codeSearchMaxBytes)
          throw new CodeUiRepositoryError(
            "command_conflict",
            "会话搜索超过工作区读取预算，请缩小项目范围。",
          );
        const at = text.toLocaleLowerCase().indexOf(search);
        if (at >= 0)
          snippets.push(
            text.slice(
              Math.max(0, at - settings.codeReadPageCharacters / 2),
              at + settings.codeReadPageCharacters / 2,
            ),
          );
      }
      return snippets.length
        ? [{ ...meta, searchSnippets: [...new Set(snippets)] }]
        : [];
    });
    items.sort(
      (left, right) =>
        (query.sortBy === "created"
          ? right.createdAt - left.createdAt
          : right.updatedAt - left.updatedAt) ||
        left.taskId.localeCompare(right.taskId),
    );
    // 原Controller会自行算全局total并裁剪；source不能隐瞒预算内的命中。
    const limit = query.limit ?? items.length;
    return {
      items: items.slice(0, limit),
      total: items.length,
      hasMore: items.length > limit,
    };
  };
  const sourceConnection = (source: CodeUiControllerSource) => {
    const existing = leases.get(source.workspaceIdentity);
    if (existing) return existing;
    options.connections.require(
      options.instanceId,
      options.connectionId,
      false,
      options.actor.accessClientId,
    );
    const connection = options.connections.open(
      options.instanceId,
      options.actor.instanceId,
      async (event) => host.accept(event),
      () => {},
      false,
      false,
      options.actor.accessClientId,
    );
    options.connections.initialize(
      options.instanceId,
      connection.hello.connectionId,
      {
        kind: "clientHello",
        protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
        clientId: randomUUID(),
        clientKind: "web",
        appVersion: "code-controller",
      },
    );
    leases.set(source.workspaceIdentity, connection);
    return connection;
  };
  const host = new CodeUiControllerHost({
    sources: async () => [...(await readSources()).sources.values()],
    sourceCall: async (source, service, method, args) => {
      if (service === "zcode-task") return readTaskList(source, method, args);
      const lease = sourceConnection(source);
      if (method === "unsubscribeSessionsIndexV4") {
        const value = protocol.v4ConversationUnsubscribeParamsSchema.parse({
          subscriptionId: (args[0] as { subscriptionId?: unknown })
            ?.subscriptionId,
        });
        options.connections.unsubscribe(
          options.instanceId,
          lease.hello.connectionId,
          value.subscriptionId,
        );
        return null;
      }
      if (method === "resyncSessionsIndexV4") {
        const input = args[0] as {
          subscriptionId?: unknown;
          base?: unknown;
          forceSnapshot?: unknown;
        };
        const value = protocol.conversationResyncParamsSchema.parse({
          subscriptionId: input?.subscriptionId,
          base: input?.base,
          ...(input?.forceSnapshot !== undefined
            ? { forceSnapshot: input.forceSnapshot }
            : {}),
        });
        const prepared = await options.connections.resync(
          options.instanceId,
          lease.hello.connectionId,
          value,
        );
        await prepared.publish();
        return prepared.result;
      }
      if (method !== "subscribeSessionsIndexV4")
        throw new CodeUiRepositoryError(
          "not_found",
          "Controller source 只允许读取会话索引。",
        );
      const prepared = await options.connections.subscribe(
        options.instanceId,
        lease.hello.connectionId,
        {
          topic: protocol.sessionsIndexTopic(source.workspaceIdentity),
          workspacePath: source.rootDirectory,
          projectId: source.projectId,
          read: async () => {
            const records = await readRecords(source);
            const snapshot = protocol.sessionsIndexSnapshotSchema.parse({
              protocolVersion: 1,
              workspaceId: source.workspaceIdentity,
              logEpoch: options.instanceId,
              sessions: records
                .filter((record) => !record.archived && record.state)
                .flatMap((record) => {
                  const current = record.state?.snapshots.find(
                    (entry) => entry.sessionId === record.id,
                  );
                  return current
                    ? [
                        {
                          sessionId: record.id,
                          workspaceId: source.workspaceIdentity,
                          title: current.meta.title,
                          titleSource: current.meta.titleSource,
                          phase: current.control.phase,
                          sessionEnded: current.control.sessionEnded,
                          hasBackgroundWork: current.backgroundWorks.some(
                            (work) => work.status === "running",
                          ),
                          lastActivityAt: Date.parse(record.updated_at),
                          createdAt: Date.parse(record.created_at),
                          ...(current.pendingInteractions.length
                            ? {
                                pendingInteractionSummary: {
                                  permissionCount:
                                    current.pendingInteractions.filter(
                                      (entry) => entry.kind === "permission",
                                    ).length,
                                  userInputCount:
                                    current.pendingInteractions.filter(
                                      (entry) => entry.kind === "userInput",
                                    ).length,
                                },
                              }
                            : {}),
                        },
                      ]
                    : [];
                }),
            });
            return {
              snapshot,
              seq: await options.repository.listVersion(
                options.instanceId,
                source.projectId,
              ),
            };
          },
        },
      );
      await prepared.publish();
      return prepared.result;
    },
    send: (event) =>
      options.connections.send(options.instanceId, options.connectionId, event),
    disposeSource: async (source) => {
      if (source) {
        leases.get(source.workspaceIdentity)?.dispose();
        leases.delete(source.workspaceIdentity);
      } else {
        for (const lease of leases.values()) lease.dispose();
        leases.clear();
      }
    },
    deliveryFailed: (error) =>
      console.warn("[code-ui] Controller通知未送达：", error),
  });
  return host;
}
