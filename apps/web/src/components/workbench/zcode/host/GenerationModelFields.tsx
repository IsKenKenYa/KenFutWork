import {
  modelCapabilitySchema,
  type ProviderInstanceModel,
  providerInstanceModelSchema,
} from "@kenfutwork/shared";
import { Input } from "@zui/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import { Fragment, useId, useState } from "react";

/** 共享契约负责校验，原Dialog只展示可读字段错误。 */
export function parseGenerationModelDraft(
  model: ProviderInstanceModel,
): ProviderInstanceModel {
  const result = providerInstanceModelSchema.safeParse(model);
  if (result.success) return result.data;
  const messages: Record<string, string> = {
    id: "请填写模型 ID。",
    name: "请填写模型名称。",
    durations: "时长需填写正数。",
    modes: "请填写有效的图像模式。",
    maxInputImages: "参考图上限需填写非负整数。",
    referenceImages: "参考图上限需填写非负整数。",
    aspectRatios: "请填写有效的画幅。",
    resolutions: "请填写有效的分辨率。",
  };
  const field = result.error.issues[0]?.path.find(
    (part) => typeof part === "string" && part in messages,
  );
  throw new Error(
    typeof field === "string" ? messages[field] : "模型配置无效，请检查输入。",
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  const id = useId();
  // 原文属于本次弹窗草稿，失焦解析及校验失败不能将用户输入替换成规范化值。
  const [text, setText] = useState(value);
  return (
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={id} className="text-ui-base text-foreground-subtle">
        {label}
      </label>
      <Input
        id={id}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => onChange(text)}
        className="w-56"
      />
    </div>
  );
}

function BooleanField({
  label,
  value,
  onChange,
  trueLabel = "支持",
  falseLabel = "不支持",
}: {
  label: string;
  value: boolean | undefined;
  onChange(value: boolean | undefined): void;
  trueLabel?: string;
  falseLabel?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={id} className="text-ui-base text-foreground-subtle">
        {label}
      </label>
      <Select
        value={value === undefined ? "default" : value ? "yes" : "no"}
        onValueChange={(next) =>
          onChange(next === "default" ? undefined : next === "yes")
        }
      >
        <SelectTrigger id={id} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">未知</SelectItem>
          <SelectItem value="yes">{trueLabel}</SelectItem>
          <SelectItem value="no">{falseLabel}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/** 只编辑真实生成声明；空字段清除声明，不物化虚构能力。 */
export function GenerationModelFields({
  model,
  onChange,
}: {
  model: ProviderInstanceModel;
  onChange(model: ProviderInstanceModel): void;
}) {
  const capabilityId = useId();
  const changeVideo = (patch: Record<string, unknown>) => {
    const next = { ...model.videoGeneration, ...patch };
    for (const key of Object.keys(next))
      if (next[key as keyof typeof next] === undefined)
        delete next[key as keyof typeof next];
    onChange({ ...model, videoGeneration: next });
  };
  const changeImage = (patch: Record<string, unknown>) => {
    const next = { ...model.imageGeneration, ...patch };
    for (const key of Object.keys(next))
      if (next[key as keyof typeof next] === undefined)
        delete next[key as keyof typeof next];
    onChange({ ...model, imageGeneration: next });
  };
  const list = (value: string) =>
    value.trim()
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : undefined;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <label
          htmlFor={capabilityId}
          className="text-ui-base text-foreground-subtle"
        >
          用途
        </label>
        <Select
          value={model.capability}
          onValueChange={(value) =>
            onChange({
              ...model,
              capability: modelCapabilitySchema.parse(value),
            })
          }
        >
          <SelectTrigger id={capabilityId} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="image">图像</SelectItem>
            <SelectItem value="image-edit">图像编辑</SelectItem>
            <SelectItem value="video">视频</SelectItem>
            <SelectItem value="audio">音频</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <TextField
        label="模型 ID"
        value={model.id}
        onChange={(id) => onChange({ ...model, id })}
      />
      <TextField
        label="名称"
        value={model.name}
        onChange={(name) => onChange({ ...model, name })}
      />
      {model.capability === "video" ? (
        <Fragment key="video">
          <TextField
            label="时长"
            value={model.videoGeneration?.durations?.join(",") ?? ""}
            onChange={(value) =>
              changeVideo({ durations: list(value)?.map(Number) })
            }
          />
          <TextField
            label="画幅"
            value={model.videoGeneration?.aspectRatios?.join(",") ?? ""}
            onChange={(value) => changeVideo({ aspectRatios: list(value) })}
          />
          <TextField
            label="分辨率"
            value={model.videoGeneration?.resolutions?.join(",") ?? ""}
            onChange={(value) => changeVideo({ resolutions: list(value) })}
          />
          <TextField
            label="参考图上限"
            value={model.videoGeneration?.referenceImages?.toString() ?? ""}
            onChange={(value) =>
              changeVideo({
                referenceImages: value.trim() ? Number(value) : undefined,
              })
            }
          />
          <BooleanField
            label="首尾帧"
            value={model.videoGeneration?.firstLastFrame}
            onChange={(firstLastFrame) => changeVideo({ firstLastFrame })}
          />
          <BooleanField
            label="负向提示"
            value={model.videoGeneration?.negativePrompt}
            onChange={(negativePrompt) => changeVideo({ negativePrompt })}
          />
          <BooleanField
            label="音频"
            value={model.videoGeneration?.audio}
            onChange={(audio) => changeVideo({ audio })}
          />
        </Fragment>
      ) : model.capability === "image" || model.capability === "image-edit" ? (
        <Fragment key="image">
          <TextField
            label="模式"
            value={model.imageGeneration?.modes?.join(",") ?? ""}
            onChange={(value) => changeImage({ modes: list(value) })}
          />
          <TextField
            label="参考图上限"
            value={model.imageGeneration?.maxInputImages?.toString() ?? ""}
            onChange={(value) =>
              changeImage({
                maxInputImages: value.trim() ? Number(value) : undefined,
              })
            }
          />
          <BooleanField
            label="提示词"
            trueLabel="必填"
            falseLabel="可空"
            value={model.imageGeneration?.requirePrompt}
            onChange={(requirePrompt) => changeImage({ requirePrompt })}
          />
        </Fragment>
      ) : null}
    </div>
  );
}
