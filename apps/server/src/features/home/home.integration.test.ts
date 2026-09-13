import { describe, expect, it } from "vitest";
import type { BlobStore } from "../blob/types.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createHomeRepository } from "./repository.js";
import { createHomeService } from "./service.js";

/**
 * 首页库真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明这两张**此前全仓无读取方**的种子表真的能被读出来，且素材引用（M2.1 本地化成
 * 相对对象引用）能被解析成 URL——这是「接线」完成的实际证据。
 *
 * 运行：DATABASE_URL=postgresql://... pnpm --filter @loomic/server exec vitest run home.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

/** 真库连接 + 假 blob（只把引用拼成 URL，验证「引用被解析」而非存储实现）。 */
function createBlobStub() {
  return {
    bucket: (name: string) => ({
      resolveUrl: async (objectPath: string) =>
        `http://blob.test/${name}/${objectPath}`,
    }),
  } as unknown as BlobStore;
}

describe.skipIf(!DATABASE_URL)("首页库真实库集成", () => {
  it("读得出示例/发现/分类，且素材无残留绝对云 URL（已是相对引用）", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const service = createHomeService({
        blob: createBlobStub(),
        repository: createHomeRepository(persistence),
      });
      const library = await service.getLibrary();

      // 种子规模（36 示例 / 8 发现）：允许后续增删，但必须非空
      expect(library.examples.length).toBeGreaterThanOrEqual(30);
      expect(library.discoveryCases.length).toBeGreaterThanOrEqual(8);
      expect(library.categories.length).toBeGreaterThanOrEqual(6);

      // 每张示例都能给出可用的产出图（说明引用解析成功）
      for (const example of library.examples) {
        expect(example.prompt.length).toBeGreaterThan(0);
        expect(example.imageUrls.length).toBeGreaterThan(0);
        expect(example.imageUrls[0]).toMatch(/^http:\/\/blob\.test\//);
        expect(example.imageUrls[0]).not.toContain("supabase.co");
      }

      // 发现库封面与作者头像同样解析成功，且带得走 prompt（点卡片用）
      for (const item of library.discoveryCases) {
        expect(item.coverUrl).toMatch(/^http:\/\/blob\.test\//);
        expect(item.authorAvatarUrl).toMatch(/^http:\/\/blob\.test\//);
        expect(item.seedPrompt.length).toBeGreaterThan(0);
      }

      // 分类键唯一且被示例引用（前端按分类分组展示）
      const keys = library.categories.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    } finally {
      await persistence.close();
    }
  });
});
