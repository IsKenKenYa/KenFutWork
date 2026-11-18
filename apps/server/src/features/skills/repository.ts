import { createHash } from "node:crypto";
import type {
  InstanceSqlClient,
  PersistenceService,
} from "../persistence/types.js";

export type InstanceSkillRecord = {
  enabled: boolean;
  skillId: string;
  installationRevision?: string;
  slug: string;
  name: string;
  description: string;
  skillContent: string;
};

/**
 * skills 聚合的数据访问（`instance_skills` JOIN `skills`）。
 * `instance_skills` 带 `instance_id`，故隔离谓词直接落在本表。
 */
export type SkillFileRecord = {
  skillId: string;
  path: string;
  content: string;
};

/** 已安装 skill 的行（保持路由既有的嵌套形状：`skills` 为 skill 明细）。 */
export type InstalledSkillRow = {
  skill_id: string;
  enabled: boolean;
  installed_at: string;
  skills: Record<string, unknown> | null;
};

export type UpsertInstallationInput = {
  enabled: boolean;
  installedByClientId: string | null;
  skillId: string;
  instanceId: string;
};

export type OwnedSkillInsertInput = {
  createdByClientId?: string | null | undefined;
  author?: string | null | undefined;
  category: string;
  description: string;
  iconName?: string | null | undefined;
  license?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  name: string;
  packageName?: string | null | undefined;
  skillContent: string;
  slug: string;
  source?: string | undefined;
  sourceUrl?: string | null | undefined;
  version?: string | null | undefined;
};

export type SkillFileInsertRow = {
  content: string;
  filePath: string;
  mimeType?: string | undefined;
};

/** 项目级技能启停：键为真实项目 id，不复用旧工作区身份。 */
export type ProjectSkillRecord = {
  enabled: boolean;
  skillId: string;
  updatedAt: string;
};

export interface ProjectSkillRepository {
  /** 项目不属于本实例时为 null，界面据此不显示项目分档。 */
  findProject(
    instanceId: string,
    projectId: string,
  ): Promise<{ id: string; name: string } | null>;
  listProjectSkills(
    instanceId: string,
    projectId: string,
  ): Promise<ProjectSkillRecord[]>;
  /** 项目或技能不属于本实例时不写入，返回 0。 */
  upsertProjectSkill(input: {
    instanceId: string;
    projectId: string;
    skillId: string;
    enabled: boolean;
  }): Promise<number>;
  /** 只更新已有项目记录；项目不存在或未设置时返回 false。 */
  setProjectSkillEnabled(
    instanceId: string,
    projectId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<boolean>;
}

export type SkillImportReceiptStatus = "imported" | "deleted";

export type SkillImportReceipt = {
  status: SkillImportReceiptStatus;
  skillId: string | null;
  parameterFingerprint: string | null;
};

export type SkillImportAdmission = {
  kind: "created" | "replayed";
  skillId: string;
};

export class SkillImportConflictError extends Error {
  constructor() {
    super("同一来源的技能包内容已变化，导入需要新的技能身份。");
    this.name = "SkillImportConflictError";
  }
}

export class SkillImportDeletedError extends Error {
  constructor() {
    super("该来源的技能已删除，迟到导入不会重新创建。");
    this.name = "SkillImportDeletedError";
  }
}

/** 来源身份摘要：规范化源根目录 + 源 slug；实例已是回执主键的一部分。 */
export function skillImportRequestKey(
  sourceRootPath: string,
  sourceSlug: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify(["skill-import", sourceRootPath, sourceSlug]))
    .digest("hex");
}

export interface SkillImportReceiptRepository {
  findImportReceipt(
    instanceId: string,
    requestKey: string,
  ): Promise<SkillImportReceipt | null>;
  /** 同实例内的 slug 占用；跨实例的占用由唯一约束兜底。 */
  findSkillBySlug(
    instanceId: string,
    slug: string,
  ): Promise<{ id: string } | null>;
  /**
   * 单事务内按来源准入导入：
   * - 无回执：调用 `create` 建技能并写回执；
   * - 同来源同内容摘要：返回既有技能，标记重放；
   * - 同来源不同摘要：冲突，不静默覆盖；
   * - 墓碑：已删除，迟到导入不复活内容。
   */
  admitImport(input: {
    instanceId: string;
    requestKey: string;
    parameterFingerprint: string;
    sourceRootPath: string;
    sourceSlug: string;
    create: (client: InstanceSqlClient) => Promise<{ skillId: string }>;
  }): Promise<SkillImportAdmission>;
}

