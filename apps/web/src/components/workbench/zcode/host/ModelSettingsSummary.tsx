import type { ProviderSettingsFormModel } from "@zui/lib/providerSettingsFormTypes.js";

export const MODEL_KIND_LABELS = {
  chat: "对话",
  image: "图片",
  video: "视频",
  audio: "音频",
} as const;
export type ModelKind = keyof typeof MODEL_KIND_LABELS;
export function modelKind(model: ProviderSettingsFormModel): ModelKind {
  const capability = model.native?.capability ?? "chat";
  return capability === "image-edit" ? "image" : capability;
}

export function modelCapabilitySummary(
  model: ProviderSettingsFormModel,
): string {
  const native = model.native;
  if (native?.capability === "video") {
    const caps = native.videoGeneration;
    return (
      [
        caps?.firstLastFrame === true ? "首尾帧" : undefined,
        caps?.referenceImages ? "参考图" : undefined,
        caps?.resolutions?.join(" / "),
        caps?.durations?.map((value) => `${value}s`).join(" / "),
        caps?.audio === true ? "生成音频" : undefined,
      ]
        .filter(Boolean)
        .join(" · ") || "能力待确认"
    );
  }
  if (native?.capability === "image" || native?.capability === "image-edit") {
    const caps = native.imageGeneration;
    const modes = {
      generate: "文生图",
      edit: "图生图",
      upscale: "放大",
      remix: "重绘",
      merge: "合成",
    };
    return (
      [
        caps?.modes?.map((mode) => modes[mode]).join(" / "),
        caps?.qualities?.join(" / "),
        caps?.maxOutputs ? `单次${caps.maxOutputs}张` : undefined,
      ]
        .filter(Boolean)
        .join(" · ") || "能力待确认"
    );
  }
  if (native?.capability === "audio") return "音频";
  const properties = model.config.properties;
  return (
    [
      properties?.inputFormat?.supportsImage ? "视觉输入" : undefined,
      properties?.supportsToolCall ? "工具调用" : undefined,
      properties?.contextWindow
        ? `${properties.contextWindow.toLocaleString()} Token`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || "能力待确认"
  );
}

export function ModelSettingsSummary({
  model,
  inputTestId,
}: {
  model: ProviderSettingsFormModel;
  inputTestId?: string | undefined;
}) {
  return (
    <>
      <div className="min-w-0 flex-1 py-1">
        {model.native?.name && model.native.name !== model.modelId ? (
          <div className="truncate text-ui-base text-foreground">
            {model.native.name}
          </div>
        ) : null}
        <div
          data-testid={inputTestId}
          title={model.modelId}
          className="truncate font-mono text-ui-sm text-foreground-subtle"
        >
          {model.modelId}
        </div>
      </div>
      <span className="hidden w-20 shrink-0 text-ui-xs text-foreground-subtle lg:block">
        {MODEL_KIND_LABELS[modelKind(model)]}
      </span>
      <span className="hidden w-[30%] text-ui-sm text-foreground-subtle lg:block">
        {modelCapabilitySummary(model)}
      </span>
    </>
  );
}

export function ProviderNavigationSummary({
  label,
  models,
}: {
  label: string;
  models?: readonly ProviderSettingsFormModel[] | undefined;
}) {
  const counts = Object.entries(MODEL_KIND_LABELS).flatMap(([key, name]) => {
    const count =
      models?.filter((model) => modelKind(model) === key).length ?? 0;
    return count ? [`${name} ${count}`] : [];
  });
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 max-md:sr-only">
      <span className="truncate">{label}</span>
      {models ? (
        <span className="truncate text-ui-xs font-normal text-foreground-subtle">
          {counts.join(" · ") || "未添加模型"}
        </span>
      ) : null}
    </span>
  );
}
