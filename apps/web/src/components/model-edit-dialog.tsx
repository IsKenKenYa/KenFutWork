"use client";

import type { ProviderInstanceModel } from "@kenfutwork/shared";
import { useState } from "react";

/**
 * 模型详情编辑弹窗（参考 BYOK 产品形态：供应商详情 → 模型行 → 编辑）。
 *
 * 编辑范围 = 模型的**详情声明**（上下文/最大输出/输入类型/能力/思考档位/
 * 推理参数映射）；模型 ID 与名称在供应商表单里改。缺省字段 = 未知，
 * 提交时剔除（不发出「显式未知」）。
 */

const INPUT_MODALITY_CHIPS = ["文本", "图片", "视频", "PDF"] as const;
const MODALITY_BY_CHIP: Record<(typeof INPUT_MODALITY_CHIPS)[number], string> =
  {
    文本: "text",
    图片: "image",
    视频: "video",
    PDF: "pdf",
  };

type DialogState = {
  contextWindow: string;
  maxOutputTokens: string;
  vision: boolean;
  inputModalities: string[];
  structuredOutput: boolean;
  nativeWebSearch: boolean;
  systemMessage: boolean;
  reasoningEfforts: string[];
  newEffort: string;
  extraBodyText: string;
  extraBodyError: string | null;
};

function initialState(model: ProviderInstanceModel): DialogState {
  return {
    contextWindow:
      model.contextWindow != null ? String(model.contextWindow) : "",
    maxOutputTokens:
      model.maxOutputTokens != null ? String(model.maxOutputTokens) : "",
    vision: model.vision ?? false,
    inputModalities: model.inputModalities ?? ["text"],
    structuredOutput: model.structuredOutput ?? false,
    nativeWebSearch: model.nativeWebSearch ?? false,
    systemMessage: model.systemMessage ?? false,
    reasoningEfforts: model.reasoningEfforts ?? [],
    newEffort: "",
    extraBodyText: model.extraBody
      ? JSON.stringify(model.extraBody, null, 2)
      : "",
    extraBodyError: null,
  };
}

