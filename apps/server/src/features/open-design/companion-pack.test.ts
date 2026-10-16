import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OPEN_DESIGN_COMPANION_ORIGIN } from "./companion.js";

/**
 * 伴随容器**资源面**的一致性锁（§201-D 的打包面收敛）：
 * 完整 win/mac 打包不在每次门禁里跑，但「打包会带上什么、宿主按什么找」这三方
 * 契约必须每次都对齐——compose 文件在仓库根、打包脚本捆绑同一目录、
 * 伴随 origin 常量与 compose 发布端口同源。任何一侧漂移，这里先红。
 */

const REPO_ROOT = join(__dirname, "../../../../..");
const COMPOSE_FILE = join(
  REPO_ROOT,
  "open-design",
  "docker-compose.open-design.yml",
);

describe("OpenDesign 伴随容器资源面", () => {
  it("源码态 compose 资源存在且带伴随语义的三要素", () => {
    expect(existsSync(COMPOSE_FILE)).toBe(true);
    const text = readFileSync(COMPOSE_FILE, "utf8");
    // 钉 digest（升级=改这里走回归，§8 风险 3）
    expect(text).toContain("image: ghcr.io/nexu-io/od@sha256:");
    // 只发布宿主环回（信任边界与 OD_DISABLE_API_AUTH 豁免的前提）
    expect(text).toContain("127.0.0.1:7456:7456");
    // 入站免鉴权：带 token 的 Basic Auth 会锁死 iframe（真机实证 §195）
    expect(text).toContain('OD_DISABLE_API_AUTH: "1"');
    // 生命周期归宿主：restart 不得是 always（系统重启后先于主程序复活）
    expect(text).toContain("restart: unless-stopped");
  });

  it("伴随 origin 常量与 compose 发布地址同源（判定与资源不许两头各写一份）", () => {
    const port = new URL(OPEN_DESIGN_COMPANION_ORIGIN).port;
    const published = readFileSync(COMPOSE_FILE, "utf8").match(
      /"127\.0\.0\.1:(\d+):/,
    );
    expect(published?.[1]).toBe(port);
  });

  it("win/mac 打包脚本都捆绑 open-design/ 资源目录（与 dify 同段）", () => {
    for (const script of ["package-win.mjs", "package-mac.mjs"]) {
      const text = readFileSync(join(REPO_ROOT, "scripts", script), "utf8");
      expect(text, `${script} 缺少 open-design 资源捆绑`).toContain(
        'cpSync(join(ROOT, "open-design")',
      );
    }
  });
});
