import { createHash, randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import {
  formatModelPickerValue,
  getZCodeAgentModeSelectOptions,
} from "@zcode/shared";
import { z } from "zod";
import type { LocalActor } from "../local-instance/types.js";
import type { CodeUiConnections } from "./connections.js";
import type { CodeUiHostConnection } from "./host-service-rpc.js";
import type { CodeUiProviderViews } from "../model-providers/provider-settings-rpc.js";
import { CodeUiRepositoryError } from "./repository.js";

const targetSchema = z
  .object({
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().min(1).optional(),
    projectId: z.uuid().optional(),
  })
  .passthrough();
const methods = new Set([
  "subscribeWorkspaceConfigV4",
  "resyncWorkspaceConfigV4",
  "unsubscribeWorkspaceConfigV4",
]);
export type CodeUiWorkspaceConfigRequest = z.infer<typeof targetSchema>;
export interface CodeUiWorkspaceConfigTarget {
  instanceId: string;
  projectId: string;
  workspacePath: string;
}
export interface CodeUiWorkspacePresentation {
  mode: string;
  slashCommands: protocol.WorkspaceSlashCommand[];
}

function configState(
  views: CodeUiProviderViews,
  presentation: CodeUiWorkspacePresentation,
): protocol.WorkspaceConfigState {
  const modeOptions = getZCodeAgentModeSelectOptions();
  if (!modeOptions.some((option) => option.value === presentation.mode))
    throw new CodeUiRepositoryError(
      "command_conflict",
      "工作区默认模式没有对应的真实配置选项。",
    );
  const preferred = views.selection.preferredSelection;
  const options = views.selection.providers.flatMap((provider) =>
    provider.models.map((model) => {
      const levels = [...model.config.optionSpecs.reasoningLevel.values];
      return {
        value: formatModelPickerValue({
          providerId: provider.providerId,
          modelId: model.modelId,
        }),
        name: model.modelId,
        origin: "native" as const,
        modelProviderId: provider.providerId,
        ...(provider.providerName != null
          ? { modelProviderName: provider.providerName }
          : {}),
        modelThoughtLevels: levels,
        ...(levels.at(-1) ? { modelDefaultThoughtLevel: levels.at(-1) } : {}),
      };
    }),
  );
  const configOptions: protocol.WorkspaceConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: preferred ? formatModelPickerValue(preferred) : "",
      options,
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: presentation.mode,
      options: modeOptions,
    },
  ];
  const selected = options.find(
    (option) =>
      option.value ===
      (preferred
        ? formatModelPickerValue({
            providerId: preferred.providerId,
            modelId: preferred.modelId,
          })
        : ""),
  );
  if (selected?.modelThoughtLevels.length) {
    configOptions.push({
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: preferred?.options?.reasoningLevel ?? "",
      options: selected.modelThoughtLevels.map((level) => ({
        value: level,
        name: level,
      })),
    });
  }
  return protocol.workspaceConfigStateSchema.parse({
    configOptions,
    slashCommands: presentation.slashCommands,
  });
}

