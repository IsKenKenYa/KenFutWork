import type { ModelInvocationSnapshot } from "../../providers/types.js";
import { compileCodeUiModelExecution } from "../code-ui/model-execution-options.js";
import type { LocalActor } from "../local-instance/types.js";
import type { ModelCatalogService } from "../model-providers/model-catalog-service.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";
import { buildCodeUiModelViews } from "../model-providers/model-views.js";
import type { SettingsService } from "../settings/settings-service.js";
import { DesignTaskError } from "./design-task-errors.js";

export interface DesignModelSelection {
  capture(actor: LocalActor, model?: string): Promise<ModelInvocationSnapshot>;
  validate(actor: LocalActor, snapshot: ModelInvocationSnapshot): Promise<void>;
}
export const designModelSpecifier = (snapshot: ModelInvocationSnapshot) =>
  `${snapshot.providerId}:${snapshot.modelId}`;
export function createDesignModelSelection(deps: {
  modelProviders: Pick<
    ModelProviderService,
    "listInstances" | "resolveCredentials"
  >;
  modelCatalog: Pick<ModelCatalogService, "listCatalog" | "validateSpecifier">;
  settings: Pick<SettingsService, "getInstanceSettings">;
}): DesignModelSelection {
  const invalid = (message: string) =>
    new DesignTaskError("design_model_invalid", message);
  return {
    async capture(actor, model) {
      const [instances, catalog, settings] = await Promise.all([
        deps.modelProviders.listInstances(actor),
        deps.modelCatalog.listCatalog(actor),
        deps.settings.getInstanceSettings(actor, actor.instanceId),
      ]);
      const preferred = model ?? settings.defaultModel;
      const selection = buildCodeUiModelViews({
        instances,
        catalog,
        defaultSpecifier: preferred,
      }).selection.preferredSelection;
      if (
        !selection ||
        (model && `${selection.providerId}:${selection.modelId}` !== model)
      )
        throw invalid("所选模型不可用，请到供应商设置检查");
      try {
        return compileCodeUiModelExecution({ instances, catalog, selection });
      } catch (error) {
        throw invalid(
          error instanceof Error
            ? error.message
            : "模型配置不可用，请到供应商设置检查",
        );
      }
    },
    async validate(actor, snapshot) {
      const result = await deps.modelCatalog.validateSpecifier(
        actor,
        designModelSpecifier(snapshot),
      );
      if (!result.ok) throw invalid(result.message);
      const current = await deps.modelProviders.resolveCredentials(
        actor,
        snapshot.providerId,
      );
      if (
        current.instanceId !== snapshot.providerId ||
        current.configRevision !== snapshot.configRevision
      )
        throw invalid("本轮供应商或模型配置已改变，请重新确认模型选择后发送。");
    },
  };
}
