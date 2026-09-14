import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveEntryRoot } from "./entry-root.js";

const REPO = resolve("D:/repo");
const SERVER_SRC = join(REPO, "apps", "server", "src", "server.ts");
const SERVER_DIST = join(REPO, "apps", "server", "dist", "server.js");

describe("入口资源根解析", () => {
  it("源码态：<仓库根>/apps/server/{src,dist}/server.js 上四级到仓库根", () => {
    expect(
      resolveEntryRoot({
        entryFileUrl: pathToFileURL(SERVER_SRC).href,
        execPath: process.execPath,
      }),
    ).toBe(REPO);
    expect(
      resolveEntryRoot({
        entryFileUrl: pathToFileURL(SERVER_DIST).href,
        execPath: process.execPath,
      }),
    ).toBe(REPO);
  });

  /**
   * 回归：曾经上三级得到 `apps/`，沙箱因此落到 `<仓库根>/apps/tmp/sandbox`、
   * 随包运行时去 `apps/runtime`（真实位置在仓库根）——两条路径都静默错位。
   */
  it("回归：结果必须是仓库根，不是 apps/ 这一层", () => {
    const root = resolveEntryRoot({
      entryFileUrl: pathToFileURL(SERVER_SRC).href,
      execPath: process.execPath,
    });
    expect(root).toBe(REPO);
    expect(root).not.toBe(dirname(dirname(REPO)));
    expect(root).toBe(dirname(dirname(dirname(dirname(SERVER_SRC)))));
  });

  it("打包态（SEA 下 import.meta.url 为空）回退到 exe 目录", () => {
    expect(
      resolveEntryRoot({
        entryFileUrl: undefined,
        execPath: join(REPO, "release", "KenFutWorkServer.exe"),
      }),
    ).toBe(join(REPO, "release"));
  });

  it("非法 file URL 同样回退到 exe 目录", () => {
    expect(
      resolveEntryRoot({
        entryFileUrl: "not-a-file-url",
        execPath: join(REPO, "app", "server.exe"),
      }),
    ).toBe(join(REPO, "app"));
  });
});