export interface SkillCatalogRepository {
  /**
   * 指定 skill 的附带文件（scripts/references/assets）。
   * 仍带实例谓词（经 instance_skills JOIN）——skill_files 本身没有
   * instance_id 列，不接受「裸 skill id」取数，避免越界读到别家文件。
   */
  listSkillFiles(
    instanceId: string,
    skillIds: readonly string[],
  ): Promise<SkillFileRecord[]>;
  // 目录及包文件均通过本地实例归属校验；创建客户端仅作审计。
  /** 可见目录（内置/社区 + 自建），按精选与名称排序。 */
  listVisible(instanceId: string): Promise<Record<string, unknown>[]>;
  /** 可见 skill 明细；不可见或不存在均为 null。 */
  findVisibleById(
    instanceId: string,
    skillId: string,
  ): Promise<Record<string, unknown> | null>;
  /**
   * 建 skill（`source='user'` 且 `instance_id=实例` —— 与 RLS 写策略同义）。
   * 缺省字段沿用**列默认值**（`author='system'`/`version='1.0'`/`metadata='{}'`）：
   * 旧 PostgREST insert 不传的列即不出现，故此处用 `coalesce` 复刻同一语义，
   * 不能直接传 `null`（会写进 NULL 覆盖掉列默认）。
   */
  insertOwned(
    instanceId: string,
    input: OwnedSkillInsertInput,
  ): Promise<Record<string, unknown> | null>;
  /** 改 skill：仅实例创建的行（`instance_id=实例` 写在语句里，不靠 RLS）。 */
  updateOwnedById(
    instanceId: string,
    skillId: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  /** 删 skill：仅实例创建的行；返回受影响行数。 */
  deleteOwnedById(instanceId: string, skillId: string): Promise<number>;
  /** skill 的附带文件（经父链可见性）。 */
  listFilesForVisibleSkill(
    instanceId: string,
    skillId: string,
  ): Promise<Record<string, unknown>[]>;
  /** 写附带文件：仅当父 skill 属于实例（父子校验内联在一条语句里）。 */
  insertFilesForOwnedSkill(
    instanceId: string,
    skillId: string,
    rows: readonly {
      content: string;
      filePath: string;
      mimeType?: string | undefined;
    }[],
  ): Promise<number>;
  /** 实例已安装 skill（含停用；工具侧自行过滤启用项）。 */
  listInstanceSkills(
    instanceId: string,
    projectId?: string,
  ): Promise<InstanceSkillRecord[]>;
  /** 已安装列表（含 skill 明细，供管理视图；嵌套形状与旧 PostgREST 查询一致）。 */
  listInstalled(instanceId: string): Promise<InstalledSkillRow[]>;
  /** 当前实例的本地目录，包括内置/社区缓存及自定义技能。 */
  findVisibleSkill(
    instanceId: string,
    skillId: string,
  ): Promise<{ id: string } | null>;
  /** 安装/启停：按 (instance_id, skill_id) 冲突即更新。 */
  upsertInstallation(input: UpsertInstallationInput): Promise<void>;
  setEnabled(
    instanceId: string,
    skillId: string,
    enabled: boolean,
    installationRevision?: string,
  ): Promise<boolean>;
  /** 卸载；返回受影响行数（0 = 未安装）。 */
  uninstall(
    instanceId: string,
    skillId: string,
    installationRevision?: string,
  ): Promise<number>;
}

/** 实例安装态更新口径：只更新已有安装，卸载后的迟到启停不得重新安装。 */
export interface InstanceSkillSettingsRepository {
  setEnabled(
    instanceId: string,
    skillId: string,
    enabled: boolean,
    installationRevision?: string,
  ): Promise<boolean>;
}

export function createInstanceSkillSettingsRepository(
  persistence: PersistenceService,
): InstanceSkillSettingsRepository {
  return {
    async setEnabled(instanceId, skillId, enabled, installationRevision) {
      const changed = await persistence.forInstance(instanceId).execute(
        `update public.instance_skills set enabled = $2
        where instance_id = :instance and skill_id = $1
          and ($3::text is null or (installed_at at time zone 'UTC')::text = $3)`,
        [skillId, enabled, installationRevision ?? null],
      );
      return changed > 0;
    },
  };
}

export function createProjectSkillRepository(
  persistence: PersistenceService,
): ProjectSkillRepository {
  return {
    async findProject(instanceId, projectId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ id: string; name: string }>(
          `select id, name
             from public.projects
            where id = $1
              and instance_id = :instance`,
          [projectId],
        );
      return row ?? null;
    },

    async listProjectSkills(instanceId, projectId) {
      const rows = await persistence.forInstance(instanceId).query<{
        enabled: boolean;
        skill_id: string;
        updated_at: string;
      }>(
        `select ps.skill_id, ps.enabled,
                  (ps.updated_at at time zone 'UTC')::text as updated_at
             from public.project_skills ps
             join public.projects p
               on p.id = ps.project_id and p.instance_id = ps.instance_id
            where ps.instance_id = :instance and ps.project_id = $1
            order by ps.updated_at desc, ps.skill_id asc`,
        [projectId],
      );
      return rows.map((row) => ({
        enabled: row.enabled,
        skillId: row.skill_id,
        updatedAt: row.updated_at,
      }));
    },

    async upsertProjectSkill(input) {
      return persistence.forInstance(input.instanceId).execute(
        `insert into public.project_skills
                (instance_id, project_id, skill_id, enabled)
         select :instance, p.id, s.id, $3::boolean
           from public.projects p
           join public.skills s on s.instance_id = p.instance_id
          where p.instance_id = :instance
            and p.id = $1::uuid
            and s.id = $2::uuid
         on conflict (instance_id, project_id, skill_id)
         do update set enabled = excluded.enabled, updated_at = now()`,
        [input.projectId, input.skillId, input.enabled],
      );
    },

    async setProjectSkillEnabled(instanceId, projectId, skillId, enabled) {
      const changed = await persistence.forInstance(instanceId).execute(
        `update public.project_skills
            set enabled = $3::boolean, updated_at = now()
          where instance_id = :instance
            and project_id = $1
            and skill_id = $2`,
        [projectId, skillId, enabled],
      );
      return changed > 0;
    },
  };
}

