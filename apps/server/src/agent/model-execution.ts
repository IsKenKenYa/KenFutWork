import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { LocalActor } from "../features/local-instance/types.js";
import { resolveModelInputCapabilities } from "../features/model-providers/input-capabilities.js";
import type { ModelCatalogService } from "../features/model-providers/model-catalog-service.js";
import { parseInstanceSpecifier } from "../features/model-providers/model-catalog-service.js";
import type { ModelProviderService } from "../features/model-providers/model-provider-service.js";
import {
  type HeaderRenderContext,
  instanceHeadersOption,
} from "../providers/instance-headers.js";
import { resolveInstanceChatModel } from "../providers/resolve.js";
import type { ModelInvocationSnapshot } from "../providers/types.js";
import {
  MODEL_USAGE_OWNER_METADATA,
  type ModelUsageOwner,
} from "./model-call-usage.js";
import type { AgentRunModelControl } from "./run-extension.js";

/** 可信Run的冻结模型解析；凭据只交协议适配器，不进入调用归属或持久意图。 */
export async function resolveInstanceModelExecution(options: {
  actor: LocalActor;
  specifier: string;
  invocation?: ModelInvocationSnapshot | undefined;
  providers: Pick<ModelProviderService, "resolveCredentials">;
  catalog?: Pick<ModelCatalogService, "validateSpecifier"> | undefined;
  headers: HeaderRenderContext;
}): Promise<{
  model: BaseLanguageModel;
  owner: ModelUsageOwner;
  capabilities: { image: boolean; pdf: boolean };
}> {
  const spec = parseInstanceSpecifier(options.specifier);
  if (!spec) throw new Error("模型执行需要真实供应商实例选择。");
  if (options.catalog) {
    const verdict = await options.catalog.validateSpecifier(
      options.actor,
      options.specifier,
    );
    if (!verdict.ok) throw new Error(verdict.message);
  }
  const credentials = await options.providers.resolveCredentials(
    options.actor,
    spec.instanceId,
  );
  const invocation = options.invocation;
  if (
    invocation &&
    (invocation.providerId !== credentials.instanceId ||
      invocation.modelId !== spec.model ||
      invocation.configRevision !== credentials.configRevision)
  )
    throw new Error("本轮供应商或模型配置已改变，请重新确认模型选择后发送。");
  const row = credentials.models?.find((model) => model.id === spec.model);
  const useResponsesApi =
    invocation?.useResponsesApi ?? credentials.useResponsesApi;
  const model = resolveInstanceChatModel(
    credentials.protocol,
    spec.model,
    {
      apiKey: credentials.apiKey,
      ...(useResponsesApi === undefined ? {} : { useResponsesApi }),
      ...(credentials.responsesApi === undefined
        ? {}
        : { responsesApi: credentials.responsesApi }),
      ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
      ...instanceHeadersOption(credentials.headers, options.headers),
    },
    invocation?.body ?? row?.extraBody,
  );
  const owner: ModelUsageOwner = {
    provider: "instance",
    model: spec.model,
    providerInstanceId: spec.instanceId,
    ...(invocation ? { configRevision: invocation.configRevision } : {}),
  };
  model.metadata = { ...model.metadata, [MODEL_USAGE_OWNER_METADATA]: owner };
  return {
    model,
    owner,
    capabilities: {
      ...(invocation?.inputCapabilities ??
        resolveModelInputCapabilities(row ?? {})),
    },
  };
}

/** 单Run的当前模型；选择先冻结，模型请求入口在native输入提交后激活。 */
export function createRunModelControl(options: {
  initialModel: BaseLanguageModel;
  initialInvocation?: ModelInvocationSnapshot | undefined;
  resolve(
    invocation: ModelInvocationSnapshot,
  ): ReturnType<typeof resolveInstanceModelExecution>;
  validate(): Promise<void>;
  apply(
    execution: Awaited<ReturnType<typeof resolveInstanceModelExecution>>,
    invocation: ModelInvocationSnapshot,
  ): Promise<void>;
}): AgentRunModelControl {
  let activeModel = options.initialModel;
  let active = options.initialInvocation;
  let desired = active;
  return {
    selectInvocation(invocation) {
      desired = structuredClone(invocation);
    },
    async resolveCurrent() {
      const selected = desired;
      if (!selected || JSON.stringify(selected) === JSON.stringify(active))
        return activeModel;
      await options.validate();
      const execution = await options.resolve(selected);
      await options.validate();
      await options.apply(execution, selected);
      activeModel = execution.model;
      active = selected;
      return activeModel;
    },
  };
}
