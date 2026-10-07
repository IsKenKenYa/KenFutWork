import type { PersistenceService } from "../persistence/types.js";

export type InstanceSkillRecord = {
  enabled: boolean;
  skillId: string;
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
    input: {
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
    },
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
  listInstanceSkills(instanceId: string): Promise<InstanceSkillRecord[]>;
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
  ): Promise<boolean>;
  /** 卸载；返回受影响行数（0 = 未安装）。 */
  uninstall(instanceId: string, skillId: string): Promise<number>;
}

/** 实例安装态更新口径：只更新已有安装，卸载后的迟到启停不得重新安装。 */
export interface InstanceSkillSettingsRepository {
  setEnabled(
    instanceId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<boolean>;
}

export function createInstanceSkillSettingsRepository(
  persistence: PersistenceService,
): InstanceSkillSettingsRepository {
  return {
    async setEnabled(instanceId, skillId, enabled) {
      const changed = await persistence.forInstance(instanceId).execute(
        `update public.instance_skills set enabled = $2
        where instance_id = :instance and skill_id = $1`,
        [skillId, enabled],
      );
      return changed > 0;
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
};

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
      await persistence.forInstance(input.instanceId).query(
        `insert into public.instance_skills
                (instance_id, skill_id, enabled, installed_by_client_id)
         select :instance, s.id, $2::boolean, $3::uuid from public.skills s
         where s.id = $1::uuid and s.instance_id = :instance
         on conflict (instance_id, skill_id)
         do update set enabled = excluded.enabled`,
        [input.skillId, input.enabled, input.installedByClientId],
      );
    },

    async uninstall(instanceId, skillId) {
      return persistence.forInstance(instanceId).execute(
        `delete from public.instance_skills
          where instance_id = :instance
            and skill_id = $1`,
        [skillId],
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
      return persistence
        .forInstance(instanceId)
        .queryOne<Record<string, unknown>>(
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

      return persistence.forInstance(instanceId).execute(
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
    },

    async listInstanceSkills(instanceId) {
      const rows = await persistence
        .forInstance(instanceId)
        .query<JoinedSkillRow>(
          `select ws.enabled, s.id, s.slug, s.name, s.description, s.skill_content
             from public.instance_skills ws
             join public.skills s on s.id = ws.skill_id
            where ws.instance_id = :instance and s.instance_id = :instance`,
        );

      return rows.map((row) => ({
        enabled: row.enabled,
        skillId: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        skillContent: row.skill_content,
      }));
    },
  };
}
