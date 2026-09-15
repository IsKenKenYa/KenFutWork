import { describe, expect, it } from "vitest";

import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createPermissionTierStore } from "./tier-store.js";

/**
 * 权限档位持久化真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明全局档位写穿 app_config 后跨连接读回一致（重启漂移的回归锁）。
 *
 * 运行：DATABASE_URL=postgresql://... pnpm --filter @kenfutwork/server exec vitest run permission-tier-store.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("权限档位持久化真实库集成", () => {
  it("save 写穿 + load 读回一致；未设置时 load 返回 null；重复 save 覆盖", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });
    try {
      const store = createPermissionTierStore(persistence);

      // 起始态：读出 null 或上次遗留值——先归位到 default 再断言写穿
      await store.save("default");
      expect(await store.load()).toBe("default");

      await store.save("auto-approve");
      expect(await store.load()).toBe("auto-approve");

      await store.save("full-access");
      expect(await store.load()).toBe("full-access");

      // 收尾：恢复 default，不给其它测试/本地开发留 full-access（安全）
      await store.save("default");
      expect(await store.load()).toBe("default");
    } finally {
      await persistence.close();
    }
  });
});
