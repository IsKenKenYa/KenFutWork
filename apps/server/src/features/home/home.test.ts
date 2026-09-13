import { describe, expect, it } from "vitest";

import type { BlobStore } from "../blob/types.js";
import { createHomeRepository, type HomeRepository } from "./repository.js";
import { createHomeService, splitObjectRef } from "./service.js";

function createBlobStub(options: { failFor?: string } = {}) {
  const calls: string[] = [];
  const blob = {
    bucket: (name: string) => ({
      resolveUrl: async (objectPath: string) => {
        const full = `${name}/${objectPath}`;
        calls.push(full);
        if (options.failFor && full.includes(options.failFor)) {
          throw new Error("blob unavailable");
        }
        return `http://blob.test/${full}`;
      },
    }),
  } as unknown as BlobStore;
  return { blob, calls };
}

function createRepositoryStub(overrides: Partial<HomeRepository> = {}) {
  const repository: HomeRepository = {
    listCategories: async () => [
      { accent: "#111", key: "design", label: "Design" },
    ],
    listDiscoveryCases: async () => [
      {
        author_avatar_url: "project-assets/home-seeds/discovery/a/avatar.webp",
        author_name: "作者",
        category_key: "poster-and-ads",
        cover_image_url: "project-assets/home-seeds/discovery/a/cover.webp",
        id: "n9d21de",
        like_count: 12,
        seed_prompt: "围绕 Vintage Car Poster 这个方向帮我设计",
        title: "Vintage Car Poster",
        view_count: 340,
      },
    ],
    listExamples: async () => [
      {
        category_key: "design",
        id: "ex-1",
        image_urls: [
          "project-assets/home-seeds/examples/design/e1-1.webp",
          "project-assets/home-seeds/examples/design/e1-2.webp",
        ],
        input_mentions: [
          {
            imgSrc: "project-assets/home-seeds/icons/imagen-3.svg",
            name: "Nano Banana",
            type: "tool",
          },
        ],
        prompt: "Make a poster for a music festival in the Bauhaus style.",
        title: "Design a Bauhaus-inspired poster.",
      },
    ],
    ...overrides,
  };
  return repository;
}

describe("首页库：对象引用的桶/路径拆分", () => {
  it("拆出桶名与对象路径；畸形引用返回 null（不抛）", () => {
    expect(splitObjectRef("project-assets/home-seeds/a.webp")).toEqual({
      bucket: "project-assets",
      objectPath: "home-seeds/a.webp",
    });
    expect(splitObjectRef("no-slash")).toBeNull();
    expect(splitObjectRef("/leading-slash")).toBeNull();
    expect(splitObjectRef("bucket/")).toBeNull();
  });
});

describe("首页库服务：映射与素材 URL 解析", () => {
  it("示例/发现的素材引用经 blob 缝解析成 URL，引用原样不泄露给前端", async () => {
    const { blob, calls } = createBlobStub();
    const service = createHomeService({
      blob,
      repository: createRepositoryStub(),
    });

    const library = await service.getLibrary();

    expect(library.examples[0]?.imageUrls).toEqual([
      "http://blob.test/project-assets/home-seeds/examples/design/e1-1.webp",
      "http://blob.test/project-assets/home-seeds/examples/design/e1-2.webp",
    ]);
    expect(library.examples[0]?.inputMentions[0]).toEqual({
      imgSrc: "http://blob.test/project-assets/home-seeds/icons/imagen-3.svg",
      name: "Nano Banana",
      type: "tool",
    });
    expect(library.discoveryCases[0]?.coverUrl).toBe(
      "http://blob.test/project-assets/home-seeds/discovery/a/cover.webp",
    );
    expect(library.discoveryCases[0]?.authorAvatarUrl).toBe(
      "http://blob.test/project-assets/home-seeds/discovery/a/avatar.webp",
    );
    // prompt/seedPrompt 原样透传（点卡片要带进画布）
    expect(library.examples[0]?.prompt).toContain("Bauhaus");
    expect(library.discoveryCases[0]?.seedPrompt).toContain("Vintage Car");
    expect(calls).toHaveLength(5);
  });

  it("单张素材解析失败只剔除该项，不拖垮整份响应", async () => {
    const { blob } = createBlobStub({ failFor: "e1-2.webp" });
    const service = createHomeService({
      blob,
      repository: createRepositoryStub(),
    });

    const library = await service.getLibrary();

    expect(library.examples[0]?.imageUrls).toEqual([
      "http://blob.test/project-assets/home-seeds/examples/design/e1-1.webp",
    ]);
    expect(library.discoveryCases).toHaveLength(1);
    expect(library.categories).toHaveLength(1);
  });

  it("input_mentions 形状畸形时不崩（空数组/非数组）", async () => {
    const { blob } = createBlobStub();
    const service = createHomeService({
      blob,
      repository: createRepositoryStub({
        listExamples: async () => [
          {
            category_key: "design",
            id: "ex-bad",
            image_urls: [],
            input_mentions: "not-an-array",
            prompt: "p",
            title: "t",
          },
          {
            category_key: "design",
            id: "ex-null",
            image_urls: [],
            input_mentions: null,
            prompt: "p",
            title: "t",
          },
        ],
      }),
    });

    const library = await service.getLibrary();
    expect(library.examples.map((e) => e.inputMentions)).toEqual([[], []]);
  });

  it("仓储 SQL：只取活跃行、按 sort_order 排序、走根客户端（全局内容）", async () => {
    const calls: string[] = [];
    const persistence = {
      query: async (sql: string) => {
        calls.push(sql.replace(/\s+/g, " ").trim());
        return [];
      },
    } as never;

    const repository = createHomeRepository(persistence);
    await repository.listCategories();
    await repository.listExamples();
    await repository.listDiscoveryCases();

    expect(calls[0]).toContain("from public.home_example_categories");
    expect(calls[1]).toContain("from public.home_example_examples");
    expect(calls[2]).toContain("from public.home_discovery_cases");
    for (const sql of calls) {
      expect(sql).toContain("where is_active = true");
      expect(sql).toContain("order by");
    }
  });
});
