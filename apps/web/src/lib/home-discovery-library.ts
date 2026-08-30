import type { Database } from "@loomic/shared";

import type { HomeDiscoveryCategory } from "./home-discovery-seeds";
import { homeDiscoverySeedCategories } from "./home-discovery-seeds";
import { getSupabaseBrowserClient } from "./supabase-browser";

type HomeDiscoveryCategoryRow =
  Database["public"]["Tables"]["home_discovery_categories"]["Row"];
type HomeDiscoveryCaseRow =
  Database["public"]["Tables"]["home_discovery_cases"]["Row"];

export function mapHomeDiscoveryRows(
  categories: HomeDiscoveryCategoryRow[],
  cases: HomeDiscoveryCaseRow[],
): HomeDiscoveryCategory[] {
  const casesByCategory = new Map<string, HomeDiscoveryCaseRow[]>();

  for (const item of cases) {
    const group = casesByCategory.get(item.category_key) ?? [];
    group.push(item);
    casesByCategory.set(item.category_key, group);
  }

  return [...categories]
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((category) => ({
      key: category.key,
      label: category.label,
      cases: [...(casesByCategory.get(category.key) ?? [])]
        .sort((left, right) => left.sort_order - right.sort_order)
        .map((item) => ({
          id: item.id,
          title: item.title,
          coverImageUrl: item.cover_image_url,
          authorName: item.author_name,
          authorAvatarUrl: item.author_avatar_url,
          viewCount: item.view_count,
          likeCount: item.like_count,
          prompt: item.seed_prompt,
        })),
    }));
}

export async function loadHomeDiscoveryCategories(): Promise<
  HomeDiscoveryCategory[]
> {
  const supabase = getSupabaseBrowserClient();

  const [categoriesResult, casesResult] = await Promise.all([
    supabase
      .from("home_discovery_categories")
      .select("key, label, sort_order, is_active, created_at, updated_at")
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    supabase
      .from("home_discovery_cases")
      .select(
        "id, category_key, title, cover_image_url, author_name, author_avatar_url, view_count, like_count, case_url, seed_prompt, sort_order, is_active, created_at, updated_at",
      )
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
  ]);

  if (categoriesResult.error) {
    throw categoriesResult.error;
  }

  if (casesResult.error) {
    throw casesResult.error;
  }

  const mapped = mapHomeDiscoveryRows(
    categoriesResult.data ?? [],
    casesResult.data ?? [],
  );

  return mapped.length > 0 ? mapped : homeDiscoverySeedCategories;
}
