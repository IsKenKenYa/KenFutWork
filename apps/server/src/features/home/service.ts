import type {
  HomeDiscoveryCase,
  HomeExample,
  HomeExampleInputMention,
  HomeLibraryResponse,
} from "@loomic/shared";

import type { BlobStore } from "../blob/types.js";
import type { HomeExampleRow, HomeRepository } from "./repository.js";

/**
 * 首页库服务：把种子行映射成契约，并把**相对对象引用**经 blob 缝解析成可访问 URL。
 *
 * 为什么在服务端解析：素材路径形如 `project-assets/home-seeds/...`（M2.1 把绝对云 URL
 * 本地化后的相对引用），只有服务端知道当前存储形态（本地 FS / MinIO / 对象存储）与桶的
 * 公开性；前端拿到的是可直接 <img src> 的 URL。解析失败不阻断整份响应——对应字段为 null
 * 或从数组中剔除（宁可少一张图，也不要整页打不开）。
 */

export type HomeService = {
  getLibrary(): Promise<HomeLibraryResponse>;
};

/** `project-assets/xxx/yyy.webp` → `{ bucket: "project-assets", objectPath: "xxx/yyy.webp" }` */
export function splitObjectRef(
  ref: string,
): { bucket: string; objectPath: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return null;
  }
  return { bucket: ref.slice(0, slash), objectPath: ref.slice(slash + 1) };
}

export function createHomeService(options: {
  blob: BlobStore;
  repository: HomeRepository;
}): HomeService {
  const { blob, repository } = options;

  /** 对象引用 → 可访问 URL；解析不了返回 null（不抛，交给调用方决定降级形态）。 */
  const resolveRef = async (ref: string): Promise<string | null> => {
    const split = splitObjectRef(ref);
    if (!split) {
      return null;
    }
    try {
      return await blob.bucket(split.bucket).resolveUrl(split.objectPath);
    } catch {
      return null;
    }
  };

  const mapMentions = async (
    raw: unknown,
  ): Promise<HomeExampleInputMention[]> => {
    if (!Array.isArray(raw)) {
      return [];
    }
    return Promise.all(
      raw
        .filter(
          (
            item,
          ): item is { imgSrc?: unknown; name?: unknown; type?: unknown } =>
            typeof item === "object" && item !== null,
        )
        .map(async (item) => ({
          imgSrc:
            typeof item.imgSrc === "string"
              ? await resolveRef(item.imgSrc)
              : null,
          name: typeof item.name === "string" ? item.name : "",
          type: typeof item.type === "string" ? item.type : "",
        })),
    );
  };

  const mapExample = async (row: HomeExampleRow): Promise<HomeExample> => {
    const resolvedImages = await Promise.all(
      (row.image_urls ?? []).map((ref) => resolveRef(ref)),
    );
    return {
      categoryKey: row.category_key,
      id: row.id,
      // 解析失败的图直接剔除（卡片仍可用，只是少一张预览）
      imageUrls: resolvedImages.filter((url): url is string => url !== null),
      inputMentions: await mapMentions(row.input_mentions),
      prompt: row.prompt,
      title: row.title,
    };
  };

  return {
    async getLibrary() {
      const [categories, examples, discovery] = await Promise.all([
        repository.listCategories(),
        repository.listExamples(),
        repository.listDiscoveryCases(),
      ]);

      const mappedExamples = await Promise.all(examples.map(mapExample));
      const mappedDiscovery: HomeDiscoveryCase[] = await Promise.all(
        discovery.map(async (row) => ({
          authorAvatarUrl: await resolveRef(row.author_avatar_url),
          authorName: row.author_name,
          categoryKey: row.category_key,
          coverUrl: await resolveRef(row.cover_image_url),
          id: row.id,
          likeCount: row.like_count,
          seedPrompt: row.seed_prompt,
          title: row.title,
          viewCount: row.view_count,
        })),
      );

      return {
        categories: categories.map((row) => ({
          accent: row.accent,
          key: row.key,
          label: row.label,
        })),
        discoveryCases: mappedDiscovery,
        examples: mappedExamples,
      };
    },
  };
}
