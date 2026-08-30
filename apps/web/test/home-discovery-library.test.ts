import type { Database } from "@loomic/shared";
import { describe, expect, it } from "vitest";

import { mapHomeDiscoveryRows } from "@/lib/home-discovery-library";

type HomeDiscoveryCategoryRow =
  Database["public"]["Tables"]["home_discovery_categories"]["Row"];
type HomeDiscoveryCaseRow =
  Database["public"]["Tables"]["home_discovery_cases"]["Row"];

describe("mapHomeDiscoveryRows", () => {
  it("groups active cases under sorted discovery categories", () => {
    const categories: HomeDiscoveryCategoryRow[] = [
      {
        created_at: "2026-03-29T00:00:00.000Z",
        is_active: true,
        key: "poster-and-ads",
        label: "海报与广告",
        sort_order: 1,
        updated_at: "2026-03-29T00:00:00.000Z",
      },
      {
        created_at: "2026-03-29T00:00:00.000Z",
        is_active: true,
        key: "branding-design",
        label: "品牌设计",
        sort_order: 0,
        updated_at: "2026-03-29T00:00:00.000Z",
      },
    ];

    const cases: HomeDiscoveryCaseRow[] = [
      {
        author_avatar_url: "avatar-b",
        author_name: "Author B",
        case_url: "https://example.com/case-b",
        category_key: "branding-design",
        cover_image_url: "cover-b",
        created_at: "2026-03-29T00:00:00.000Z",
        id: "case-b",
        is_active: true,
        like_count: 20,
        seed_prompt: "Prompt B",
        sort_order: 1,
        title: "Second",
        updated_at: "2026-03-29T00:00:00.000Z",
        view_count: 200,
      },
      {
        author_avatar_url: "avatar-a",
        author_name: "Author A",
        case_url: "https://example.com/case-a",
        category_key: "branding-design",
        cover_image_url: "cover-a",
        created_at: "2026-03-29T00:00:00.000Z",
        id: "case-a",
        is_active: true,
        like_count: 10,
        seed_prompt: "Prompt A",
        sort_order: 0,
        title: "First",
        updated_at: "2026-03-29T00:00:00.000Z",
        view_count: 100,
      },
    ];

    expect(mapHomeDiscoveryRows(categories, cases)).toEqual([
      {
        key: "branding-design",
        label: "品牌设计",
        cases: [
          {
            authorAvatarUrl: "avatar-a",
            authorName: "Author A",
            coverImageUrl: "cover-a",
            id: "case-a",
            likeCount: 10,
            prompt: "Prompt A",
            title: "First",
            viewCount: 100,
          },
          {
            authorAvatarUrl: "avatar-b",
            authorName: "Author B",
            coverImageUrl: "cover-b",
            id: "case-b",
            likeCount: 20,
            prompt: "Prompt B",
            title: "Second",
            viewCount: 200,
          },
        ],
      },
      {
        key: "poster-and-ads",
        label: "海报与广告",
        cases: [],
      },
    ]);
  });
});