export function createSkillImportReceiptRepository(
  persistence: PersistenceService,
): SkillImportReceiptRepository {
  return {
    async findImportReceipt(instanceId, requestKey) {
      const row = await persistence.forInstance(instanceId).queryOne<{
        parameter_fingerprint: string | null;
        skill_id: string | null;
        status: SkillImportReceiptStatus;
      }>(
        `select status, skill_id, parameter_fingerprint
             from public.skill_import_receipts
            where instance_id = :instance
              and request_key = $1`,
        [requestKey],
      );
      if (!row) {
        return null;
      }
      return {
        status: row.status,
        skillId: row.skill_id,
        parameterFingerprint: row.parameter_fingerprint,
      };
    },

    async findSkillBySlug(instanceId, slug) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ id: string }>(
          `select id
             from public.skills
            where instance_id = :instance
              and slug = $1`,
          [slug],
        );
      return row ?? null;
    },

    async admitImport(input) {
      return persistence.transaction(async (tx) => {
        const scoped = tx.forInstance(input.instanceId);
        // 同一来源的并发导入串行化；唯一主键仍作为跨进程兜底。
        await tx.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            JSON.stringify([
              "skill-import",
              input.instanceId,
              input.requestKey,
            ]),
          ],
        );
        const receipt = await scoped.queryOne<{
          parameter_fingerprint: string | null;
          skill_id: string | null;
          status: SkillImportReceiptStatus;
        }>(
          `select status, skill_id, parameter_fingerprint
             from public.skill_import_receipts
            where instance_id = :instance
              and request_key = $1`,
          [input.requestKey],
        );

        if (receipt) {
          if (receipt.status === "deleted") {
            throw new SkillImportDeletedError();
          }
          if (receipt.parameter_fingerprint !== input.parameterFingerprint) {
            throw new SkillImportConflictError();
          }
          if (!receipt.skill_id) {
            throw new SkillImportDeletedError();
          }
          return { kind: "replayed", skillId: receipt.skill_id };
        }

        const created = await input.create(scoped);
        await scoped.query(
          `insert into public.skill_import_receipts
                  (instance_id, request_key, status, skill_id,
                   parameter_fingerprint, source_root_path, source_slug)
           values (:instance, $1, 'imported', $2, $3, $4, $5)`,
          [
            input.requestKey,
            created.skillId,
            input.parameterFingerprint,
            input.sourceRootPath,
            input.sourceSlug,
          ],
        );
        return { kind: "created", skillId: created.skillId };
      });
    },
  };
}

