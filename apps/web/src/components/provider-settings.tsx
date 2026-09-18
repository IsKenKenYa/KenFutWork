"use client";

import type {
  ProviderInstanceModel,
  ProviderInstanceResponse,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useState } from "react";
import { ModelEditDialog } from "@/components/model-edit-dialog";
import { ProviderInstanceForm } from "@/components/provider-instance-form";
import {
  createProviderInstance,
  deleteProviderInstance,
  fetchProviderInstances,
  updateProviderInstance,
} from "@/lib/server-api";

/**
 * 供应商设置（BYOK，双栏形态）：左侧供应商列表，右侧该供应商的详情与模型清单
 * ——模型与供应商绑定（2026-09-19 用户口径，参考 BYOK 产品惯例）。
 *
 * 凭证红线：apiKey 与自定义头值都只写不读——列表只有 hasCredential 与 headerKeys。
 * 模型行的详情（上下文/最大输出/思考档位/推理参数映射等）经 ModelEditDialog 编辑，
 * 保存走 updateProviderInstance 的 models 整体替换。
 */

function formatTokens(value: number | undefined): string | null {
  if (value == null || value <= 0) return null;
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

export function ProviderSettings({ accessToken }: { accessToken: string }) {
  const [instances, setInstances] = useState<ProviderInstanceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** `null` = 表单关闭；`"create"` = 新建；实例对象 = 编辑该实例。 */
  const [formTarget, setFormTarget] = useState<
    "create" | ProviderInstanceResponse | null
  >(null);
  const [submitting, setSubmitting] = useState(false);
  /** 编辑详情的模型（所在实例 + 行）。 */
  const [editingModel, setEditingModel] = useState<{
    instanceId: string;
    model: ProviderInstanceModel;
  } | null>(null);
  const [modelSaving, setModelSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { instances: list } = await fetchProviderInstances(accessToken);
      setInstances(list);
      setSelectedId((current) =>
        current && list.some((i) => i.id === current)
          ? current
          : (list[0]?.id ?? null),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载供应商实例失败");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const runSubmission = async (
    action: () => Promise<unknown>,
    fallbackMessage: string,
  ) => {
    setError(null);
    setSubmitting(true);
    try {
      await action();
      setFormTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallbackMessage);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (instanceId: string) => {
    setError(null);
    try {
      await deleteProviderInstance(accessToken, instanceId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除实例失败");
    }
  };

  const selected = instances.find((i) => i.id === selectedId) ?? null;

  /** 模型行开关/详情保存：models 整体替换（该实例的全部行，改其中一行）。 */
  const saveModels = async (
    instance: ProviderInstanceResponse,
    models: ProviderInstanceModel[],
  ) => {
    setModelSaving(true);
    setError(null);
    try {
      await updateProviderInstance(accessToken, instance.id, {
        models: models as ProviderInstanceResponse["models"],
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "模型清单保存失败");
    } finally {
      setModelSaving(false);
    }
  };

  const toggleModel = (instance: ProviderInstanceResponse, modelId: string) => {
    const models = instance.models.map((m) =>
      m.id === modelId ? { ...m, enabled: m.enabled === false } : m,
    );
    void saveModels(instance, models as ProviderInstanceModel[]);
  };

  const toggleInstance = async (instance: ProviderInstanceResponse) => {
    await runSubmission(
      () =>
        updateProviderInstance(accessToken, instance.id, {
          enabled: !instance.enabled,
        }),
      "实例开关切换失败",
    );
  };

  return (
    <section aria-label="供应商设置" className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium">供应商设置</h3>
          <p className="text-sm text-muted-foreground">
            使用你自己的 API Key（BYOK）。Key 加密保存，永不回显。
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            setFormTarget((current) => (current === null ? "create" : null))
          }
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          {formTarget === null ? "添加供应商" : "取消"}
        </button>
      </div>

      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {formTarget !== null ? (
        <ProviderInstanceForm
          key={formTarget === "create" ? "create" : formTarget.id}
          editing={formTarget === "create" ? undefined : formTarget}
          accessToken={accessToken}
          submitting={submitting}
          onCancel={() => setFormTarget(null)}
          onError={setError}
          onSubmitCreate={(input) =>
            runSubmission(
              () => createProviderInstance(accessToken, input),
              "创建实例失败",
            )
          }
          onSubmitUpdate={(instanceId, patch) =>
            runSubmission(
              () => updateProviderInstance(accessToken, instanceId, patch),
              "更新实例失败",
            )
          }
        />
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : instances.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          暂无供应商实例——点「添加供应商」，或从 models.dev 预设选择。
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-0 overflow-hidden rounded-md border md:grid-cols-[220px_1fr]">
          {/* 左列：供应商列表 */}
          <ul className="border-b md:border-b-0 md:border-r">
            {instances.map((instance) => (
              <li key={instance.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(instance.id)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm ${
                    instance.id === selectedId ? "bg-muted" : ""
                  }`}
                >
                  <span className="truncate">{instance.name}</span>
                  <span
                    aria-label={instance.enabled ? "已启用" : "已停用"}
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      instance.enabled
                        ? "bg-emerald-500"
                        : "bg-muted-foreground/40"
                    }`}
                  />
                </button>
              </li>
            ))}
          </ul>

          {/* 右栏：选中实例详情 */}
          {selected ? (
            <div className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{selected.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {selected.protocol}
                    {selected.baseUrl ? ` · ${selected.baseUrl}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFormTarget(selected)}
                    className="rounded-md border px-3 py-1 text-sm"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(selected.id)}
                    className="rounded-md border px-3 py-1 text-sm text-destructive"
                  >
                    删除
                  </button>
                </div>
              </div>

              {selected.headerKeys.length > 0 ? (
                <p className="mb-3 text-xs text-muted-foreground">
                  自定义请求头：{selected.headerKeys.join("、")}（值不回显）
                </p>
              ) : null}

              {/* 模型清单（与供应商绑定） */}
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">模型清单</p>
                <button
                  type="button"
                  onClick={() => setFormTarget(selected)}
                  className="text-xs text-muted-foreground underline"
                >
                  添加模型（在供应商表单中）
                </button>
              </div>
              <ul className="space-y-1.5">
                {selected.models.map((model) => (
                  <li
                    key={model.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-xs">
                        {model.id}
                      </span>
                      {model.contextWindow &&
                      model.contextWindow >= 1_000_000 ? (
                        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          1M
                        </span>
                      ) : null}
                      {model.vision ? (
                        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          视觉
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-label={`编辑模型 ${model.id}`}
                        onClick={() =>
                          setEditingModel({
                            instanceId: selected.id,
                            model,
                          })
                        }
                        className="text-xs text-muted-foreground underline"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={model.enabled !== false}
                        aria-label={`模型 ${model.id} 启用开关`}
                        onClick={() => toggleModel(selected, model.id)}
                        className={`h-5 w-9 rounded-full transition-colors ${
                          model.enabled !== false
                            ? "bg-primary"
                            : "bg-muted-foreground/40"
                        }`}
                      >
                        <span
                          className={`block h-4 w-4 rounded-full bg-background transition-transform ${
                            model.enabled !== false
                              ? "translate-x-4"
                              : "translate-x-0.5"
                          }`}
                        />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {selected.models.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  该实例还没有模型——点「编辑」在表单里添加。
                </p>
              ) : null}
            </div>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              ← 从左侧选择供应商实例
            </div>
          )}
        </div>
      )}

      {editingModel && selected ? (
        <ModelEditDialog
          model={editingModel.model}
          saving={modelSaving}
          onClose={() => setEditingModel(null)}
          onSave={(next) => {
            const models = selected.models.map((m) =>
              m.id === editingModel.model.id ? next : m,
            );
            void saveModels(selected, models).then(() => setEditingModel(null));
          }}
        />
      ) : null}
    </section>
  );
}
