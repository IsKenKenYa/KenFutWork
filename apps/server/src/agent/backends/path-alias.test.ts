import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FilesystemBackend } from "deepagents";
import { afterEach, describe, expect, it, vi } from "vitest";

import { aliasWorkDirPath, withWorkDirAlias } from "./path-alias.js";

/**
 * 真实绝对路径 → 虚拟根路径的别名层。
 *
 * 回归背景（2026-09-20 用户实测）：prod 沙箱 `virtualMode: true` 把根外绝对路径
 * **静默吞成空结果**——模型拿着用户提到的 `/Volumes/…/kimi-code` 去 ls，得到
 * 「No files found」，回复用户「目录是空的」。别名层让真实路径直达虚拟根。
 */

describe("aliasWorkDirPath（纯函数）", () => {
  const prefixes = ["/Volumes/X/kimi-code"];

  it("目录本身 → /，子路径 → /子路径", () => {
    expect(aliasWorkDirPath("/Volumes/X/kimi-code", prefixes)).toBe("/");
    expect(aliasWorkDirPath("/Volumes/X/kimi-code/packages/ui", prefixes)).toBe(
      "/packages/ui",
    );
  });

  it("前缀部分重合但不完整（兄弟目录）不改写", () => {
    expect(aliasWorkDirPath("/Volumes/X/kimi-code-v2/a", prefixes)).toBe(
      "/Volumes/X/kimi-code-v2/a",
    );
  });

  it("无关路径与相对路径原样透传", () => {
    expect(aliasWorkDirPath("/workspace/src", prefixes)).toBe("/workspace/src");
    expect(aliasWorkDirPath("src/index.ts", prefixes)).toBe("src/index.ts");
  });

  it("可选 path 的 null / undefined 原样透传", () => {
    expect(aliasWorkDirPath(null, prefixes)).toBeNull();
    expect(aliasWorkDirPath(undefined, prefixes)).toBeUndefined();
  });

  it("前缀末尾带分隔符也命中；Windows 反斜杠路径也认", () => {
    expect(
      aliasWorkDirPath("/Volumes/X/kimi-code/a", ["/Volumes/X/kimi-code/"]),
    ).toBe("/a");
    expect(
      aliasWorkDirPath("C:\\work\\proj\\src\\a.ts", ["C:\\work\\proj"]),
    ).toBe("/src/a.ts");
  });
});

describe("withWorkDirAlias（代理委托）", () => {
  it("只改写路径参数，其余参数与其余方法原样透传", () => {
    const calls: Array<{ prop: string; args: unknown[] }> = [];
    const target = {
      id: "stub-backend",
      ls: (path: string) => {
        calls.push({ prop: "ls", args: [path] });
        return { files: [{ path: "/a.txt", is_dir: false, size: 1 }] };
      },
      grep: (pattern: string, path?: string | null) => {
        calls.push({ prop: "grep", args: [pattern, path] });
        return { matches: [] };
      },
      glob: (pattern: string, path?: string) => {
        calls.push({ prop: "glob", args: [pattern, path] });
        return { files: [] };
      },
      execute: (command: string) => {
        calls.push({ prop: "execute", args: [command] });
        return { output: "", exitCode: 0, truncated: false };
      },
    };
    const wrapped = withWorkDirAlias(target, ["/real/dir"]);

    expect(wrapped.id).toBe("stub-backend");
    wrapped.ls("/real/dir/sub");
    wrapped.grep("pat", "/real/dir");
    wrapped.glob("*.ts");
    // execute 携带真实路径的命令串必须原样透传（shell 跑在真实文件系统上）
    wrapped.execute("cat /real/dir/a.txt");

    expect(calls.map((call) => call.prop)).toEqual([
      "ls",
      "grep",
      "glob",
      "execute",
    ]);
    expect(calls[0]?.args).toEqual(["/sub"]);
    expect(calls[1]?.args).toEqual(["pat", "/"]);
    expect(calls[2]?.args).toEqual(["*.ts", undefined]);
    expect(calls[3]?.args).toEqual(["cat /real/dir/a.txt"]);
  });

  it("类 getter 不落在 Proxy 上（私有字段访问不炸）", () => {
    class Inner {
      #hidden = "secret";
      get secret(): string {
        return this.#hidden;
      }
    }
    const wrapped = withWorkDirAlias(new Inner(), ["/real/dir"]);
    expect(wrapped.secret).toBe("secret");
  });
});

/** 真实 virtualMode 后端：锁死「未包→空列表、包上→命中」这一对行为。 */
describe("withWorkDirAlias × FilesystemBackend（virtualMode）", () => {
  const dirs: string[] = [];

  function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "kfw-alias-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.txt"), "hello");
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it("别名让 ls/read 的真实绝对路径命中绑定目录", async () => {
    const root = makeRoot();
    const realRoot = resolve(root);
    const backend = withWorkDirAlias(
      new FilesystemBackend({ rootDir: realRoot, virtualMode: true }),
      [realRoot],
    );

    // 未包时这是空列表（bug 本体）；包上后必须拿到文件
    const listed = await backend.ls(`${realRoot}`);
    expect(listed.files?.map((info) => info.path)).toContain("/a.txt");

    const read = await backend.read(`${realRoot}/a.txt`);
    expect(JSON.stringify(read)).toContain("hello");
  });

  it("未加别名层的同一个后端：绝对路径静默空列表（bug 本体，锁死不回归）", async () => {
    const root = makeRoot();
    const realRoot = resolve(root);
    const bare = new FilesystemBackend({
      rootDir: realRoot,
      virtualMode: true,
    });

    vi.stubGlobal("console", console);
    const listed = await bare.ls(`${realRoot}`);
    expect(listed.files).toEqual([]);
  });
});
