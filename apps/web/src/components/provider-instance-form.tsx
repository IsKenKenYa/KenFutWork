"use client";

import type {
  ProviderInstanceCreateRequest,
  ProviderInstanceResponse,
  ProviderInstanceUpdateRequest,
} from "@kenfutwork/shared";
import { Fragment, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseHeadersJson, providerHeadersHint } from "@/lib/provider-headers";
import { fetchProviderPresets, type ProviderPreset } from "@/lib/server-api";

const PROTOCOLS = [
  { value: "openai-compatible", label: "OpenAI 兼容" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
  { value: "google-image", label: "Google 图像" },
  { value: "replicate", label: "Replicate" },
  { value: "volces", label: "火山引擎" },
  { value: "metaso", label: "Metaso 视频" },
] as const;

/** 预设 id → 线协议（快照 provider 的官方网关所属生态；其余默认 OpenAI 兼容）。 */
const PRESET_PROTOCOL: Record<string, string> = {
  anthropic: "anthropic",
  google: "gemini",
};

const CAPABILITIES = [
  { value: "chat", label: "对话" },
  { value: "image", label: "图像" },
  { value: "image-edit", label: "图像编辑" },
  { value: "video", label: "视频" },
] as const;

type ModelRow = {
  uid: string;
  id: string;
  name: string;
  capability: "chat" | "image" | "image-edit" | "video";
  /** 详情（可选声明，缺省 = 未知）：字符串态便于输入框直填。 */
  contextWindow?: string;
  maxOutputTokens?: string;
  vision?: boolean;
  /** 逗号分隔思考档位（如「低,中,高,最高」）；空 = 全档位。 */
  reasoningEfforts?: string;
};

type HeaderRow = { uid: string; key: string; value: string };

let rowUidCounter = 0;
const nextRowUid = (): string => {
  rowUidCounter += 1;
  return `row-${rowUidCounter}`;
};

const emptyModelRow = (): ModelRow => ({
  uid: nextRowUid(),
  id: "",
  name: "",
  capability: "chat",
});

/**
 * 供应商实例表单（新建 / 编辑同一张表，避免两套字段漂移）。
 *
 * 形态（2026-09-19 用户口径）：
 * - 新建时优先「从预设选择」——models.dev 供应商列表（名称/网关/模型清单
 *   自动预填），不再要求手写模型 JSON；
 * - 模型清单用结构化行编辑器（ID / 显示名 / 能力 / 删除）；
 * - 裸 JSON（模型清单、自定义请求头）收进「高级设置」折叠区，面向高级用户。
 *
 * 只写字段的口径（凭证红线）不变：
 * - `apiKey` 编辑时留空 = 不改；
 * - 自定义头值同理：留空 = 保留已存的（表单列出已存键名），高级 JSON 填 `{}` = 清空。
 */
export function ProviderInstanceForm({
  editing,
  accessToken,
  submitting,
  onCancel,
  onError,
  onSubmitCreate,
  onSubmitUpdate,
}: {
  editing?: ProviderInstanceResponse | undefined;
  accessToken: string;
  submitting: boolean;
  onCancel: () => void;
  onError: (message: string) => void;
  onSubmitCreate: (input: ProviderInstanceCreateRequest) => Promise<void>;
  onSubmitUpdate: (
    instanceId: string,
    patch: ProviderInstanceUpdateRequest,
  ) => Promise<void>;
}) {
  const isEditing = Boolean(editing);
  const [name, setName] = useState(editing?.name ?? "");
  const [protocol, setProtocol] = useState<string>(
    editing?.protocol ?? "openai-compatible",
  );
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [modelRows, setModelRows] = useState<ModelRow[]>(
    editing
      ? editing.models.map((m) => ({
          uid: nextRowUid(),
          id: m.id,
          name: m.name,
          capability: (m.capability as ModelRow["capability"]) ?? "chat",
          ...(m.contextWindow != null
            ? { contextWindow: String(m.contextWindow) }
            : {}),
          ...(m.maxOutputTokens != null
            ? { maxOutputTokens: String(m.maxOutputTokens) }
            : {}),
          ...(m.vision ? { vision: true } : {}),
          ...(m.reasoningEfforts
            ? { reasoningEfforts: m.reasoningEfforts.join(",") }
            : {}),
        }))
      : [emptyModelRow()],
  );
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(
    editing
      ? editing.headerKeys.map((key) => ({
          uid: nextRowUid(),
          key,
          value: "",
        }))
      : [],
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  /** 展开详情编辑的行（uid 集合）。 */
  const [detailOpen, setDetailOpen] = useState<Set<string>>(new Set());
  const [modelsJson, setModelsJson] = useState("");
  const [headersJson, setHeadersJson] = useState("");
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [presetId, setPresetId] = useState("");

  // 预设清单（新建时拉一次；拉取失败不影响手填路径）
  useEffect(() => {
    if (isEditing) return;
    let cancelled = false;
    fetchProviderPresets(accessToken)
      .then((r) => {
        if (!cancelled) setPresets(r.presets);
      })
      .catch(() => {
        // 预设不可用静默降级：表单仍可完全手填
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, isEditing]);

  const applyPreset = (nextPresetId: string) => {
    setPresetId(nextPresetId);
    const preset = presets.find((p) => p.id === nextPresetId);
    if (!preset) return;
    if (!name.trim()) setName(preset.name);
    setProtocol(PRESET_PROTOCOL[preset.id] ?? "openai-compatible");
    if (preset.api) setBaseUrl(preset.api);
    setModelRows(
      preset.models.map((m) => ({
        uid: nextRowUid(),
        id: m.id,
        name: m.name,
        capability: m.capability,
      })),
    );
  };

  // patch 值显式允许 undefined（exactOptionalPropertyTypes 下 Partial 不含），
  // 供「取消勾选/清空输入」场景把字段写回缺省态
  const updateModelRow = (
    index: number,
    update: (row: ModelRow) => ModelRow,
  ) => {
    setModelRows((rows) =>
      rows.map((row, i) => (i === index ? update(row) : row)),
    );
  };

  const toModelDeclaration = (row: ModelRow) => {
    // 声明面序列化：uid 是内部行键，绝不外发；详情字段缺省即「未知」，不填不发
    const contextWindow = Number.parseInt(row.contextWindow ?? "", 10);
    const maxOutputTokens = Number.parseInt(row.maxOutputTokens ?? "", 10);
    const efforts = (row.reasoningEfforts ?? "")
      .split(/[,，]/)
      .map((level) => level.trim())
      .filter((level) => level.length > 0);
    return {
      id: row.id.trim(),
      name: row.name.trim(),
      capability: row.capability,
      ...(Number.isFinite(contextWindow) && contextWindow > 0
        ? { contextWindow }
        : {}),
      ...(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? { maxOutputTokens }
        : {}),
      ...(row.vision ? { vision: true } : {}),
      ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
    };
  };

  const resolveModels = (): unknown => {
    // 高级 JSON 编辑过则以 JSON 为准；否则用结构化行（uid 不外发）
    if (showAdvanced && modelsJson.trim()) {
      const parsed = JSON.parse(modelsJson) as Array<Record<string, unknown>>;
      return Array.isArray(parsed)
        ? parsed.map(({ uid: _uid, ...rest }) => rest)
        : parsed;
    }
    return modelRows
      .filter((row) => row.id.trim() && row.name.trim())
      .map(toModelDeclaration);
  };

  const resolveHeaders = (): Record<string, string> | undefined => {
    if (showAdvanced && headersJson.trim()) {
      const parsed = parseHeadersJson(headersJson);
      if (parsed instanceof Error) throw parsed;
      return parsed;
    }
    // 结构化行：键非空即提交；**已存键且值留空 = 保留原值（跳过，值不回显是红线）**；
    // 新行空键跳过。清空全部自定义头走高级 JSON 的 {}。
    const existingKeys = new Set(editing?.headerKeys ?? []);
    const headers: Record<string, string> = {};
    for (const row of headerRows) {
      const key = row.key.trim();
      if (!key) continue;
      if (existingKeys.has(key) && row.value === "") continue;
      headers[key] = row.value;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  };

  const handleSubmit = async () => {
    let models: unknown;
    try {
      models = resolveModels();
    } catch {
      onError("模型清单必须是合法 JSON");
      return;
    }
    let headers: Record<string, string> | undefined;
    try {
      headers = resolveHeaders();
    } catch (error) {
      onError(error instanceof Error ? error.message : "自定义请求头不合法");
      return;
    }
    if (!name.trim()) {
      onError("请填写实例名称");
      return;
    }
    if (!editing && !apiKey.trim()) {
      onError("请填写 API Key（只写不读，保存后不可查看）");
      return;
    }
    if (!Array.isArray(models) || models.length === 0) {
      onError("至少保留一个模型（填写 ID 与显示名）");
      return;
    }

    if (editing) {
      const patch: ProviderInstanceUpdateRequest = {};
      if (name.trim() !== editing.name) patch.name = name.trim();
      if (baseUrl.trim() !== (editing.baseUrl ?? "")) {
        patch.baseUrl = baseUrl.trim();
      }
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      if (JSON.stringify(models) !== JSON.stringify(editing.models)) {
        patch.models = models as ProviderInstanceUpdateRequest["models"];
      }
      if (headers) patch.headers = headers;
      if (Object.keys(patch).length === 0) {
        onError("没有需要保存的修改");
        return;
      }
      await onSubmitUpdate(editing.id, patch);
      return;
    }

    await onSubmitCreate({
      name: name.trim(),
      protocol: protocol as (typeof PROTOCOLS)[number]["value"],
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      apiKey: apiKey.trim(),
      models: models as ProviderInstanceCreateRequest["models"],
      ...(headers ? { headers } : {}),
      enabled: true,
    });
  };

  return (
    <form
      aria-label={isEditing ? "编辑供应商实例" : "新建供应商实例"}
      className="mb-4 space-y-3 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      {!isEditing && presets.length > 0 ? (
        <div>
          <label htmlFor="provider-preset" className="text-sm">
            从预设选择（models.dev）
          </label>
          <Select
            value={presetId}
            onValueChange={(next) => {
              if (typeof next === "string") applyPreset(next);
            }}
            items={presets.map((p) => ({ value: p.id, label: p.name }))}
          >
            <SelectTrigger id="provider-preset" className="mt-1 w-full">
              <SelectValue placeholder="选择供应商（自动填网关与模型清单）" />
            </SelectTrigger>
            <SelectContent>
              {presets.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">
            选择后自动填实例名称、Base URL 与模型清单，可再手动调整。
          </p>
        </div>
      ) : null}
      <div>
        <label htmlFor="provider-name" className="text-sm">
          实例名称
        </label>
        <input
          id="provider-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label htmlFor="provider-protocol" className="text-sm">
          协议
        </label>
        {isEditing ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {protocol}（协议不可改；换协议请新建实例）
          </p>
        ) : (
          <Select
            value={protocol}
            onValueChange={(next) => {
              if (typeof next === "string") setProtocol(next);
            }}
            items={PROTOCOLS.map((p) => ({ value: p.value, label: p.label }))}
          >
            <SelectTrigger id="provider-protocol" className="mt-1 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROTOCOLS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div>
        <label htmlFor="provider-base-url" className="text-sm">
          Base URL{isEditing ? "" : "（选预设自动填，可改）"}
        </label>
        <input
          id="provider-base-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label htmlFor="provider-api-key" className="text-sm">
          {isEditing ? "API Key（留空则不改）" : "API Key"}
        </label>
        <input
          id="provider-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>

      {/* ── 模型清单：结构化行编辑器 ── */}
      <div>
        <span className="text-sm">模型清单</span>
        <div className="mt-1 space-y-2">
          {modelRows.map((row, index) => (
            <Fragment key={row.uid}>
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <input
                    aria-label={`模型 ${index + 1} ID`}
                    placeholder="模型 ID（如 gpt-4.1）"
                    value={row.id}
                    onChange={(e) =>
                      updateModelRow(index, (row) => ({
                        ...row,
                        id: e.target.value,
                      }))
                    }
                    className="w-full rounded-md border px-2 py-1.5 font-mono text-xs"
                  />
                </div>
                <div className="flex-1">
                  <input
                    aria-label={`模型 ${index + 1} 显示名`}
                    placeholder="显示名"
                    value={row.name}
                    onChange={(e) =>
                      updateModelRow(index, (row) => ({
                        ...row,
                        name: e.target.value,
                      }))
                    }
                    className="w-full rounded-md border px-2 py-1.5 text-xs"
                  />
                </div>
                <div className="w-28">
                  <Select
                    value={row.capability}
                    onValueChange={(next) => {
                      if (typeof next === "string")
                        updateModelRow(index, (row) => ({
                          ...row,
                          capability: next as ModelRow["capability"],
                        }));
                    }}
                    items={CAPABILITIES.map((c) => ({
                      value: c.value,
                      label: c.label,
                    }))}
                  >
                    <SelectTrigger
                      aria-label={`模型 ${index + 1} 能力`}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CAPABILITIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <button
                  type="button"
                  aria-label={`模型 ${row.id || index + 1} 详情`}
                  onClick={() =>
                    setDetailOpen((open) => {
                      const next = new Set(open);
                      if (next.has(row.uid)) {
                        next.delete(row.uid);
                      } else {
                        next.add(row.uid);
                      }
                      return next;
                    })
                  }
                  className={
                    detailOpen.has(row.uid)
                      ? "rounded-md border px-2 py-1.5 text-xs text-primary"
                      : "rounded-md border px-2 py-1.5 text-xs text-muted-foreground"
                  }
                >
                  详情
                </button>
                <button
                  type="button"
                  aria-label={`删除模型 ${row.id || index + 1}`}
                  onClick={() =>
                    setModelRows((rows) => rows.filter((_, i) => i !== index))
                  }
                  className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground"
                >
                  删除
                </button>
              </div>
              {detailOpen.has(row.uid) ? (
                <div className="ml-2 grid grid-cols-2 gap-2 rounded-md border border-dashed p-2 md:grid-cols-4">
                  <label className="text-xs text-muted-foreground">
                    上下文窗口（token）
                    <input
                      inputMode="numeric"
                      placeholder="如 128000"
                      value={row.contextWindow ?? ""}
                      onChange={(e) =>
                        updateModelRow(index, (row) => ({
                          ...row,
                          contextWindow: e.target.value.replace(/[^0-9]/g, ""),
                        }))
                      }
                      className="mt-0.5 w-full rounded-md border px-2 py-1.5 font-mono text-xs"
                    />
                  </label>
                  <label className="text-xs text-muted-foreground">
                    最大输出（token）
                    <input
                      inputMode="numeric"
                      placeholder="如 32000"
                      value={row.maxOutputTokens ?? ""}
                      onChange={(e) =>
                        updateModelRow(index, (row) => ({
                          ...row,
                          maxOutputTokens: e.target.value.replace(
                            /[^0-9]/g,
                            "",
                          ),
                        }))
                      }
                      className="mt-0.5 w-full rounded-md border px-2 py-1.5 font-mono text-xs"
                    />
                  </label>
                  <label className="flex items-end gap-2 pb-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={row.vision ?? false}
                      onChange={(e) =>
                        updateModelRow(index, (row) => {
                          const { vision: _vision, ...rest } = row;
                          return e.target.checked
                            ? { ...rest, vision: true }
                            : rest;
                        })
                      }
                    />
                    支持图像输入（视觉）
                  </label>
                  <label className="text-xs text-muted-foreground">
                    思考档位（逗号分隔）
                    <input
                      placeholder="低,中,高,最高"
                      value={row.reasoningEfforts ?? ""}
                      onChange={(e) =>
                        updateModelRow(index, (row) => ({
                          ...row,
                          reasoningEfforts: e.target.value,
                        }))
                      }
                      className="mt-0.5 w-full rounded-md border px-2 py-1.5 text-xs"
                    />
                  </label>
                </div>
              ) : null}
            </Fragment>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setModelRows((rows) => [...rows, emptyModelRow()])}
          className="mt-2 rounded-md border px-3 py-1.5 text-xs"
        >
          添加模型
        </button>
      </div>

      {/* ── 自定义请求头：结构化键值行 ── */}
      <div>
        <span className="text-sm">自定义请求头（可选）</span>
        <div className="mt-1 space-y-2">
          {headerRows.map((row, index) => (
            <div key={row.uid} className="flex items-start gap-2">
              <div className="w-2/5">
                <input
                  aria-label={`请求头 ${index + 1} 名称`}
                  placeholder="头名（如 x-opencode-session）"
                  value={row.key}
                  onChange={(e) =>
                    setHeaderRows((rows) =>
                      rows.map((r, i) =>
                        i === index ? { ...r, key: e.target.value } : r,
                      ),
                    )
                  }
                  className="w-full rounded-md border px-2 py-1.5 font-mono text-xs"
                />
              </div>
              <div className="flex-1">
                <input
                  aria-label={`请求头 ${index + 1} 值`}
                  placeholder={
                    editing?.headerKeys.includes(row.key)
                      ? "留空 = 保留已存值"
                      : "值（可写 {{sessionId}} / {{threadId}}）"
                  }
                  value={row.value}
                  onChange={(e) =>
                    setHeaderRows((rows) =>
                      rows.map((r, i) =>
                        i === index ? { ...r, value: e.target.value } : r,
                      ),
                    )
                  }
                  className="w-full rounded-md border px-2 py-1.5 font-mono text-xs"
                />
              </div>
              <button
                type="button"
                aria-label={`删除请求头 ${row.key || index + 1}`}
                onClick={() =>
                  setHeaderRows((rows) => rows.filter((_, i) => i !== index))
                }
                className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground"
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() =>
            setHeaderRows((rows) => [
              ...rows,
              { uid: nextRowUid(), key: "", value: "" },
            ])
          }
          className="mt-2 rounded-md border px-3 py-1.5 text-xs"
        >
          添加请求头
        </button>
        <p className="mt-1 text-xs text-muted-foreground">
          {providerHeadersHint}
          {isEditing && editing && editing.headerKeys.length > 0
            ? `已存键：${editing.headerKeys.join("、")}（值不回显；提交将按上方行**整体覆盖**——需保留的键请重填其值，不需要的键删除该行）`
            : ""}
        </p>
      </div>

      {/* ── 高级设置：裸 JSON 折叠区 ── */}
      <div>
        <button
          type="button"
          onClick={() => {
            if (!showAdvanced && !modelsJson.trim()) {
              setModelsJson(JSON.stringify(modelRows, null, 2));
            }
            setShowAdvanced((value) => !value);
          }}
          className="text-xs text-muted-foreground underline"
        >
          {showAdvanced ? "收起高级设置" : "高级设置（JSON）"}
        </button>
        {showAdvanced ? (
          <div className="mt-2 space-y-3 rounded-md border border-dashed p-3">
            <p className="text-xs text-muted-foreground">
              以下 JSON 与上方表单同源；此处编辑过则以 JSON 为准提交。
            </p>
            <div>
              <label htmlFor="provider-models" className="text-sm">
                模型清单（JSON）
              </label>
              <textarea
                id="provider-models"
                value={modelsJson}
                onChange={(e) => setModelsJson(e.target.value)}
                rows={4}
                className="mt-1 w-full rounded-md border px-3 py-2 font-mono text-xs"
              />
            </div>
            <div>
              <label htmlFor="provider-headers" className="text-sm">
                自定义请求头（JSON）
              </label>
              <textarea
                id="provider-headers"
                value={headersJson}
                onChange={(e) => setHeadersJson(e.target.value)}
                rows={2}
                placeholder='{"x-opencode-session":"{{sessionId}}"}'
                className="mt-1 w-full rounded-md border px-3 py-2 font-mono text-xs"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                此处填写则以 JSON 整体覆盖自定义请求头（优先于上方行编辑器）。
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          {submitting ? "保存中…" : isEditing ? "保存修改" : "保存实例"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-4 py-2 text-sm"
        >
          取消
        </button>
      </div>
    </form>
  );
}
