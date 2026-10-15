import {
  type ModelDefaults,
  type ModelManagementService,
  type ModelReference,
  modelDefaultsSchema,
} from "@kenfutwork/shared";
import { Button } from "@zui/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import { useProviderSettingsServiceView } from "@zui/hooks/useProviderSettingsView.js";
import { useServices } from "@zui/hooks/useServices.js";
import { projectProviderSettingsViewToFormProviders } from "@zui/lib/providerSettingsFormProjection.js";
import { useEffect, useRef, useState } from "react";
import { MODEL_KIND_LABELS, modelKind } from "./ModelSettingsSummary.js";

const referenceValue = (reference: ModelReference) =>
  JSON.stringify([reference.providerId, reference.modelId]);

/** 与运行时消费的实例 modelDefaults 共用原ProviderSettings通道。 */
function useModelDefaults() {
  const { providerSettingsService } = useServices();
  const service = providerSettingsService as ModelManagementService;
  const read = useProviderSettingsServiceView(providerSettingsService);
  const view = read.state.status === "ready" ? read.state.view : null;
  const [defaults, setDefaults] = useState<ModelDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const busy = useRef(false);
  const revision = view?.revision;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 权威修订和显式重试均需重新加载实例默认策略。
  useEffect(() => {
    const current = ++epoch.current;
    setLoading(true);
    void service
      .getModelDefaults()
      .then((value) => {
        if (epoch.current !== current) return;
        setDefaults(modelDefaultsSchema.parse(value));
        setError(null);
      })
      .catch((reason) => {
        if (epoch.current === current)
          setError(
            reason instanceof Error
              ? reason.message
              : "默认模型加载失败，请重试。",
          );
      })
      .finally(() => {
        if (epoch.current === current) setLoading(false);
      });
    return () => {
      epoch.current++;
    };
  }, [service, revision, retry]);
  const save = async (
    kind: "chat" | "image" | "video",
    reference: ModelReference | null,
  ) => {
    if (!defaults || busy.current) return;
    busy.current = true;
    epoch.current++;
    setSaving(true);
    setLoading(false);
    setError(null);
    const next = {
      ...defaults,
      [kind]:
        kind === "chat"
          ? reference
          : reference
            ? { mode: "manual", models: [reference] }
            : { mode: "auto" },
    };
    try {
      const saved = await service.saveModelDefaults(
        modelDefaultsSchema.parse(next),
      );
      epoch.current++;
      setDefaults(modelDefaultsSchema.parse(saved));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "默认模型保存失败，请重试。",
      );
    } finally {
      busy.current = false;
      setSaving(false);
      setLoading(false);
    }
  };
  return {
    view,
    defaults,
    error,
    loading,
    saving,
    save,
    retry: () => setRetry((value) => value + 1),
  };
}

export function ModelDefaultsSection() {
  const { view, defaults, error, loading, saving, save, retry } =
    useModelDefaults();
  const providers = view
    ? projectProviderSettingsViewToFormProviders(view)
    : [];
  return (
    <section
      aria-label="默认模型"
      className="space-y-3 rounded-lg border border-border bg-surface p-3"
    >
      <h3 className="text-ui-base font-medium">默认模型</h3>
      <div className="flex flex-wrap gap-x-4 gap-y-3">
        {(["chat", "image", "video"] as const).map((kind) => {
          const policy = defaults?.[kind];
          const references =
            kind === "chat"
              ? defaults?.chat
                ? [defaults.chat]
                : []
              : policy && "mode" in policy && policy.mode === "manual"
                ? policy.models
                : [];
          const selected =
            references.length > 1
              ? "multiple"
              : references[0]
                ? referenceValue(references[0])
                : "auto";
          const choices = providers
            .filter((provider) => provider.enabled)
            .flatMap((provider) =>
              provider.models
                .filter(
                  (model) =>
                    model.config.enabled !== false && modelKind(model) === kind,
                )
                .map((model) => ({
                  reference: {
                    providerId: provider.providerId,
                    modelId: model.modelId,
                  },
                  label: `${provider.providerName || provider.providerId} / ${model.native?.name || model.modelId}`,
                })),
            );
          return (
            <div
              key={kind}
              className="flex min-w-56 flex-1 items-center justify-between gap-3"
            >
              <span className="shrink-0 text-ui-sm text-foreground-subtle">
                {MODEL_KIND_LABELS[kind]}
              </span>
              <Select
                value={selected}
                disabled={loading || saving || !defaults}
                onValueChange={(value) => {
                  const reference =
                    choices.find(
                      (choice) => referenceValue(choice.reference) === value,
                    )?.reference ?? null;
                  void save(kind, reference);
                }}
              >
                <SelectTrigger
                  aria-label={`默认${MODEL_KIND_LABELS[kind]}模型`}
                  className="w-48 min-w-0"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">自动</SelectItem>
                  {selected === "multiple" ? (
                    <SelectItem value="multiple" disabled>
                      多模型（{references.length}）
                    </SelectItem>
                  ) : null}
                  {references.length === 1 &&
                  !choices.some(
                    (choice) => referenceValue(choice.reference) === selected,
                  ) ? (
                    <SelectItem value={selected} disabled>
                      模型不可用
                    </SelectItem>
                  ) : null}
                  {choices.map((choice) => (
                    <SelectItem
                      key={referenceValue(choice.reference)}
                      value={referenceValue(choice.reference)}
                    >
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 text-ui-sm text-destructive"
        >
          <span>{error}</span>
          <Button size="sm" variant="ghost" onClick={retry}>
            重试
          </Button>
        </div>
      ) : null}
    </section>
  );
}
