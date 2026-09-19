import { describe, expect, it } from "vitest";

import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import {
  createPermissionSettingsStore,
  DEFAULT_PERMISSION_SETTINGS,
} from "./tier-store.js";

/**
 * 权限设置持久化真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明四件事（常规档 / 自动化档 / 自定义规则 / 浏览器控制）写穿 app_config
 * 后跨连接读回一致（重启漂移的回归锁）。
 *
 * 运行：DATABASE_URL=postgresql://... pnpm --filter @kenfutwork/server exec vitest run tier-store.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("权限设置持久化真实库集成", () => {
  it("save 写穿 + load 读回一致；重复 save 覆盖；收尾恢复缺省", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });
    try {
      const store = createPermissionSettingsStore(persistence);

      await store.save(DEFAULT_PERMISSION_SETTINGS);
      expect(await store.load()).toEqual(DEFAULT_PERMISSION_SETTINGS);

      await store.save({
        tier: "custom",
        automationTier: "default",
        rules: { allow: ["write_file"], deny: ["mcp__*"] },
        browserControlEnabled: true,
        browserAutoScreenshot: true,
        browserHeadless: true,
        browserDevtoolsReadEnabled: true,
      });
      expect(await store.load()).toEqual({
        tier: "custom",
        automationTier: "default",
        rules: { allow: ["write_file"], deny: ["mcp__*"] },
        browserControlEnabled: true,
        browserAutoScreenshot: true,
        browserHeadless: true,
        browserDevtoolsReadEnabled: true,
      });

      // 收尾：恢复缺省，不给其它测试/本地开发留 full-access 或放行规则（安全）
      await store.save(DEFAULT_PERMISSION_SETTINGS);
      expect(await store.load()).toEqual(DEFAULT_PERMISSION_SETTINGS);
    } finally {
      await persistence.close();
    }
  });
});
