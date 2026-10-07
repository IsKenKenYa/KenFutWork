import type { ProviderInstanceModel } from "@kenfutwork/shared";
import type {
  InstanceSqlClient,
  PersistenceService,
} from "../persistence/types.js";

export type ProviderInstanceRecord = {
  id: string;
  instance_id: string;
  name: string;
  protocol: string;
  base_url: string | null;
  api_key_ref: string | null;
  models: Array<
    Omit<ProviderInstanceModel, "capability"> & { capability: string }
  > | null;
  compat: Record<string, unknown> | null;
  headers: Record<string, string> | null;
  enabled: boolean;
  /** 配置修订号（bigint 经 pg 返回字符串）：任何实例更新自增，跨修订防护用。 */
  config_revision: string;
  probe_result: Record<string, unknown> | null;
  probed_at: string | null;
};

/** 更新补丁：`undefined` = 不改；显式 null = 清空（如移除 base_url）。 */
export type ProviderInstancePatch = {
  name?: string | undefined;
  protocol?: string | undefined;
  base_url?: string | null | undefined;
  api_key_ref?: string | null | undefined;
  credential_changed?: boolean | undefined;
  models?: unknown;
  compat?: unknown;
  headers?: unknown;
  enabled?: boolean | undefined;
};

export type NewProviderInstance = {
  id: string;
  instanceId: string;
  baseUrl?: string | undefined;
  compat?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  apiKeyRef: string | null;
  enabled: boolean;
  models: unknown;
  name: string;
  protocol: string;
};

/** 供应商元数据唯一归属本地实例，所有查询强制带实例谓词。 */
export interface ModelProviderRepository {
  deleteInstance(instanceId: string, providerId: string): Promise<number>;
  setProbeResult(
    instanceId: string,
    providerId: string,
    result: Record<string, unknown>,
  ): Promise<ProviderInstanceRecord | null>;
  findInstance(
    instanceId: string,
    providerId: string,
  ): Promise<ProviderInstanceRecord | null>;
  insertInstance(
    input: NewProviderInstance,
  ): Promise<ProviderInstanceRecord | null>;
  listInstances(instanceId: string): Promise<ProviderInstanceRecord[]>;
  updateInstance(
    instanceId: string,
    providerId: string,
    patch: ProviderInstancePatch,
    expectedRevision?: number,
  ): Promise<ProviderInstanceRecord | null>;
}

const INSTANCE_COLUMNS =
  "id, instance_id, name, protocol, base_url, api_key_ref, models, compat, headers, enabled, config_revision, probe_result, probed_at";

/** 把补丁翻成 SET 片段；`$1` 固定留作目标 id，故列从 `$2` 起编号。 */
function buildPatch(
  patch: ProviderInstancePatch,
  idParam: unknown,
  expectedRevision?: number,
): { assignments: string[]; values: unknown[]; revisionFilter: string } | null {
  const assignments: string[] = [];
  const values: unknown[] = [idParam];

  const push = (column: string, value: unknown, cast = "") => {
    values.push(value);
    assignments.push(`${column} = $${values.length}${cast}`);
  };

  if (patch.name !== undefined) push("name", patch.name);
  if (patch.protocol !== undefined) push("protocol", patch.protocol);
  if (patch.base_url !== undefined) push("base_url", patch.base_url);
  if (patch.api_key_ref !== undefined) {
    push("api_key_ref", patch.api_key_ref);
  }
  if (patch.credential_changed) {
    assignments.push("credential_revision = credential_revision + 1");
  }
  if (patch.models !== undefined) {
    push("models", JSON.stringify(patch.models), "::jsonb");
  }
  if (patch.compat !== undefined) {
    push("compat", JSON.stringify(patch.compat), "::jsonb");
  }
  if (patch.headers !== undefined) {
    push(
      "headers",
      patch.headers === null ? null : JSON.stringify(patch.headers),
      "::jsonb",
    );
  }
  if (patch.enabled !== undefined) push("enabled", patch.enabled);

  if (assignments.length === 0) return null;
  if (expectedRevision !== undefined) values.push(expectedRevision);
  return {
    assignments,
    values,
    revisionFilter:
      expectedRevision === undefined
        ? ""
        : `and config_revision = $${values.length}`,
  };
}

export function createModelProviderRepository(
  persistence: PersistenceService,
): ModelProviderRepository {
  // 配置写入先锁实例目录修订，再锁供应商，保留 HTTP/原宿主统一锁序及 CAS。
  const writeInstance = <T>(
    instanceId: string,
    operation: (scoped: InstanceSqlClient) => Promise<T>,
  ) =>
    persistence.transaction(async (tx) => {
      const scoped = tx.forInstance(instanceId);
      await scoped.execute(
        `insert into public.provider_registry_revisions(instance_id,revision) values(:instance,0) on conflict(instance_id) do nothing`,
      );
      await scoped.queryOne<{ revision: string }>(
        `select revision from public.provider_registry_revisions where instance_id=:instance for update`,
      );
      return operation(scoped);
    });

  return {
    listInstances(instanceId) {
      return persistence.forInstance(instanceId).query<ProviderInstanceRecord>(
        `select ${INSTANCE_COLUMNS}
           from public.provider_instances
          where instance_id = :instance
          order by created_at asc`,
      );
    },

    findInstance(instanceId, providerId) {
      return persistence
        .forInstance(instanceId)
        .queryOne<ProviderInstanceRecord>(
          `select ${INSTANCE_COLUMNS}
           from public.provider_instances
          where instance_id = :instance and id = $1`,
          [providerId],
        );
    },

    insertInstance(input) {
      return writeInstance(input.instanceId, (scoped) =>
        scoped.queryOne<ProviderInstanceRecord>(
          `insert into public.provider_instances
                  (instance_id, id, name, protocol, base_url,
                   api_key_ref, models, compat, headers, enabled)
           values (:instance, $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)
           returning ${INSTANCE_COLUMNS}`,
          [
            input.id,
            input.name,
            input.protocol,
            input.baseUrl ?? null,
            input.apiKeyRef,
            JSON.stringify(input.models),
            input.compat === undefined ? null : JSON.stringify(input.compat),
            input.headers === undefined ? null : JSON.stringify(input.headers),
            input.enabled,
          ],
        ),
      );
    },

    updateInstance(instanceId, providerId, patch, expectedRevision) {
      const built = buildPatch(patch, providerId, expectedRevision);
      if (!built) return Promise.resolve(null);
      return writeInstance(instanceId, (scoped) =>
        scoped.queryOne<ProviderInstanceRecord>(
          `update public.provider_instances
              set config_revision = config_revision + 1,
                  ${built.assignments.join(", ")}
            where instance_id = :instance and id = $1
                  ${built.revisionFilter}
        returning ${INSTANCE_COLUMNS}`,
          // 实例谓词的绑定值追加至末位，SET/CAS 参数编号保持原有顺序。
          built.values,
        ),
      );
    },

    setProbeResult(instanceId, providerId, result) {
      return persistence
        .forInstance(instanceId)
        .queryOne<ProviderInstanceRecord>(
          `update public.provider_instances
            set probe_result = $1::jsonb, probed_at = now()
          where instance_id = :instance and id = $2
        returning ${INSTANCE_COLUMNS}`,
          [JSON.stringify(result), providerId],
        );
    },

    deleteInstance(instanceId, providerId) {
      return writeInstance(instanceId, (scoped) =>
        scoped.execute(
          `delete from public.provider_instances
            where instance_id = :instance and id = $1`,
          [providerId],
        ),
      );
    },
  };
}