type JoinedSkillRow = {
  enabled: boolean;
  id: string;
  slug: string;
  name: string;
  description: string;
  skill_content: string;
  installation_revision?: string;
};

/** 供导入事务复用：建技能与写回执在同一事务，实例谓词和列默认语义保持一致。 */
export async function insertOwnedSkillRecord(
  client: InstanceSqlClient,
  input: OwnedSkillInsertInput,
): Promise<Record<string, unknown> | null> {
  return client.queryOne<Record<string, unknown>>(
    `insert into public.skills
          (name, slug, description, category, skill_content, icon_name,
           source, instance_id, author, version, license, metadata,
           source_url, package_name, created_by_client_id)
   values ($1, $2, $3, $4, $5, $6, $7, :instance,
           coalesce($8, 'system'), coalesce($9, '1.0'), $10,
           coalesce($11::jsonb, '{}'::jsonb), $12, $13, $14)
   returning *`,
    [
      input.name,
      input.slug,
      input.description,
      input.category,
      input.skillContent,
      input.iconName ?? null,
      input.source ?? "user",
      input.author ?? null,
      input.version ?? null,
      input.license ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.sourceUrl ?? null,
      input.packageName ?? null,
      input.createdByClientId ?? null,
    ],
  );
}

/** 供导入事务复用：附带文件写入与父技能实例复验同一条语句。 */
export async function insertSkillFileRecords(
  client: InstanceSqlClient,
  skillId: string,
  rows: readonly SkillFileInsertRow[],
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }

  const values: unknown[] = [skillId];
  // `$1::uuid` 是必需的：`insert … select … from (values …)` 这个形状下，
  // Postgres 无法把目标列的 uuid 类型反推给未定型的参数，会把 $1 定成 text，
  // 于是 `s.id = $1` 报 `operator does not exist: uuid = text`（SQLSTATE 42883）。
  // 显式定型后 v.skill_id 也随之是 uuid，与目标列一致。
  const tuples = rows.map((row) => {
    values.push(row.filePath, row.content, row.mimeType ?? "text/plain");
    const end = values.length;
    return `($1::uuid, $${end - 2}, $${end - 1}, $${end})`;
  });

  return client.execute(
    `insert into public.skill_files (skill_id, file_path, content, mime_type)
     select v.*
       from (values ${tuples.join(", ")})
              as v(skill_id, file_path, content, mime_type)
      where exists (
        select 1 from public.skills s
         where s.id = $1::uuid and s.instance_id = :instance and s.source = 'user'
      )`,
    values,
  );
}

/** 供导入事务复用：安装态按 (实例, 技能) 冲突即更新。 */
export async function upsertInstanceSkillRecord(
  client: InstanceSqlClient,
  input: UpsertInstallationInput,
): Promise<void> {
  await client.query(
    `insert into public.instance_skills
            (instance_id, skill_id, enabled, installed_by_client_id)
     select :instance, s.id, $2::boolean, $3::uuid from public.skills s
     where s.id = $1::uuid and s.instance_id = :instance
     on conflict (instance_id, skill_id)
     do update set enabled = excluded.enabled`,
    [input.skillId, input.enabled, input.installedByClientId],
  );
}