/** Workspace配置是只读元数据；不初始化Task、派生执行权限或读取BYOK凭据。 */
export function createCodeUiWorkspaceConfigHost(deps: {
  connections: CodeUiConnections;
  resolveTarget(
    actor: LocalActor,
    request: CodeUiWorkspaceConfigRequest,
  ): Promise<CodeUiWorkspaceConfigTarget>;
  modelViews(actor: LocalActor): Promise<CodeUiProviderViews>;
  readPresentation(
    actor: LocalActor,
    target: CodeUiWorkspaceConfigTarget,
  ): Promise<CodeUiWorkspacePresentation>;
}) {
  const logEpoch = randomUUID();
  const versions = new Map<string, { fingerprint: string; seq: number }>();
  const refreshRevisions = new Map<string, number>();
  const reads = new Map<
    string,
    Promise<{ snapshot: protocol.WorkspaceConfigSnapshot; seq: number }>
  >();
  const topicFor = (request: CodeUiWorkspaceConfigRequest) =>
    protocol.workspaceConfigTopic(
      request.workspaceIdentity ?? request.workspacePath,
    );
  const requireConnection = (
    actor: LocalActor,
    connection: CodeUiHostConnection,
  ) => {
    deps.connections.require(
      connection.instanceId,
      connection.connectionId,
      true,
      actor.accessClientId,
    );
    if (connection.instanceId !== actor.instanceId)
      throw new CodeUiRepositoryError(
        "not_found",
        "配置订阅连接不属于当前用户。",
      );
  };
  const requireOwnedSubscription = (
    request: CodeUiWorkspaceConfigRequest,
    connection: CodeUiHostConnection,
    projectId = request.projectId,
  ) => {
    const subscriptionId = z.string().min(1).parse(request.subscriptionId);
    const subscription = deps.connections.requireSubscription(
      connection.instanceId,
      connection.connectionId,
      subscriptionId,
      topicFor(request),
    );
    if (
      subscription.workspacePath !== request.workspacePath ||
      (projectId !== undefined && subscription.projectId !== projectId)
    )
      throw new CodeUiRepositoryError(
        "not_found",
        "配置订阅不属于当前Project与目录。",
      );
    return subscriptionId;
  };
  const resolveTarget = async (
    actor: LocalActor,
    request: CodeUiWorkspaceConfigRequest,
    connection: CodeUiHostConnection,
  ) => {
    requireConnection(actor, connection);
    const target = await deps.resolveTarget(actor, request);
    if (
      target.instanceId !== connection.instanceId ||
      target.workspacePath !== request.workspacePath ||
      (request.projectId && request.projectId !== target.projectId)
    )
      throw new CodeUiRepositoryError(
        "not_found",
        "配置订阅与可信Project身份或目录不匹配。",
      );
    return target;
  };
  const read = (
    actor: LocalActor,
    request: CodeUiWorkspaceConfigRequest,
    connection: CodeUiHostConnection,
    expected: CodeUiWorkspaceConfigTarget,
  ) => {
    const key = JSON.stringify([
      connection.instanceId,
      actor.instanceId,
      expected.projectId,
      topicFor(request),
    ]);
    const produce = async () => {
      for (;;) {
        const refreshRevision = refreshRevisions.get(connection.instanceId);
        const before = await resolveTarget(actor, request, connection);
        if (before.projectId !== expected.projectId)
          throw new CodeUiRepositoryError(
            "not_found",
            "配置目标Project已改变。",
          );
        const [views, presentation] = await Promise.all([
          deps.modelViews(actor),
          deps.readPresentation(actor, before),
        ]);
        const after = await resolveTarget(actor, request, connection);
        if (after.projectId !== expected.projectId)
          throw new CodeUiRepositoryError(
            "not_found",
            "配置读取期间Project身份已改变。",
          );
        if (refreshRevision !== refreshRevisions.get(connection.instanceId))
          continue;
        const config = configState(views, presentation);
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(config))
          .digest("hex");
        const previous = versions.get(key);
        const seq = previous
          ? previous.seq + Number(previous.fingerprint !== fingerprint)
          : 0;
        versions.set(key, { fingerprint, seq });
        return {
          snapshot: protocol.workspaceConfigSnapshotSchema.parse({
            protocolVersion: 1,
            workspaceId: request.workspaceIdentity ?? request.workspacePath,
            logEpoch,
            config,
          }),
          seq,
        };
      }
    };
    const previous = reads.get(key);
    const current = previous ? previous.then(produce, produce) : produce();
    reads.set(key, current);
    void current
      .finally(() => {
        if (reads.get(key) === current) reads.delete(key);
      })
      .catch(() => {});
    return current;
  };
  return {
    async call(
      actor: LocalActor,
      method: string,
      args: unknown[],
      connection: CodeUiHostConnection,
    ) {
      if (!methods.has(method)) return null;
      const request = targetSchema.parse(args[0]);
      requireConnection(actor, connection);
      if (method === "unsubscribeWorkspaceConfigV4") {
        deps.connections.unsubscribe(
          connection.instanceId,
          connection.connectionId,
          requireOwnedSubscription(request, connection),
        );
        return { result: null };
      }
      const target = await resolveTarget(actor, request, connection);
      const topic = topicFor(request);
      if (method === "subscribeWorkspaceConfigV4") {
        return deps.connections.subscribe(
          connection.instanceId,
          connection.connectionId,
          {
            topic,
            workspacePath: request.workspacePath,
            workspaceIdentity: request.workspaceIdentity ?? null,
            projectId: target.projectId,
            read: () => read(actor, request, connection, target),
          },
        );
      }
      const subscriptionId = requireOwnedSubscription(
        request,
        connection,
        target.projectId,
      );
      if (method === "resyncWorkspaceConfigV4") {
        const params = protocol.conversationResyncParamsSchema.parse({
          subscriptionId,
          base: request.base,
          ...(request.forceSnapshot === undefined
            ? {}
            : { forceSnapshot: request.forceSnapshot }),
        });
        return deps.connections.resync(
          connection.instanceId,
          connection.connectionId,
          params,
        );
      }
      return null;
    },
    refresh(instanceId: string, projectId?: string) {
      refreshRevisions.set(
        instanceId,
        (refreshRevisions.get(instanceId) ?? 0) + 1,
      );
      return deps.connections.refreshWorkspaceConfig(instanceId, projectId);
    },
  };
}
export type CodeUiWorkspaceConfigHost = ReturnType<
  typeof createCodeUiWorkspaceConfigHost
>;
