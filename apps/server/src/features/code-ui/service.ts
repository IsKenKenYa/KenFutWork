import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  type CodeUiEvent,
  type CodeUiWorkspace,
  zcodeUiProtocol as protocol,
  type StreamEvent,
} from "@kenfutwork/shared";
import { parseModelConfig, parseProviderConfig } from "@zcode/provider";
import {
  appSettingsSchema,
  zcodeWorkspacePresentationSchema,
} from "@zcode/shared";
import { z } from "zod";
import type { AgentRunService } from "../../agent/runtime.js";
import { resolveSandboxDir } from "../../agent/sandbox-dir.js";
import type { ServerEnv } from "../../config/env.js";
import type { AgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import type { AuthenticatedUser } from "../auth/types.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type { ThreadService } from "../chat/thread-service.js";
import type { ModelCatalogService } from "../model-providers/model-catalog-service.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";
import type { ProjectService } from "../projects/project-service.js";
import type { SettingsService } from "../settings/settings-service.js";
import { CodeUiConnections } from "./connections.js";
import { createCodeUiConversation } from "./conversation.js";
import { readCodeUiTextFile } from "./files.js";
import { buildCodeUiModelViews } from "./model-views.js";
import { type CodeUiRepository, CodeUiRepositoryError } from "./repository.js";
import { codeUiTaskMeta } from "./task-index.js";

export interface CodeUiServiceDeps {
  repository: CodeUiRepository;
  viewer: ViewerService;
  projects: ProjectService;
  modelProviders: ModelProviderService;
  modelCatalog: ModelCatalogService;
  settings: SettingsService;
  threads: ThreadService;
  agentRuns: AgentRunService;
  agentRunMetadata: AgentRunMetadataService;
  env: ServerEnv;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function codeUiCommandFingerprint(
  envelope: protocol.CommandEnvelope,
): string {
  return createHash("sha256")
    .update(
      canonical({
        sessionId: envelope.sessionId,
        type: envelope.type,
        payload: envelope.payload,
      }),
    )
    .digest("hex");
}

/** 服务定义的具体 Provider；原 GUI 仅调用该域提供的 RPC/会话消费接口。 */
export class CodeUiService {
  private readonly connections = new CodeUiConnections();
  constructor(private readonly deps: CodeUiServiceDeps) {}

  async openConnection(
    user: AuthenticatedUser,
    send: (event: CodeUiEvent) => Promise<void>,
    close: () => void,
  ) {
    const workspace = await this.deps.viewer.resolveWorkspace(user);
    return this.connections.open(workspace.id, user.id, send, close);
  }

  closeConnections() {
    this.connections.closeAll();
  }

  async hostRpc(
    user: AuthenticatedUser,
    service: string,
    method: string,
    args: unknown[],
  ) {
    if (service === "providerSettingsService") {
      if (method === "deletePersonalModel") {
        await this.deps.modelProviders.deleteCodeModel(
          user,
          z.string().uuid().parse(args[0]),
          z.string().trim().min(1).parse(args[1]),
        );
        return { result: (await this.publishProviderViews(user)).settings };
      }
      if (method === "setPersonalModelEnabled") {
        await this.deps.modelProviders.setCodeModelEnabled(
          user,
          z.string().uuid().parse(args[0]),
          z.string().trim().min(1).parse(args[1]),
          z.boolean().parse(args[2]),
        );
        return { result: (await this.publishProviderViews(user)).settings };
      }
      if (method === "savePersonalModelDraft") {
        const input = z
          .object({
            providerId: z.string().uuid(),
            originalModelId: z.string().trim().min(1),
            nextModelId: z.string().trim().min(1),
            personalConfig: z.unknown(),
            useRecommendedConfig: z.boolean().optional(),
            basedOnRevision: z.number().int().nonnegative(),
          })
          .strict()
          .parse(args[0]);
        await this.deps.modelProviders.saveCodeModelDraft(user, {
          providerId: input.providerId,
          originalModelId: input.originalModelId,
          nextModelId: input.nextModelId,
          personalConfig: parseModelConfig(input.personalConfig).toJSON(),
          basedOnRevision: input.basedOnRevision,
          ...(input.useRecommendedConfig === undefined
            ? {}
            : { useRecommendedConfig: input.useRecommendedConfig }),
        });
        return { result: (await this.publishProviderViews(user)).settings };
      }
      if (method === "resolveModelConfig") {
        const input = z
          .object({
            providerId: z.string().uuid(),
            modelId: z.string().trim().min(1),
            originalModelId: z.string().optional(),
            personalConfig: z.unknown().optional(),
          })
          .strict()
          .parse(args[0]);
        return {
          result: await this.deps.modelProviders.resolveCodeModelConfig(
            user,
            input.personalConfig === undefined
              ? { providerId: input.providerId, modelId: input.modelId }
              : {
                  providerId: input.providerId,
                  modelId: input.modelId,
                  originalModelId: z.string().parse(input.originalModelId),
                  personalConfig: parseModelConfig(
                    input.personalConfig,
                  ).toJSON(),
                },
          ),
        };
      }
      if (method === "addPersonalModel") {
        await this.deps.modelProviders.addCodeModel(
          user,
          z.string().uuid().parse(args[0]),
          z.string().trim().min(1).parse(args[1]),
          parseModelConfig(args[2]).toJSON(),
          z.boolean().parse(args[3] ?? true),
        );
        return { result: (await this.publishProviderViews(user)).settings };
      }
      if (method === "savePersonalProviderOverlay") {
        await this.deps.modelProviders.saveCodeProviderOverlay(
          user,
          z.string().uuid().parse(args[0]),
          parseProviderConfig(args[1]).toJSON(),
          z
            .object({
              providerName: z.string().nullable().optional(),
              enabled: z.boolean().optional(),
              templateId: z.string().min(1).nullable().optional(),
            })
            .strict()
            .parse(args[2] ?? {}),
        );
        return { result: (await this.publishProviderViews(user)).settings };
      }
      if (method === "getView" || method === "refresh")
        return { result: (await this.modelViews(user)).settings };
      if (method === "createPersonalProvider") {
        const input = z
          .object({
            providerName: z.string().min(1).optional(),
            locale: z.enum(["zh-CN", "en-US"]).optional(),
          })
          .strict()
          .parse(args[0] ?? {});
        const provider = await this.deps.modelProviders.createDraftInstance(
          user,
          {
            name: input.providerName ?? "new-provider",
            protocol: "openai-compatible",
          },
        );
        const views = await this.publishProviderViews(user);
        return {
          result: {
            providerId: provider.id,
            view: views.settings,
          },
        };
      }
      if (method === "deletePersonalProvider") {
        await this.deps.modelProviders.deleteInstance(
          user,
          z.string().uuid().parse(args[0]),
        );
        return { result: (await this.publishProviderViews(user)).settings };
      }
    }
    if (service === "file" && method === "readTextFile")
      return {
        result: await readCodeUiTextFile(
          await this.listWorkspaces(user),
          args[0],
        ),
      };
    if (service === "zcode-task") return this.taskIndexRpc(user, method, args);
    if (service === "setting" && method === "get") {
      const projects = await this.listWorkspaces(user);
      return {
        result: appSettingsSchema.parse({
          recentProjects: projects.map((project) => project.path),
        }),
      };
    }
    if (service === "system" && method === "info")
      return { result: { homedir: homedir(), platform: process.platform } };
    if (service === "zcode-session" && method === "readWorkspacePresentation") {
      const target = args[0] as { workspacePath: string };
      const project = await this.requireWorkspace(user, target.workspacePath);
      const workspace = await this.deps.viewer.resolveWorkspace(user);
      const settings = await this.deps.settings.getWorkspaceSettings(
        user,
        workspace.id,
      );
      return {
        result: zcodeWorkspacePresentationSchema.parse({
          workspace: {
            workspacePath: project.path,
            workspaceKey: project.path,
          },
          mode: "build",
          slashCommands: settings.commands.map((command) => ({
            name: command.name,
            description: command.description,
          })),
        }),
      };
    }
    return null;
  }

  private async taskIndexRpc(
    user: AuthenticatedUser,
    method: string,
    args: unknown[],
  ) {
    const supported = new Set([
      "listTasks",
      "listPinnedTasks",
      "listArchivedTasks",
      "listPinnedTaskIds",
      "listDeletedTaskIds",
      "getTaskMeta",
    ]);
    if (!supported.has(method)) return null;
    const workspace = await this.deps.viewer.resolveWorkspace(user);
    const projects = await this.listWorkspaces(user);
    const paths = new Map(
      projects.map((project) => [project.projectId, project.path]),
    );
    const records = await this.deps.repository.listRoots(workspace.id);
    if (method === "listPinnedTaskIds")
      return {
        result: records
          .filter(
            (entry) =>
              entry.pinned &&
              !entry.archived &&
              codeUiTaskMeta(entry, paths.get(entry.project_id)!),
          )
          .map((entry) => entry.id),
      };
    const target = args[0] as { workspacePath: string; taskId?: string };
    const project = await this.requireWorkspace(user, target.workspacePath);
    const scoped = records.filter(
      (entry) => entry.project_id === project.projectId,
    );
    if (method === "listDeletedTaskIds")
      return {
        result: scoped
          .filter((entry) => entry.deleted_at)
          .map((entry) => entry.id),
      };
    if (method === "getTaskMeta") {
      const record = scoped.find((entry) => entry.id === target.taskId);
      return { result: record ? codeUiTaskMeta(record, project.path) : null };
    }
    const visible = scoped.filter((entry) =>
      method === "listArchivedTasks"
        ? entry.archived
        : method === "listPinnedTasks"
          ? entry.pinned && !entry.archived
          : !entry.archived && !entry.pinned,
    );
    return {
      result: visible.flatMap((entry) => {
        const meta = codeUiTaskMeta(entry, project.path);
        return meta ? [meta] : [];
      }),
    };
  }

  async transportRpc(
    user: AuthenticatedUser,
    connectionId: string | undefined,
    method: string,
    args: unknown[],
  ) {
    const workspace = await this.deps.viewer.resolveWorkspace(user);
    if (method === "helloConversationV4")
      return {
        result: this.connections.require(workspace.id, connectionId, false)
          .hello,
      };
    if (method === "initializeConversationV4") {
      this.connections.initialize(workspace.id, connectionId, args[0]);
      return { result: null };
    }
    const target = args[0] as {
      workspacePath: string;
      sessionId?: string;
      subscriptionId?: string;
    };
    if (method === "subscribeConversationV4") {
      const params = protocol.subscribeParamsSchema.parse({
        topic: target.sessionId
          ? protocol.conversationTopic(target.sessionId)
          : undefined,
      });
      const sessionId = protocol.parseConversationTopic(params.topic);
      if (!sessionId)
        throw new CodeUiRepositoryError("not_found", "Code 会话 topic 无效");
      const project = await this.requireWorkspace(user, target.workspacePath);
      const read = async () => {
        const loaded = await this.loadConversation(user, sessionId);
        if (loaded.project.projectId !== project.projectId)
          throw new CodeUiRepositoryError(
            "not_found",
            "会话不属于该 Code 工作目录",
          );
        const snapshot = loaded.host.getSnapshot(sessionId);
        return { snapshot, seq: snapshot.seq };
      };
      return this.connections.subscribe(workspace.id, connectionId, {
        topic: params.topic,
        workspacePath: project.path,
        read,
      });
    }
    if (method === "subscribeSessionsIndexV4") {
      const project = await this.requireWorkspace(user, target.workspacePath);
      const read = async () => ({
        snapshot: await this.sessionsIndex(user, project.path),
        seq: await this.deps.repository.listVersion(
          workspace.id,
          project.canvasId,
        ),
      });
      return this.connections.subscribe(workspace.id, connectionId, {
        topic: protocol.sessionsIndexTopic(project.path),
        workspacePath: project.path,
        read,
      });
    }
    if (
      method === "resyncConversationV4" ||
      method === "resyncSessionsIndexV4"
    ) {
      const value = target as unknown as protocol.ConversationResyncParams;
      const params = protocol.conversationResyncParamsSchema.parse({
        subscriptionId: value.subscriptionId,
        base: value.base,
        ...(value.forceSnapshot !== undefined
          ? { forceSnapshot: value.forceSnapshot }
          : {}),
      });
      return this.connections.resync(workspace.id, connectionId, params);
    }
    if (
      method === "unsubscribeConversationV4" ||
      method === "unsubscribeSessionsIndexV4"
    ) {
      if (!target.subscriptionId)
        throw new CodeUiRepositoryError("not_found", "Code 订阅身份缺失");
      this.connections.unsubscribe(
        workspace.id,
        connectionId,
        target.subscriptionId,
      );
      return { result: null };
    }
    if (method === "queryConversationCommandsV4") {
      const params = args[0] as protocol.CommandsQueryParams;
      const parsed = protocol.commandsQueryParamsSchema.parse({
        commands: params.commands,
        ...(params.clock ? { clock: true } : {}),
      });
      const clientId = this.connections.require(workspace.id, connectionId)
        .client!.clientId;
      return {
        result: await this.deps.repository.queryCommands(
          workspace.id,
          clientId,
          parsed.commands,
        ),
      };
    }
    if (method === "conversationRowsRangeV4") {
      const parsed = protocol.v4ConversationRowsRangeParamsSchema.parse(
        args[0],
      );
      const snapshot = await this.getSnapshot(user, parsed.sessionId);
      const rows = snapshot.rows.window.filter(
        (row) =>
          parsed.beforeRowId === undefined || row.rowId < parsed.beforeRowId,
      );
      return {
        result: protocol.v4ConversationRowsRangeResultSchema.parse({
          rows: rows.slice(-parsed.limit),
          atSeq: snapshot.seq,
          atRevision: snapshot.revision,
          atLogEpoch: snapshot.logEpoch,
          hasMore: rows.length > parsed.limit,
        }),
      };
    }
    if (method === "sendConversationCommandV4") {
      const input = args[0] as { envelope?: unknown; workspacePath: string };
      const parsed = protocol.parseCommandEnvelope(input.envelope);
      if (!parsed.ok) throw parsed.error;
      if (connectionId) {
        const bound = this.connections.require(workspace.id, connectionId);
        if (bound.client!.clientId !== parsed.envelope.clientId)
          throw new CodeUiRepositoryError(
            "command_conflict",
            "Code 命令不属于握手客户端",
          );
      }
      if (parsed.envelope.type === "createSession")
        return { result: await this.createSession(user, parsed.envelope) };
      if (parsed.envelope.type === "sendText")
        return this.sendText(user, input.workspacePath, parsed.envelope);
    }
    return null;
  }

  private async sendText(
    user: AuthenticatedUser,
    workspacePath: string,
    envelope: protocol.CommandEnvelope,
  ) {
    if (!envelope.sessionId)
      throw new CodeUiRepositoryError("not_found", "发送命令缺少会话");
    const loaded = await this.loadConversation(user, envelope.sessionId);
    if (loaded.entry.parent_session_id || loaded.project.path !== workspacePath)
      throw new CodeUiRepositoryError(
        "not_found",
        "发送命令不属于根会话工作目录",
      );
    const payload = protocol.commandPayloadSchemas.sendText.parse(
      envelope.payload,
    );
    if (!payload.text.trim())
      throw new CodeUiRepositoryError("command_conflict", "消息不能为空");
    const snapshot = loaded.host.getSnapshot();
    const views = await this.modelViews(
      user,
      payload.modelSelection ?? snapshot.config.modelSelection,
    );
    const selection = views.selection.effectiveSelection;
    if (!selection)
      throw new CodeUiRepositoryError(
        "command_conflict",
        "当前模型不可执行，请检查供应商配置",
      );
    const thread = await this.deps.threads.resolveOwnedSessionThread(
      user,
      loaded.root.id,
    );
    const runId = randomUUID();
    const ack = await this.deps.repository.applyCommand(
      loaded.workspaceId,
      envelope,
      codeUiCommandFingerprint(envelope),
      (root) => {
        const host = createCodeUiConversation({
          sessionId: root.id,
          workspacePath,
          config: snapshot.config,
          state: root.state!,
        });
        if (host.getSnapshot().control.phase === "running")
          throw new CodeUiRepositoryError(
            "command_conflict",
            "当前运行尚未结束",
          );
        host.startTurn({
          runId,
          commandId: envelope.commandId,
          text: payload.text,
        });
        return {
          state: host.exportState(),
          activeRunId: runId,
          ack: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: host.getSnapshot().revision,
            result: {
              type: "inputAccepted",
              delivery: "startNow",
              inputId: envelope.commandId,
            },
          },
        };
      },
    );
    return {
      result: ack,
      publish: async () => {
        if (ack.status === "duplicate") return;
        await this.connections.refresh(loaded.workspaceId, workspacePath);
        await this.notifyTask(
          user,
          loaded.project,
          loaded.root.id,
          "user_message_saved",
        );
        await this.runTurn(
          user,
          loaded.project,
          loaded.root.id,
          thread.threadId,
          runId,
          payload.text,
          `${selection.providerId}:${selection.modelId}`,
        );
      },
    };
  }

  private async recordRunEvent(
    user: AuthenticatedUser,
    project: CodeUiWorkspace,
    sessionId: string,
    event: StreamEvent,
    ordinal: number,
  ) {
    const workspace = await this.deps.viewer.resolveWorkspace(user);
    const applied = await this.deps.repository.appendEvent(
      workspace.id,
      sessionId,
      {
        key: `${event.runId}/${ordinal}`,
        fingerprint: createHash("sha256")
          .update(canonical(event))
          .digest("hex"),
        event,
      },
      (root) => {
        const rootSnapshot = root.state!.snapshots.find(
          (entry) => entry.sessionId === root.id,
        )!;
        const host = createCodeUiConversation({
          sessionId: root.id,
          workspacePath: project.path,
          config: rootSnapshot.config,
          state: root.state!,
        });
        host.recordEvent(event);
        return {
          state: host.exportState(),
          activeRunId:
            host.getSnapshot().control.phase === "running" ? event.runId : null,
        };
      },
    );
    if (applied) {
      await this.connections.refresh(workspace.id, project.path);
      if (["run.completed", "run.failed", "run.canceled"].includes(event.type))
        await this.notifyTask(user, project, sessionId, "task_status_changed");
    }
  }

  private async notifyTask(
    user: AuthenticatedUser,
    project: CodeUiWorkspace,
    sessionId: string,
    reason: "user_message_saved" | "task_status_changed",
  ) {
    const workspace = await this.deps.viewer.resolveWorkspace(user);
    const record = await this.deps.repository.find(workspace.id, sessionId);
    const meta = record ? codeUiTaskMeta(record, project.path) : null;
    if (meta)
      await this.connections.notify(
        workspace.id,
        "zcode-task",
        "onDynamicWorkspaceEvent",
        project.path,
        {
          type: "workspace_task_list_changed",
          workspacePath: project.path,
          taskId: sessionId,
          reason,
          taskMeta: meta,
        },
      );
  }

  private async runTurn(
    user: AuthenticatedUser,
    project: CodeUiWorkspace,
    sessionId: string,
    threadId: string,
    runId: string,
    text: string,
    model: string,
  ) {
    let ordinal = 0;
    try {
      await this.deps.agentRunMetadata.createAcceptedRun({
        runId,
        sessionId,
        threadId,
        model,
      });
      this.deps.agentRuns.createRun(
        {
          sessionId,
          conversationId: sessionId,
          canvasId: project.canvasId,
          preset: "code",
          prompt: text,
          model,
        },
        {
          runId,
          threadId,
          sandboxScopeId: project.canvasId,
          accessToken: user.accessToken,
          userId: user.id,
          model,
        },
      );
      for await (const event of this.deps.agentRuns.streamRun(runId))
        await this.recordRunEvent(user, project, sessionId, event, ++ordinal);
    } catch (error) {
      this.deps.agentRuns.cancelRun(runId);
      if (error instanceof CodeUiRepositoryError && error.code === "not_found")
        return;
      await this.recordRunEvent(
        user,
        project,
        sessionId,
        {
          type: "run.failed",
          runId,
          error: {
            code: "run_failed",
            message: error instanceof Error ? error.message : "Code 运行失败",
          },
          timestamp: new Date().toISOString(),
        },
        ++ordinal,
      );
    }
  }

  async listWorkspaces(user: AuthenticatedUser): Promise<CodeUiWorkspace[]> {
    const projects = await this.deps.projects.listProjects(user, "code");
    return projects.flatMap((project) =>
      project.primaryCanvas
        ? [
            {
              projectId: project.id,
              canvasId: project.primaryCanvas.id,
              name: project.name,
              path: resolveSandboxDir(
                project.primaryCanvas.id,
                this.deps.env.sandboxRoot,
                project.workDir ??
                  this.deps.env.canvasWorkDirs?.[project.primaryCanvas.id],
              ),
            },
          ]
        : [],
    );
  }

  async requireWorkspace(
    user: AuthenticatedUser,
    path: string,
  ): Promise<CodeUiWorkspace> {
    const workspace = (await this.listWorkspaces(user)).find(
      (candidate) => candidate.path === path || candidate.projectId === path,
    );
    if (!workspace)
      throw new CodeUiRepositoryError(
        "not_found",
        "Code 工作目录不属于当前工作区或已经归档",
      );
    return workspace;
  }

  async modelViews(
    user: AuthenticatedUser,
    selection?: protocol.SessionConfigState["modelSelection"] | null,
  ) {
    const workspace = await this.deps.viewer.resolveWorkspace(user);
    const [registry, settings] = await Promise.all([
      this.deps.modelProviders.readWorkspaceRegistry(user),
      this.deps.settings.getWorkspaceSettings(user, workspace.id),
    ]);
    return buildCodeUiModelViews({
      instances: registry.instances,
      catalog: this.deps.modelCatalog.describeInstanceModels(
        registry.instances,
      ),
      revision: registry.revision,
      providerSettings: registry.providerSettings,
      ...(settings.defaultModel
        ? { defaultSpecifier: settings.defaultModel }
        : {}),
      ...(selection !== undefined ? { selection } : {}),
    });
  }

  private async publishProviderViews(user: AuthenticatedUser) {
    const workspace = await this.deps.viewer.resolveWorkspace(user);
    const views = await this.modelViews(user);
    await this.connections.notify(
      workspace.id,
      "providerSettingsService",
      "onDidChange",
      "",
      views.settings,
    );
    await this.connections.notify(
      workspace.id,
      "modelSelectionService",
      "onDidChange",
      "",
      views.selection,
    );
    return views;
  }

  async createSession(
    user: AuthenticatedUser,
    envelope: protocol.CommandEnvelope,
  ): Promise<protocol.CommandAck> {
    const payload = protocol.commandPayloadSchemas.createSession.parse(
      envelope.payload,
    );
    const project = await this.requireWorkspace(user, payload.workspaceId);
    const workspace = await this.deps.viewer.resolveWorkspace(user);
    const views = await this.modelViews(user, payload.config?.modelSelection);
    const selection =
      payload.config?.modelSelection ?? views.selection.preferredSelection;
    if (!selection) throw new Error("尚无可运行模型，请先配置供应商");
    const sessionId = randomUUID();
    const host = createCodeUiConversation({
      sessionId,
      workspacePath: project.path,
      config: {
        provider: "zcode",
        model: selection.modelId,
        thought: selection.options?.reasoningLevel ?? "",
        modelSelection: selection,
        followupMode: payload.config?.followupMode ?? "queue",
        mode: payload.config?.mode ?? "build",
        planEnabled: payload.config?.planEnabled ?? false,
      },
    });
    return this.deps.repository.createRoot(workspace.id, {
      sessionId,
      projectId: project.projectId,
      canvasId: project.canvasId,
      userId: user.id,
      threadId: this.deps.threads.createThreadId(),
      state: host.exportState(),
      command: {
        clientId: envelope.clientId,
        commandId: envelope.commandId,
        fingerprint: codeUiCommandFingerprint(envelope),
      },
    });
  }

  async loadConversation(user: AuthenticatedUser, sessionId: string) {
    const workspace = await this.deps.viewer.resolveWorkspace(user);
    const entry = await this.deps.repository.find(workspace.id, sessionId);
    if (!entry)
      throw new CodeUiRepositoryError("not_found", "Code 会话不存在或已删除");
    const root =
      entry.id === entry.root_session_id
        ? entry
        : await this.deps.repository.find(workspace.id, entry.root_session_id);
    if (!root?.state)
      throw new CodeUiRepositoryError("not_found", "Code 会话权威状态不存在");
    const project = (await this.listWorkspaces(user)).find(
      (item) => item.projectId === root.project_id,
    );
    if (!project)
      throw new CodeUiRepositoryError("not_found", "Code 项目已归档");
    const snapshot = root.state.snapshots.find(
      (item) => item.sessionId === root.id,
    );
    if (!snapshot) throw new Error("Code 根快照缺失，无法恢复");
    const host = createCodeUiConversation({
      sessionId: root.id,
      workspacePath: project.path,
      config: snapshot.config,
      state: root.state,
    });
    return { workspaceId: workspace.id, project, entry, root, host };
  }

  async getSnapshot(user: AuthenticatedUser, sessionId: string) {
    return (await this.loadConversation(user, sessionId)).host.getSnapshot(
      sessionId,
    );
  }

  async sessionsIndex(user: AuthenticatedUser, path: string) {
    const project = await this.requireWorkspace(user, path);
    const workspace = await this.deps.viewer.resolveWorkspace(user);
    const records = await this.deps.repository.list(
      workspace.id,
      project.canvasId,
    );
    return protocol.sessionsIndexSnapshotSchema.parse({
      protocolVersion: 1,
      workspaceId: project.path,
      logEpoch: workspace.id,
      sessions: records
        .filter((record) => !record.archived && record.state)
        .flatMap((record) => {
          const snapshot = record.state!.snapshots.find(
            (item) => item.sessionId === record.id,
          );
          if (!snapshot) return [];
          return [
            {
              sessionId: record.id,
              workspaceId: project.path,
              title: snapshot.meta.title,
              titleSource: snapshot.meta.titleSource,
              phase: snapshot.control.phase,
              sessionEnded: snapshot.control.sessionEnded,
              hasBackgroundWork: snapshot.backgroundWorks.some(
                (work) => work.status === "running",
              ),
              lastActivityAt: Date.parse(record.updated_at),
              createdAt: Date.parse(record.created_at),
            },
          ];
        }),
    });
  }
}

export function createCodeUiService(deps: CodeUiServiceDeps) {
  return new CodeUiService(deps);
}