export function createSkillCatalogRepository(
  persistence: PersistenceService,
): SkillCatalogRepository {
  const settings = createInstanceSkillSettingsRepository(persistence);
  return {
    setEnabled: settings.setEnabled,
    async listSkillFiles(instanceId, skillIds) {
      if (skillIds.length === 0) {
        return [];
      }

      const rows = await persistence
        .forInstance(instanceId)
        .query<{ skill_id: string; file_path: string; content: string }>(
          `select sf.skill_id, sf.file_path, sf.content
             from public.skill_files sf
             join public.instance_skills ws on ws.skill_id = sf.skill_id
             join public.skills s on s.id = sf.skill_id
            where ws.instance_id = :instance and s.instance_id = :instance
              and sf.skill_id = any($1::uuid[])`,
          [skillIds],
        );

      return rows.map((row) => ({
        skillId: row.skill_id,
        path: row.file_path,
        content: row.content,
      }));
    },

    async listInstalled(instanceId) {
      const rows = await persistence
        .forInstance(instanceId)
        .query<Record<string, unknown>>(
          `select ws.skill_id, ws.enabled, ws.installed_at, s.*
             from public.instance_skills ws
             join public.skills s on s.id = ws.skill_id
            where ws.instance_id = :instance and s.instance_id = :instance
            order by ws.installed_at desc`,
        );

      return rows.map((row) => {
        const { skill_id, enabled, installed_at, ...skill } = row;
        return {
          skill_id: skill_id as string,
          enabled: enabled as boolean,
          installed_at: installed_at as string,
          // 没有对应 skill 行时（内连接下不会发生）保持 null，与旧形状一致
          skills: Object.keys(skill).length > 0 ? skill : null,
        };
      });
    },

    async findVisibleSkill(instanceId, skillId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ id: string }>(
          `select id
           from public.skills
          where id = $1
            and (instance_id = :instance)`,
          [skillId],
        );
      return row ?? null;
    },

    async upsertInstallation(input) {
      await upsertInstanceSkillRecord(
        persistence.forInstance(input.instanceId),
        input,
      );
    },

    async uninstall(instanceId, skillId, installationRevision) {
      return persistence.forInstance(instanceId).execute(
        `delete from public.instance_skills
          where instance_id = :instance
            and skill_id = $1
            and ($2::text is null or (installed_at at time zone 'UTC')::text = $2)`,
        [skillId, installationRevision ?? null],
      );
    },

    async listVisible(instanceId) {
      return persistence.forInstance(instanceId).query<Record<string, unknown>>(
        `select *
           from public.skills
          where instance_id = :instance
          order by is_featured desc, name asc`,
      );
    },

    async findVisibleById(instanceId, skillId) {
      return persistence
        .forInstance(instanceId)
        .queryOne<Record<string, unknown>>(
          `select *
           from public.skills
          where id = $1
            and (instance_id = :instance)`,
          [skillId],
        );
    },

    async insertOwned(instanceId, input) {
      return insertOwnedSkillRecord(persistence.forInstance(instanceId), input);
    },

    async updateOwnedById(instanceId, skillId, patch) {
      const assignments: string[] = [];
      const values: unknown[] = [skillId];

      for (const [column, value] of Object.entries(patch)) {
        if (value === undefined) {
          continue;
        }
        values.push(column === "metadata" ? JSON.stringify(value) : value);
        assignments.push(
          `${column} = $${values.length}${column === "metadata" ? "::jsonb" : ""}`,
        );
      }

      if (assignments.length === 0) {
        return null;
      }

      return persistence
        .forInstance(instanceId)
        .queryOne<Record<string, unknown>>(
          `update public.skills
            set ${assignments.join(", ")}
          where id = $1
            and instance_id = :instance and source = 'user'
        returning *`,
          values,
        );
    },

    async deleteOwnedById(instanceId, skillId) {
      return persistence.forInstance(instanceId).execute(
        `delete from public.skills
          where id = $1
            and instance_id = :instance and source = 'user'`,
        [skillId],
      );
    },

    async listFilesForVisibleSkill(instanceId, skillId) {
      return persistence.forInstance(instanceId).query<Record<string, unknown>>(
        `select sf.*
           from public.skill_files sf
           join public.skills s on s.id = sf.skill_id
          where sf.skill_id = $1
            and (s.instance_id = :instance)
          order by sf.file_path asc`,
        [skillId],
      );
    },

    async insertFilesForOwnedSkill(instanceId, skillId, rows) {
      return insertSkillFileRecords(
        persistence.forInstance(instanceId),
        skillId,
        rows,
      );
    },

    async listInstanceSkills(instanceId, projectId) {
      const rows = await persistence
        .forInstance(instanceId)
        .query<JoinedSkillRow>(
          `select coalesce(ps.enabled, ws.enabled) as enabled,
                  s.id, s.slug, s.name, s.description, s.skill_content,
                  (ws.installed_at at time zone 'UTC')::text as installation_revision
             from public.instance_skills ws
             join public.skills s on s.id = ws.skill_id
             left join public.project_skills ps on ps.instance_id = ws.instance_id
               and ps.skill_id = ws.skill_id and ps.project_id = $1::uuid
            where ws.instance_id = :instance and s.instance_id = :instance
              and ($1::uuid is null or exists (
                select 1 from public.projects p where p.id = $1::uuid
                  and p.instance_id = :instance and p.archived_at is null
              ))`,
          [projectId ?? null],
        );

      return rows.map((row) => ({
        enabled: row.enabled,
        skillId: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        skillContent: row.skill_content,
        ...(row.installation_revision
          ? { installationRevision: row.installation_revision }
          : {}),
      }));
    },
  };
}
