import { createHash } from "node:crypto";
import type {
  ProviderInstanceResponse,
  ProviderInstanceUpdateRequest,
} from "@kenfutwork/shared";
import {
  managedProviderPatchSchema,
  modelDefaultsSchema,
} from "@kenfutwork/shared";
import { type ModelSelection, parseProviderConfig } from "@zcode/provider";
import {
  type ModelConnectivityResult,
  modelSelectionSchema,
} from "@zcode/shared";
import { modelConfigDataSchema } from "@zcode/shared/model-config";
import { z } from "zod";
import type { CodeUiRepository } from "../code-ui/repository.js";
import { CodeUiRepositoryError } from "../code-ui/repository.js";
import type { LocalActor } from "../local-instance/types.js";
import type { SettingsService } from "../settings/settings-service.js";
import type { ModelCatalogService } from "./model-catalog-service.js";
import { saveManagedModel } from "./model-management.js";
import type { ModelProviderService } from "./model-provider-service.js";
import {
  buildCodeUiModelViews,
  codeUiModelEntry,
  resolveCodeUiModelConfig,
} from "./model-views.js";
import {
  codeUiNativeModel,
  codeUiNativeProtocol,
  codeUiProviderMetadata,
  codeUiTemplateConfig,
  isCodeChatProtocol,
} from "./provider-settings-rpc-config.js";
import { createProviderModelMutations } from "./provider-settings-rpc-models.js";

export type CodeUiProviderViews = ReturnType<typeof buildCodeUiModelViews>;
export interface CodeUiProviderSettingsRpc {
  readViews(
    actor: LocalActor,
    selection?: ModelSelection | null,
  ): Promise<CodeUiProviderViews>;
  call(
    actor: LocalActor,
    service: string,
    method: string,
    args: unknown[],
  ): Promise<{ result: unknown } | null>;
}
export interface CodeUiProviderSettingsRpcDeps {
  modelProviders: Pick<
    ModelProviderService,
    | "readCredential"
    | "listInstances"
    | "listProviderPresets"
    | "createInstance"
    | "updateInstance"
    | "deleteInstance"
  >;
  modelCatalog: Pick<ModelCatalogService, "listCatalog">;
  settings: Pick<
    SettingsService,
    "getInstanceSettings" | "updateInstanceSettings"
  >;
  instanceId(actor: LocalActor): Promise<string>;
  preferences: Pick<
    CodeUiRepository,
    "readHumanPreferences" | "updateHumanPreferences"
  >;
  notifyViews(actor: LocalActor, views: CodeUiProviderViews): Promise<void>;
  testConnectivity(
    actor: LocalActor,
    target: {
      providerId: string;
      modelId: string;
      workspacePath?: string;
      projectId?: string;
    },
  ): Promise<ModelConnectivityResult>;
}
const providerId = z.uuid();
const modelId = z.string().trim().min(1);
const providerMethods = new Set([
  "createPersonalProvider",
  "savePersonalProviderOverlay",
  "deletePersonalProvider",
  "reorderPersonalProviders",
]);

class ProviderSettingsRpc implements CodeUiProviderSettingsRpc {
  private readonly models: ReturnType<typeof createProviderModelMutations>;
  constructor(private readonly deps: CodeUiProviderSettingsRpcDeps) {
    this.models = createProviderModelMutations({
      load: (actor, id) => this.load(actor, id),
      save: (actor, instance, patch) => this.save(actor, instance, patch),
      revision: async (actor) =>
        (await this.readViews(actor)).settings.revision,
    });
  }
  private readonly revisions = new Map<
    string,
    { fingerprint: string; revision: number }
  >();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private templates() {
    return this.deps.modelProviders
      .listProviderPresets()
      .filter((preset) =>
        preset.models.some((model) => model.capability === "chat"),
      )
      .map((preset) => ({
        templateId: preset.id,
        templateNameMap: { "zh-CN": preset.name, "en-US": preset.name },
        config: codeUiTemplateConfig(preset),
      }));
  }

