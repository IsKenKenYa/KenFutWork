"use client";

import type { ProviderInstanceResponse } from "@kenfutwork/shared";
import { useCallback, useEffect, useState } from "react";
import {
  ProviderInstanceForm,
  protocolLabel,
} from "@/components/provider-instance-form";
import {
  createProviderInstance,
  deleteProviderInstance,
  fetchProviderInstances,
  updateProviderInstance,
} from "@/lib/server-api";

/**
 * 供应商设置（P5 BYOK）：用户供应商实例 CRUD。
 * 凭证红线：apiKey 与自定义头值都只写不读——列表只有 hasCredential 与 headerKeys（键名）。
 */
export function ProviderSettings({ accessToken }: { accessToken: string }) {
  const [instances, setInstances] = useState<ProviderInstanceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** `null` = 表单关闭；`"create"` = 新建；实例对象 = 编辑该实例。 */
  const [formTarget, setFormTarget] = useState<
    "create" | ProviderInstanceResponse | null
  >(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { instances: list } = await fetchProviderInstances(accessToken);
      setInstances(list);
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

  /** 表单动作统一收口：报错、关表单、刷新列表。 */
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

  return (
    <section aria-label="供应商设置">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium">供应商设置</h3>
          <p className="text-sm text-muted-foreground"></p>
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
        <p className="text-sm text-muted-foreground">暂无供应商实例</p>
      ) : (
        <ul className="space-y-2">
          {instances.map((instance) => (
            <li
              key={instance.id}
              className="flex items-center justify-between rounded-md border px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium">{instance.name}</p>
                <p className="text-xs text-muted-foreground">
                  {protocolLabel(instance.protocol)} · {instance.models.length}{" "}
                  个模型 · {instance.enabled ? "已启用" : "已停用"}
                </p>
                {instance.headerKeys.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    自定义请求头：{instance.headerKeys.join("、")}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setFormTarget(instance);
                  }}
                  className="rounded-md border px-3 py-1 text-sm"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(instance.id)}
                  className="rounded-md border px-3 py-1 text-sm text-destructive"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
