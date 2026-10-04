import type { ProviderInstanceModel } from "@kenfutwork/shared";
import type {
  PersistenceService,
  WorkspaceSqlClient,
} from "../persistence/types.js";

export type ProviderInstanceRecord = {
  id: string;
  scope: string;
  workspace_id: string | null;
  name: string;
  protocol: string;
  base_url: string | null;
  encrypted_api_key: string | null;
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
  encrypted_api_key?: string | null | undefined;
  models?: unknown;
  compat?: unknown;
  headers?: unknown;
  enabled?: boolean | undefined;
};

export type NewWorkspaceInstance = {
  baseUrl?: string | undefined;
  compat?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  createdBy: string;
  encryptedApiKey: string | null;
  enabled: boolean;
  models: unknown;
  name: string;
  protocol: string;
  workspaceId: string;
};

export type NewSystemInstance = {
  baseUrl?: string | undefined;
  compat?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  createdBy: string;
  encryptedApiKey: string | null;
  enabled: boolean;
  models: unknown;
  name: string;
  protocol: string;
};

/**
 * modelProviders 缝的数据访问（`provider_instances`，`FORM-10`）。
 *
 * 两种口径并存，不可混用：
 * - **工作区实例**（`scope='workspace'`，`workspace_id` 非空）：一律经
 *   `forWorkspace` 施加谓词——用户侧 CRUD 与凭证解析走这条路。
 * - **平台池实例**（`scope='system'`，`workspace_id` 为 NULL，CHECK 约束强制）：
 *   无工作区谓词可言，属系统级数据，走根客户端；读写一律带 `scope='system'`，
 *   避免与工作区实例串行。
 */
export interface ModelProviderRepository {
  deleteSystemInstance(instanceId: string): Promise<number>;
  deleteWorkspaceInstance(
    workspaceId: string,
    instanceId: string,
  ): Promise<number>;
  /** 探测结果缓存（用户工作区作用域）。 */
  setProbeResult(
    workspaceId: string,
    instanceId: string,
    result: Record<string, unknown>,
  ): Promise<ProviderInstanceRecord | null>;
  /** 按 id 取任意实例（平台池/worker 路径；不做工作区限定）。 */
  findById(instanceId: string): Promise<ProviderInstanceRecord | null>;
  findWorkspaceInstance(
    workspaceId: string,
    instanceId: string,
  ): Promise<ProviderInstanceRecord | null>;
  insertSystemInstance(
    input: NewSystemInstance,
  ): Promise<ProviderInstanceRecord | null>;
  insertWorkspaceInstance(
    input: NewWorkspaceInstance,
  ): Promise<ProviderInstanceRecord | null>;
  listSystemInstances(): Promise<ProviderInstanceRecord[]>;
  listWorkspaceInstances(
    workspaceId: string,
  ): Promise<ProviderInstanceRecord[]>;
  updateSystemInstance(
    instanceId: string,
    patch: ProviderInstancePatch,
    expectedRevision?: number,
  ): Promise<ProviderInstanceRecord | null>;
  updateWorkspaceInstance(
    workspaceId: string,
    instanceId: string,
    patch: ProviderInstancePatch,
    expectedRevision?: number,
  ): Promise<ProviderInstanceRecord | null>;
}