  async readViews(
    actor: LocalActor,
    selection?: ModelSelection | null,
  ): Promise<CodeUiProviderViews> {
    const instanceId = await this.deps.instanceId(actor);
    const [instances, catalog, settings, preferences] = await Promise.all([
      this.deps.modelProviders.listInstances(actor),
      this.deps.modelCatalog.listCatalog(actor),
      this.deps.settings.getInstanceSettings(actor, instanceId),
      this.deps.preferences.readHumanPreferences(instanceId),
    ]);
    const order = z
      .array(z.string())
      .parse(preferences.codeUiProviderOrder ?? []);
    const base = {
      instances,
      catalog,
      providerOrder: order,
      providerTemplates: this.templates(),
      ...(settings.defaultModel
        ? { defaultSpecifier: settings.defaultModel }
        : {}),
    };
    const publicViews = buildCodeUiModelViews(base);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(publicViews))
      .digest("hex");
    const previous = this.revisions.get(instanceId);
    const revision = previous
      ? previous.revision + Number(previous.fingerprint !== fingerprint)
      : 0;
    this.revisions.set(instanceId, { fingerprint, revision });
    return buildCodeUiModelViews({
      ...base,
      revision,
      ...(selection === undefined ? {} : { selection }),
    });
  }
  private async settingsView(actor: LocalActor) {
    const { settings } = await this.readViews(actor);
    const providers = await Promise.all(
      settings.providers.map(async (provider) => {
        const key = await this.deps.modelProviders.readCredential(
          actor,
          provider.providerId,
        );
        const includeKey = (config: typeof provider.effectiveConfig) => ({
          ...config,
          access: {
            ...config.access,
            type: "api-key" as const,
            ...(key === null ? {} : { apiKey: key }),
          },
        });
        return {
          ...provider,
          effectiveConfig: includeKey(provider.effectiveConfig),
          personalConfig: includeKey(
            provider.personalConfig ?? provider.effectiveConfig,
          ),
        };
      }),
    );
    return { ...settings, providers };
  }

  private async load(actor: LocalActor, id: string) {
    const instance = (await this.deps.modelProviders.listInstances(actor)).find(
      (entry) => entry.id === id,
    );
    if (!instance)
      throw new CodeUiRepositoryError(
        "not_found",
        "供应商已删除，请刷新模型设置。",
      );
    return instance;
  }
  private async loadChat(actor: LocalActor, id: string) {
    const instance = await this.load(actor, id);
    if (!isCodeChatProtocol(instance.protocol))
      throw new CodeUiRepositoryError(
        "command_conflict",
        "该连接不支持聊天模型，请在生成配置中编辑。",
      );
    return instance;
  }
  private async save(
    actor: LocalActor,
    instance: ProviderInstanceResponse,
    patch: ProviderInstanceUpdateRequest,
  ) {
    await this.deps.modelProviders.updateInstance(actor, instance.id, {
      ...patch,
      expectedRevision: patch.expectedRevision ?? instance.configRevision,
    });
  }

  private async afterMutation(actor: LocalActor) {
    const views = await this.readViews(actor);
    await Promise.allSettled([this.deps.notifyViews(actor, views)]);
    return this.settingsView(actor);
  }
  private async serialized<T>(
    actor: LocalActor,
    operation: () => Promise<T>,
  ): Promise<T> {
    const instanceId = await this.deps.instanceId(actor);
    const previous = this.mutations.get(instanceId) ?? Promise.resolve();
    const pending = previous.then(operation, operation);
    this.mutations.set(instanceId, pending);
    try {
      return await pending;
    } finally {
      if (this.mutations.get(instanceId) === pending)
        this.mutations.delete(instanceId);
    }
  }

  private async create(actor: LocalActor, value: unknown) {
    const input = z
      .object({
        templateId: z.string().optional(),
        providerName: z.string().optional(),
        locale: z.enum(["zh-CN", "en-US"]).optional(),
        initialConfig: z.unknown().optional(),
      })
      .strict()
      .parse(value ?? {});
    const template = input.templateId
      ? this.templates().find((entry) => entry.templateId === input.templateId)
      : undefined;
    if (input.templateId && !template)
      throw new CodeUiRepositoryError("not_found", "供应商模板不存在。");
    const config = parseProviderConfig(
      input.initialConfig ??
        template?.config ?? {
          group: "standard-personal",
          access: { type: "api-key" },
          api: { type: "openai-chat-completions" },
        },
    ).toJSON();
    if (config.access && config.access.type === "zhipu-account")
      throw new CodeUiRepositoryError(
        "command_conflict",
        "Code BYOK 供应商需要用户自己的 API Key。",
      );
    const apiKey = config.access?.apiKey;
    if (typeof apiKey === "string" && apiKey !== "" && !apiKey.trim())
      throw new CodeUiRepositoryError(
        "command_conflict",
        "API Key 不能只包含空白字符。",
      );
    const ids = [
      ...new Set([
        ...(config.builtinModelIds ?? []),
        ...(config.personalModelIds ?? []),
      ]),
    ];
    const apiType = config.api?.type ?? "openai-chat-completions";
    const created = await this.deps.modelProviders.createInstance(actor, {
      name:
        input.providerName?.trim() ||
        template?.templateNameMap[input.locale ?? "zh-CN"] ||
        "新供应商",
      protocol: codeUiNativeProtocol(apiType),
      ...(config.api?.baseUrl ? { baseUrl: config.api.baseUrl } : {}),
      ...(config.api?.headers ? { headers: { ...config.api.headers } } : {}),
      ...(config.access?.apiKey ? { apiKey: config.access.apiKey } : {}),
      models: ids.map((id) => codeUiNativeModel(id, {})),
      enabled: config.visibility !== "hidden",
      compat: {
        ...(apiType === "openai-responses"
          ? { chatApi: "responses" as const }
          : apiType === "openai-chat-completions"
            ? { chatApi: "completions" as const }
            : {}),
        codeUi: {
          ...(input.templateId ? { templateId: input.templateId } : {}),
          ...(config.group ? { group: config.group } : {}),
          ...(config.logo ? { logo: config.logo } : {}),
          ...(config.modelOrder ? { modelOrder: [...config.modelOrder] } : {}),
        },
      },
    });
    return { providerId: created.id, view: await this.afterMutation(actor) };
  }
  private async saveOverlay(actor: LocalActor, args: unknown[]) {
    const id = providerId.parse(args[0]);
    const config = parseProviderConfig(args[1]).toJSON();
    const metadata = z
      .object({
        providerName: z.string().trim().min(1).optional(),
        templateId: z.string().optional(),
        enabled: z.boolean().optional(),
        expectedRevision: z.number().int().positive().optional(),
      })
      .strict()
      .parse(args[2] ?? {});
    const instance = await this.load(actor, id);
    const stored = codeUiProviderMetadata(instance);
    if (config.access?.type === "zhipu-account")
      throw new CodeUiRepositoryError(
        "command_conflict",
        "原生账号连接不能代替 BYOK 凭证。",
      );
    const apiKey = config.access?.apiKey;
    if (typeof apiKey === "string" && apiKey !== "" && !apiKey.trim())
      throw new CodeUiRepositoryError(
        "command_conflict",
        "API Key 不能只包含空白字符。",
      );
    const compat = {
      ...instance.compat,
      codeUi: {
        ...stored,
        ...(metadata.templateId ? { templateId: metadata.templateId } : {}),
        ...(config.group ? { group: config.group } : {}),
        ...(config.logo ? { logo: config.logo } : {}),
        ...(config.modelOrder ? { modelOrder: [...config.modelOrder] } : {}),
      },
    };
    const chatProtocol = isCodeChatProtocol(instance.protocol);
    if (chatProtocol) {
      if (config.api?.type === "openai-responses") compat.chatApi = "responses";
      else if (config.api?.type === "openai-chat-completions")
        compat.chatApi = "completions";
      else if (config.api === null || config.api?.type) delete compat.chatApi;
    }
    await this.save(actor, instance, {
      ...(metadata.providerName ? { name: metadata.providerName } : {}),
      ...(chatProtocol && config.api?.type
        ? { protocol: codeUiNativeProtocol(config.api.type) }
        : {}),
      ...(config.api === null
        ? { baseUrl: "", headers: {} }
        : {
            ...(config.api?.baseUrl !== undefined
              ? { baseUrl: config.api.baseUrl ?? "" }
              : {}),
            ...(config.api?.headers !== undefined
              ? { headers: { ...config.api.headers } }
              : {}),
          }),
      ...(config.access === null
        ? { apiKey: null }
        : apiKey !== undefined && apiKey !== ""
          ? { apiKey }
          : {}),
      ...(metadata.enabled !== undefined
        ? { enabled: metadata.enabled }
        : config.visibility
          ? { enabled: config.visibility === "visible" }
          : {}),
      ...(metadata.expectedRevision === undefined
        ? {}
        : { expectedRevision: metadata.expectedRevision }),
      compat,
    });
    return this.afterMutation(actor);
  }
  private async reorder(actor: LocalActor, value: unknown) {
    const ids = z.array(providerId).parse(value);
    const current = await this.deps.modelProviders.listInstances(actor);
    if (
      ids.length !== current.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !current.some((instance) => instance.id === id))
    )
      throw new CodeUiRepositoryError(
        "revision_conflict",
        "供应商成员已变化，请刷新后重新排序。",
      );
    await this.deps.preferences.updateHumanPreferences(
      await this.deps.instanceId(actor),
      { codeUiProviderOrder: ids },
    );
    return this.afterMutation(actor);
  }
  private async resolveModel(actor: LocalActor, value: unknown) {
    const input = z
      .object({
        providerId,
        modelId,
        originalModelId: modelId.optional(),
        personalConfig: modelConfigDataSchema.optional(),
      })
      .strict()
      .parse(value);
    const instance = await this.loadChat(actor, input.providerId);
    const model = instance.models.find(
      (entry) =>
        entry.id === (input.originalModelId ?? input.modelId) &&
        entry.capability === "chat",
    );
    const entry = model
      ? codeUiModelEntry(instance, { ...model, id: input.modelId })
      : codeUiModelEntry(instance, codeUiNativeModel(input.modelId, {}));
    const resolved = resolveCodeUiModelConfig(
      instance,
      entry,
      input.personalConfig
        ? { config: input.personalConfig, useRecommendedConfig: true }
        : undefined,
    );
    return {
      inheritedConfig: resolved.inherited.toJSON(),
      effectiveConfig: resolved.effective.toJSON(),
      issues: resolved.complete.ok ? [] : resolved.complete.issues,
    };
  }
  private async connectivity(
    actor: LocalActor,
    value: unknown,
  ): Promise<ModelConnectivityResult> {
    const input = z
      .object({
        providerId,
        modelId,
        workspacePath: z.string().optional(),
        workspaceIdentity: z.string().optional(),
        projectId: providerId.optional(),
      })
      .parse(value);
    const instance = await this.loadChat(actor, input.providerId);
    if (!instance.enabled || !instance.hasCredential)
      return {
        success: false,
        error: {
          code: "provider-unavailable",
          message: "供应商未启用或未配置凭证。",
        },
      };
    const model = (await this.readViews(actor)).settings.providers
      .find((entry) => entry.providerId === input.providerId)
      ?.models.find((entry) => entry.modelId === input.modelId);
    if (!model?.executable)
      return {
        success: false,
        error: {
          code: "model-unavailable",
          message: "模型未启用或配置不可执行。",
        },
      };
    return this.deps.testConnectivity(actor, {
      providerId: input.providerId,
      modelId: input.modelId,
      ...(input.workspacePath === undefined
        ? {}
        : { workspacePath: input.workspacePath }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });
  }

  async call(
    actor: LocalActor,
    service: string,
    method: string,
    args: unknown[],
  ): Promise<{ result: unknown } | null> {
    if (service === "modelSelectionService" && method === "getView") {
      const input = z
        .object({ selection: modelSelectionSchema.nullable() })
        .optional()
        // 原ServiceProxy调用getView(undefined)时，HTTP参数数组中的undefined编码为null。
        .parse(args[0] ?? undefined);
      return {
        result: (await this.readViews(actor, input?.selection)).selection,
      };
    }
    if (service !== "providerSettingsService") return null;
    if (method === "getView") return { result: await this.settingsView(actor) };
    if (method === "refresh")
      return { result: await this.afterMutation(actor) };
    if (method === "getModelDefaults") {
      const settings = await this.deps.settings.getInstanceSettings(
        actor,
        await this.deps.instanceId(actor),
      );
      return { result: modelDefaultsSchema.parse(settings.modelDefaults) };
    }
    if (method === "saveModelDefaults") {
      const settings = await this.deps.settings.updateInstanceSettings(
        actor,
        await this.deps.instanceId(actor),
        { modelDefaults: modelDefaultsSchema.parse(args[0]) },
      );
      await this.afterMutation(actor);
      return { result: modelDefaultsSchema.parse(settings.modelDefaults) };
    }
    if (method === "saveManagedProvider")
      return this.serialized(actor, async () => {
        const input = managedProviderPatchSchema.parse(args[0]);
        await this.deps.modelProviders.updateInstance(
          actor,
          input.providerId,
          input.patch,
        );
        return { result: await this.afterMutation(actor) };
      });
    if (method === "saveManagedModel")
      return this.serialized(actor, async () => {
        await saveManagedModel(this.deps.modelProviders, actor, args[0]);
        return { result: await this.afterMutation(actor) };
      });
    if (method === "resolveModelConfig")
      return { result: await this.resolveModel(actor, args[0]) };
    if (method === "testModelConnectivity")
      return { result: await this.connectivity(actor, args[0]) };
    if (!providerMethods.has(method) && !this.models.supports(method))
      return null;
    return this.serialized(actor, async () => {
      if (this.models.supports(method)) {
        await this.models.call(actor, method, args);
        return { result: await this.afterMutation(actor) };
      }
      if (method === "createPersonalProvider")
        return { result: await this.create(actor, args[0]) };
      if (method === "savePersonalProviderOverlay")
        return { result: await this.saveOverlay(actor, args) };
      if (method === "reorderPersonalProviders")
        return { result: await this.reorder(actor, args[0]) };
      const id = providerId.parse(args[0]);
      await this.load(actor, id);
      await this.deps.modelProviders.deleteInstance(actor, id);
      return { result: await this.afterMutation(actor) };
    });
  }
}

export function createCodeUiProviderSettingsRpc(
  deps: CodeUiProviderSettingsRpcDeps,
): CodeUiProviderSettingsRpc {
  return new ProviderSettingsRpc(deps);
}
