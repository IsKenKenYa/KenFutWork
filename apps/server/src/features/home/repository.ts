import type { PersistenceService } from "../persistence/types.js";

/**
 * 首页示例库 / 发现库的数据访问（`home_*` 三张种子表）。
 *
 * **隔离口径（`FORM-9` 豁免，理由记录于此）**：这三张表是**静态产品内容**——没有
 * `workspace_id`/`user_id` 列，内容对所有工作区相同，也不含任何租户数据；查询形态只有
 * 「按 sort_order 列活跃行」，没有列表扫描越权的可能。故走根客户端读取（与 `skills`
 * 表的公开目录读取同一类口径）。写侧不在此 feature（种子由迁移灌入）。
 */

export type HomeCategoryRow = {
  accent: string | null;
  key: string;
  label: string;
};

export type HomeExampleRow = {
  category_key: string;
  id: string;
  image_urls: string[];
  input_mentions: unknown;
  prompt: string;
  title: string;
};

export type HomeDiscoveryCaseRow = {
  author_avatar_url: string;
  author_name: string;
  category_key: string;
  cover_image_url: string;
  id: string;
  like_count: number;
  seed_prompt: string;
  title: string;
  view_count: number;
};

export interface HomeRepository {
  listCategories(): Promise<HomeCategoryRow[]>;
  listDiscoveryCases(): Promise<HomeDiscoveryCaseRow[]>;
  listExamples(): Promise<HomeExampleRow[]>;
}

export function createHomeRepository(
  persistence: PersistenceService,
): HomeRepository {
  return {
    async listCategories() {
      return persistence.query<HomeCategoryRow>(
        `select key, label, accent
           from public.home_example_categories
          where is_active = true
          order by sort_order`,
      );
    },

    async listExamples() {
      return persistence.query<HomeExampleRow>(
        `select id, category_key, title, prompt, image_urls, input_mentions
           from public.home_example_examples
          where is_active = true
          order by category_key, sort_order`,
      );
    },

    async listDiscoveryCases() {
      return persistence.query<HomeDiscoveryCaseRow>(
        `select id, category_key, title, cover_image_url, author_name,
                author_avatar_url, view_count, like_count, seed_prompt
           from public.home_discovery_cases
          where is_active = true
          order by category_key, sort_order`,
      );
    },
  };
}
