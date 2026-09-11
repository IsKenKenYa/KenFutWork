import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

/**
 * skill 目录服务（P5「skill 收敛为缝」）：
 * SKILL.md 发现从 agent 内部装配（workspace-skills）抽为可复用缝，
 * 由 skills 插件向 `ctx.tools` 贡献 `list_skills` / `use_skill` 工具。
 * 数据源与 SkillsMiddleware 同源（workspace_skills + skills.skill_content）。
 */

export interface SkillCatalogEntry {
  /** skill slug（deepagents 虚拟目录名） */
  name: string;
  description: string;
  enabled: boolean;
  /** 附加文件数（scripts/references/assets） */
  fileCount: number;
}

export interface SkillCatalogDetail {
  name: string;
  description: string;
  /** SKILL.md 全文（skills.skill_content） */
  content: string;
}

interface SkillRow {
  skill: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    skill_content: string | null;
  } | null;
}

// workspace_skills / skills 未纳入 supabase 生成类型，走宽松访问（同 workspace-skills）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untypedFrom = (client: UserSupabaseClient, table: string): any =>
  (client as any).from(table);

export interface SkillCatalogService {
  /** 工作区已安装 skill 清单（含停用，供管理视图；工具侧只展示启用项）。 */
  listSkills(user: AuthenticatedUser): Promise<SkillCatalogEntry[]>;
  /** 按 slug 取 SKILL.md 全文；未安装/停用即 404 语义。 */
  getSkill(
    user: AuthenticatedUser,
    slug: string,
  ): Promise<SkillCatalogDetail | undefined>;
}

export function createSkillCatalogService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): SkillCatalogService {
  const { createUserClient } = options;

  async function resolveWorkspaceId(
    client: UserSupabaseClient,
    userId: string,
  ): Promise<string | undefined> {
    const { data } = await client
      .from("workspaces")
      .select("id")
      .eq("owner_user_id", userId)
      .eq("type", "personal")
      .limit(1)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? undefined;
  }

  async function loadRows(
    client: UserSupabaseClient,
    workspaceId: string,
  ): Promise<SkillRow[]> {
    const { data: rows } = await untypedFrom(client, "workspace_skills")
      .select(
        "enabled, skill:skills(id, slug, name, description, skill_content)",
      )
      .eq("workspace_id", workspaceId);
    return (rows ?? []) as SkillRow[];
  }

  return {
    async listSkills(user) {
      const client = createUserClient(user.accessToken);
      const workspaceId = await resolveWorkspaceId(client, user.id);
      if (!workspaceId) {
        return [];
      }
      const rows = await loadRows(client, workspaceId);
      return rows
        .filter((row) => row.skill)
        .map((row) => ({
          name: row.skill!.slug,
          description: row.skill!.description ?? "",
          enabled: (row as unknown as { enabled: boolean }).enabled ?? false,
          fileCount: 0,
        }));
    },

    async getSkill(user, slug) {
      const client = createUserClient(user.accessToken);
      const workspaceId = await resolveWorkspaceId(client, user.id);
      if (!workspaceId) {
        return undefined;
      }
      const rows = await loadRows(client, workspaceId);
      const row = rows.find((r) => r.skill?.slug === slug);
      if (!row?.skill || !(row as unknown as { enabled: boolean }).enabled) {
        return undefined;
      }
      return {
        name: row.skill.slug,
        description: row.skill.description ?? "",
        content: row.skill.skill_content ?? "",
      };
    },
  };
}