/** 弹窗状态 → 提交补丁（空值剔除 = 恢复「未知」；extraBody 非法时返回 null）。 */
function toPatch(
  model: ProviderInstanceModel,
  state: DialogState,
): Partial<ProviderInstanceModel> | null {
  const contextWindow = Number.parseInt(state.contextWindow, 10);
  const maxOutputTokens = Number.parseInt(state.maxOutputTokens, 10);
  let extraBody: Record<string, unknown> | undefined;
  if (state.extraBodyText.trim()) {
    try {
      const parsed: unknown = JSON.parse(state.extraBodyText);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return null;
      }
      extraBody = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return {
    id: model.id,
    name: model.name,
    capability: model.capability,
    ...(Number.isFinite(contextWindow) && contextWindow > 0
      ? { contextWindow }
      : {}),
    ...(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
      ? { maxOutputTokens }
      : {}),
    ...(state.vision ? { vision: true } : {}),
    ...(state.inputModalities.length > 0
      ? { inputModalities: state.inputModalities }
      : {}),
    ...(state.structuredOutput ? { structuredOutput: true } : {}),
    ...(state.nativeWebSearch ? { nativeWebSearch: true } : {}),
    ...(state.systemMessage ? { systemMessage: true } : {}),
    ...(state.reasoningEfforts.length > 0
      ? { reasoningEfforts: state.reasoningEfforts }
      : {}),
    ...(extraBody ? { extraBody } : {}),
  };
}

function Chip({
  label,
  checked,
  locked,
  title,
  onToggle,
}: {
  label: string;
  checked: boolean;
  locked?: boolean;
  title?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={locked}
      title={title}
      onClick={onToggle}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${
        checked
          ? "border-primary/60 bg-primary/10 text-primary"
          : "text-muted-foreground"
      } ${locked ? "opacity-70" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        readOnly
        className="pointer-events-none"
      />
      {label}
      {locked ? "🔒" : null}
    </button>
  );
}

export function ModelEditDialog({
  model,
  saving,
  onSave,
  onClose,
}: {
  model: ProviderInstanceModel;
  saving: boolean;
  onSave: (model: ProviderInstanceModel) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<DialogState>(() => initialState(model));

  const patch = toPatch(model, state);

  const _submit = () => {
    if (!patch) {
      return;
    }
    onSave(patch as ProviderInstanceModel);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-label="编辑模型配置"
    >
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border bg-card p-5 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h4 className="text-base font-medium">编辑模型配置</h4>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="text-muted-foreground"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <p>模型 ID</p>
            <p className="font-mono text-sm text-foreground">{model.id}</p>
          </div>
          <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            上下文窗口（token）
            <input
              inputMode="numeric"
              value={state.contextWindow}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  contextWindow: e.target.value.replace(/[^0-9]/g, ""),
                }))
              }
              placeholder="如 128000"
              className="w-44 rounded-md border px-3 py-1.5 font-mono text-sm"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            最大输出 Token
            <input
              inputMode="numeric"
              value={state.maxOutputTokens}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  maxOutputTokens: e.target.value.replace(/[^0-9]/g, ""),
                }))
              }
              placeholder="如 32000"
              className="w-44 rounded-md border px-3 py-1.5 font-mono text-sm"
            />
          </label>

          <details className="rounded-md border border-dashed p-3">
            <summary className="cursor-pointer text-sm">高级配置</summary>
            <div className="mt-3 space-y-4">
              <div>
                <p className="text-xs text-muted-foreground">输入类型</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {INPUT_MODALITY_CHIPS.map((chip) => {
                    const modality = MODALITY_BY_CHIP[chip];
                    const checked = state.inputModalities.includes(modality);
                    const locked = chip === "文本";
                    return (
                      <Chip
                        key={chip}
                        label={chip}
                        checked={checked}
                        locked={locked}
                        onToggle={() =>
                          setState((s) => ({
                            ...s,
                            inputModalities: checked
                              ? s.inputModalities.filter((m) => m !== modality)
                              : [...s.inputModalities, modality],
                          }))
                        }
                      />
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">模型能力</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <Chip
                    label="结构化输出"
                    checked={state.structuredOutput}
                    onToggle={() =>
                      setState((s) => ({
                        ...s,
                        structuredOutput: !s.structuredOutput,
                      }))
                    }
                  />
                  <Chip
                    label="原生联网搜索"
                    checked={state.nativeWebSearch}
                    onToggle={() =>
                      setState((s) => ({
                        ...s,
                        nativeWebSearch: !s.nativeWebSearch,
                      }))
                    }
                  />
                  <Chip
                    label="对话中系统消息"
                    checked={state.systemMessage}
                    onToggle={() =>
                      setState((s) => ({
                        ...s,
                        systemMessage: !s.systemMessage,
                      }))
                    }
                  />
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  思考档位（从低到高）
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  {state.reasoningEfforts.map((effort, index) => (
                    <button
                      key={effort}
                      type="button"
                      className="rounded-md border px-2.5 py-1.5 text-xs"
                      title="点击移除该档位"
                      onClick={() =>
                        setState((s) => ({
                          ...s,
                          reasoningEfforts: s.reasoningEfforts.filter(
                            (_, i) => i !== index,
                          ),
                        }))
                      }
                    >
                      {effort} ✕
                    </button>
                  ))}
                  <form
                    aria-label="添加思考档位"
                    className="flex items-center gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const effort = state.newEffort.trim();
                      if (!effort) return;
                      setState((s) => ({
                        ...s,
                        reasoningEfforts: [...s.reasoningEfforts, effort],
                        newEffort: "",
                      }));
                    }}
                  >
                    <input
                      value={state.newEffort}
                      onChange={(e) =>
                        setState((s) => ({ ...s, newEffort: e.target.value }))
                      }
                      placeholder="新档位"
                      className="w-24 rounded-md border px-2 py-1 text-xs"
                    />
                    <button
                      type="submit"
                      className="rounded-md border px-2 py-1 text-xs"
                    >
                      +
                    </button>
                  </form>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">推理参数映射</p>
                <p className="mb-1 text-xs text-muted-foreground">
                  键值并入请求体顶层 · 如{" "}
                  <code>{'{"thinking":{"type":"enabled"}}'}</code>
                </p>
                <textarea
                  aria-label="推理参数映射"
                  rows={5}
                  value={state.extraBodyText}
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      extraBodyText: e.target.value,
                      extraBodyError: null,
                    }))
                  }
                  className="mt-1 w-full rounded-md border px-3 py-2 font-mono text-xs"
                />
                {state.extraBodyError ? (
                  <p className="mt-1 text-xs text-destructive">
                    {state.extraBodyError}
                  </p>
                ) : null}
              </div>
            </div>
          </details>
        </div>

        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setState(initialState(model))}
            className="text-xs text-muted-foreground underline"
          >
            重置表单
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border px-4 py-2 text-sm"
            >
              取消
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                if (patch === null) {
                  setState((s) => ({
                    ...s,
                    extraBodyError: "推理参数映射必须是 JSON 对象",
                  }));
                  return;
                }
                onSave(patch as ProviderInstanceModel);
              }}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