const INSTANCE_COLUMNS =
  "id, scope, workspace_id, name, protocol, base_url, encrypted_api_key, models, compat, headers, enabled, config_revision, probe_result, probed_at";

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
  if (patch.encrypted_api_key !== undefined) {
    push("encrypted_api_key", patch.encrypted_api_key);
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
  // 所有配置写入先锁工作区修订再锁实例，统一 HTTP/原宿主的锁序与 CAS 边界。
  const writeWorkspace = <T>(
    workspaceId: string,
    operation: (scoped: WorkspaceSqlClient) => Promise<T>,
  ) =>
    persistence.transaction(async (tx) => {
      const scoped = tx.forWorkspace(workspaceId);
      await scoped.execute(
        `insert into public.provider_registry_revisions(workspace_id,revision) values(:workspace,0) on conflict(workspace_id) do nothing`,
      );
      await scoped.queryOne<{ revision: string }>(
        `select revision from public.provider_registry_revisions where workspace_id=:workspace for update`,
      );
      return operation(scoped);
    });
  return {
    async listWorkspaceInstances(workspaceId) {
      return persistence
        .forWorkspace(workspaceId)
        .query<ProviderInstanceRecord>(
          `select ${INSTANCE_COLUMNS}
           from public.provider_instances
          where workspace_id = :workspace
            and scope = 'workspace'
          order by created_at asc`,
        );
    },

    async findWorkspaceInstance(workspaceId, instanceId) {
      return persistence
        .forWorkspace(workspaceId)
        .queryOne<ProviderInstanceRecord>(
          `select ${INSTANCE_COLUMNS}
             from public.provider_instances
            where workspace_id = :workspace
              and id = $1
              and scope = 'workspace'`,
          [instanceId],
        );
    },

    async insertWorkspaceInstance(input) {
      return writeWorkspace(input.workspaceId, (scoped) =>
        scoped.queryOne<ProviderInstanceRecord>(
          `insert into public.provider_instances
                  (workspace_id, scope, name, protocol, base_url,
                   encrypted_api_key, models, compat, headers, enabled, created_by)
           values (:workspace, 'workspace', $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
           returning ${INSTANCE_COLUMNS}`,
          [
            input.name,
            input.protocol,
            input.baseUrl ?? null,
            input.encryptedApiKey,
            JSON.stringify(input.models),
            input.compat === undefined ? null : JSON.stringify(input.compat),
            input.headers === undefined ? null : JSON.stringify(input.headers),
            input.enabled,
            input.createdBy,
          ],
        ),
      );
    },

    async updateWorkspaceInstance(
      workspaceId,
      instanceId,
      patch,
      expectedRevision,
    ) {
      const built = buildPatch(patch, instanceId, expectedRevision);
      if (!built) {
        return null;
      }
      return writeWorkspace(workspaceId, (scoped) =>
        scoped.queryOne<ProviderInstanceRecord>(
          `update public.provider_instances
            set config_revision = config_revision + 1,
                ${built.assignments.join(", ")}
          where workspace_id = :workspace
            and id = $1
            and scope = 'workspace'
            ${built.revisionFilter}
        returning ${INSTANCE_COLUMNS}`,
          // $1 是目标 id；工作区由 :workspace 追加为末位参数，保持 SET 片段引用不漂移。
          built.values,
        ),
      );
    },

    async setProbeResult(workspaceId, instanceId, result) {
      return persistence
        .forWorkspace(workspaceId)
        .queryOne<ProviderInstanceRecord>(
          `update public.provider_instances
            set probe_result = $1::jsonb,
                probed_at = now()
          where workspace_id = :workspace
            and id = $2
            and scope = 'workspace'
        returning ${INSTANCE_COLUMNS}`,
          [JSON.stringify(result), instanceId],
        );
    },

    async deleteWorkspaceInstance(workspaceId, instanceId) {
      return writeWorkspace(workspaceId, (scoped) =>
        scoped.execute(
          `delete from public.provider_instances
          where workspace_id = :workspace
            and id = $1
            and scope = 'workspace'`,
          [instanceId],
        ),
      );
    },

    async listSystemInstances() {
      return persistence.query<ProviderInstanceRecord>(
        `select ${INSTANCE_COLUMNS}
           from public.provider_instances
          where scope = 'system'
          order by created_at asc`,
      );
    },

    async findById(instanceId) {
      return persistence.queryOne<ProviderInstanceRecord>(
        `select ${INSTANCE_COLUMNS}
           from public.provider_instances
          where id = $1`,
        [instanceId],
      );
    },

    async insertSystemInstance(input) {
      return persistence.queryOne<ProviderInstanceRecord>(
        `insert into public.provider_instances
                (workspace_id, scope, name, protocol, base_url,
                 encrypted_api_key, models, compat, headers, enabled, created_by)
         values (null, 'system', $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
         returning ${INSTANCE_COLUMNS}`,
        [
          input.name,
          input.protocol,
          input.baseUrl ?? null,
          input.encryptedApiKey,
          JSON.stringify(input.models),
          input.compat === undefined ? null : JSON.stringify(input.compat),
          input.headers === undefined ? null : JSON.stringify(input.headers),
          input.enabled,
          input.createdBy,
        ],
      );
    },

    async updateSystemInstance(instanceId, patch, expectedRevision) {
      const built = buildPatch(patch, instanceId, expectedRevision);
      if (!built) {
        return null;
      }
      return persistence.queryOne<ProviderInstanceRecord>(
        `update public.provider_instances
            set config_revision = config_revision + 1,
                ${built.assignments.join(", ")}
          where id = $1
            and scope = 'system'
            ${built.revisionFilter}
        returning ${INSTANCE_COLUMNS}`,
        built.values,
      );
    },

    async deleteSystemInstance(instanceId) {
      return persistence.execute(
        `delete from public.provider_instances
          where id = $1
            and scope = 'system'`,
        [instanceId],
      );
    },
  };
}
