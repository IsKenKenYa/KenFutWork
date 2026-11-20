import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveMigrationRoots } from "./runtime.js";

const exeDir = join("D:/", "app");
const repoRoot = join("D:/", "repo");

describe("桌面迁移目录解析", () => {
  it("优先使用 <exeDir>/db", () => {
    expect(
      resolveMigrationRoots({
        env: {},
        exists: (path) => path.startsWith(exeDir) || path.startsWith(repoRoot),
        exeDir,
        repoRoot,
      }),
    ).toEqual({
      bootstrapDir: join(exeDir, "db", "bootstrap"),
      migrationsDir: join(exeDir, "db", "migrations"),
    });
  });

  it("没有发布目录时回落到 <repoRoot>/docker/pg", () => {
    expect(
      resolveMigrationRoots({
        env: {},
        exists: (path) => path.startsWith(repoRoot),
        exeDir,
        repoRoot,
      }),
    ).toEqual({
      bootstrapDir: join(repoRoot, "docker", "pg", "bootstrap"),
      migrationsDir: join(repoRoot, "docker", "pg", "migrations"),
    });
  });

  it("KENFUTWORK_MIGRATIONS_ROOT 覆盖默认位置", () => {
    const override = join("E:/", "migrations");
    expect(
      resolveMigrationRoots({
        env: { KENFUTWORK_MIGRATIONS_ROOT: override },
        exists: (path) => path.startsWith(override),
        exeDir,
        repoRoot,
      }),
    ).toEqual({
      bootstrapDir: join(override, "bootstrap"),
      migrationsDir: join(override, "migrations"),
    });
  });

  it("两处都不存在时返回 undefined", () => {
    expect(
      resolveMigrationRoots({
        env: {},
        exists: () => false,
        exeDir,
        repoRoot,
      }),
    ).toBeUndefined();
  });
});
