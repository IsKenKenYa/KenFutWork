import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import { afterEach, describe, expect, it } from "vitest";
import { resolveReadOnlyProjectPath } from "../execution/scope-service.js";
import {
  CodeUiFileIndex,
  codeUiViewerRpc,
  type ViewerResolver,
} from "./files.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function world() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-human-preview-")),
  );
  temporary.push(root);
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-human-outside-")),
  );
  temporary.push(outside);
  const projectId = randomUUID();
  const viewerScope = { kind: "project" as const, projectId };
  const resolvePath: ViewerResolver = async (viewer, path) => {
    if (viewer.kind !== "project" || viewer.projectId !== projectId)
      throw new Error("身份不属于项目");
    return resolveReadOnlyProjectPath(
      { rootDirectory: root, additionalDirectories: [] },
      path,
    );
  };
  const fileIndex = new CodeUiFileIndex();
  const call = (method: string, value: Record<string, unknown>, limit = 1024) =>
    codeUiViewerRpc({
      method,
      value: { ...value, viewerScope },
      resolvePath,
      fileIndex,
      limits: {
        codeReadMaxBytes: limit,
        codeSearchMaxResults: 5,
        codeSearchMaxBytes: 1024,
      },
    });
  return { root, outside, viewerScope, resolvePath, call };
}
describe("人工viewer scope", () => {
  it("空文本、Unicode与bytes range精确读取，不给模型产生观察", async () => {
    const { root, call } = await world();
    const path = join(root, "unicode.txt");
    await writeFile(path, "你好 👋");
    await writeFile(join(root, "empty.txt"), "");
    expect(await call("readTextFile", { path })).toMatchObject({
      result: { content: "你好 👋", truncated: false, isBinary: false },
    });
    expect(
      await call("readTextFile", { path: join(root, "empty.txt") }),
    ).toMatchObject({ result: { content: "", bytesRead: 0, totalBytes: 0 } });
    const bytes = await call("readFileRange", { path, offset: 0, length: 3 });
    expect(bytes?.result).toMatchObject({
      encoding: "base64",
      data: Buffer.from("你").toString("base64"),
    });
  });
  it("读取有预算，二进制预览超限明确拒绝而不是静默丢bytes", async () => {
    const { root, call } = await world();
    const path = join(root, "file.txt");
    await writeFile(path, "abcdef");
    expect(await call("readTextFile", { path }, 3)).toMatchObject({
      result: { content: "abc", bytesRead: 3, totalBytes: 6, truncated: true },
    });
    await expect(call("readBinaryPreview", { path }, 3)).rejects.toThrow(
      "超过工作区字节预算",
    );
  });
  it("外路径/symlink逃逸/无明确viewer身份都拒绝", async () => {
    const { root, outside, call, resolvePath } = await world();
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "秘密");
    await symlink(secret, join(root, "escape.txt"));
    await expect(call("readTextFile", { path: secret })).rejects.toThrow(
      "不属于",
    );
    await expect(
      call("readTextFile", { path: join(root, "escape.txt") }),
    ).rejects.toThrow("不属于");
    await expect(
      codeUiViewerRpc({
        method: "readTextFile",
        value: { path: secret },
        resolvePath,
        limits: {
          codeReadMaxBytes: 1024,
          codeSearchMaxResults: 5,
          codeSearchMaxBytes: 1024,
        },
      }),
    ).rejects.toThrow();
  });
  it("读取期间权限撤销，字节不发布", async () => {
    const { root, viewerScope } = await world();
    const path = join(root, "file.txt");
    await writeFile(path, "data");
    let reads = 0;
    await expect(
      codeUiViewerRpc({
        method: "readTextFile",
        value: { path, viewerScope },
        resolvePath: async () => {
          if (++reads > 1) throw new Error("授权已撤销");
          return path;
        },
        limits: {
          codeReadMaxBytes: 1024,
          codeSearchMaxResults: 5,
          codeSearchMaxBytes: 1024,
        },
      }),
    ).rejects.toThrow("授权已撤销");
  });
  it("文件搜索递归并复用原始模糊匹配，不跟随symlink或读取.git", async () => {
    const { root, outside, call } = await world();
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "src", "deep-module.ts"), "data");
    await writeFile(join(root, ".git", "deep-secret"), "private");
    await writeFile(join(outside, "deep-secret"), "private");
    await symlink(outside, join(root, "outside"));
    expect(
      await call("searchWorkspaceFiles", { rootPath: root, query: "dmt" }),
    ).toMatchObject({
      // 原ZCode也对绝对路径打分，随机临时根可能匹配dmt；验证目标与边界，不假定只有一项。
      result: expect.arrayContaining([
        expect.objectContaining({
          name: "deep-module.ts",
          relativePath: "src/deep-module.ts",
        }),
      ]),
    });
    expect(
      await call("searchWorkspaceFiles", { rootPath: root, query: root }),
    ).toMatchObject({
      result: expect.arrayContaining([
        expect.objectContaining({
          name: "src",
          relativePath: "src",
          type: "directory",
        }),
        expect.objectContaining({
          name: "deep-module.ts",
          relativePath: "src/deep-module.ts",
        }),
      ]),
    });
    const secretSearch = (
      await call("searchWorkspaceFiles", { rootPath: root, query: "secret" })
    )?.result as Array<{ relativePath: string }>;
    expect(secretSearch.map((entry) => entry.relativePath)).not.toContain(
      ".git/deep-secret",
    );
    expect(secretSearch.map((entry) => entry.relativePath)).not.toContain(
      "outside/deep-secret",
    );
  });
  it("文件树Length/Range使用同一真实快照，转义文件名且刷新包含新增文件", async () => {
    const { root, call } = await world();
    await mkdir(join(root, "src"));
    const name = "tab\tline\nname.txt";
    await writeFile(join(root, "src", name), "data");
    const length = (await call("listWorkspaceFilesLength", { rootPath: root }))
      ?.result as number;
    await writeFile(join(root, "late.txt"), "late");
    const first = (
      await call("listWorkspaceFilesRange", {
        rootPath: root,
        offset: 0,
        length: 4,
      })
    )?.result as string;
    const second = (
      await call("listWorkspaceFilesRange", {
        rootPath: root,
        offset: 4,
        length: 4_000_000,
      })
    )?.result as string;
    expect((first + second).length).toBe(length);
    expect(
      unpackWorkspaceFileEntries(first + second, root).map(
        (entry) => entry.relativePath,
      ),
    ).toEqual(["src", `src/${name}`]);
    await call("listWorkspaceFilesLength", { rootPath: root });
    const refreshed = (
      await call("listWorkspaceFilesRange", {
        rootPath: root,
        offset: 0,
        length: 4_000_000,
      })
    )?.result as string;
    expect(
      unpackWorkspaceFileEntries(refreshed, root).map(
        (entry) => entry.relativePath,
      ),
    ).toContain("late.txt");
  });
  it("缓存文件树仍复验viewer授权，错身份/撤销/超预算不返回旧快照", async () => {
    const { root, viewerScope, call } = await world();
    await writeFile(join(root, "file.txt"), "data");
    await expect(
      call("listWorkspaceFilesRange", { rootPath: root, offset: 0, length: 5 }),
    ).rejects.toThrow("刷新");
    await call("listWorkspaceFilesLength", { rootPath: root });
    const fileIndex = new CodeUiFileIndex();
    fileIndex.capture(viewerScope, root, [
      {
        name: "file.txt",
        path: join(root, "file.txt"),
        relativePath: "file.txt",
        type: "file",
      },
    ]);
    await expect(
      codeUiViewerRpc({
        method: "listWorkspaceFilesRange",
        value: { rootPath: root, viewerScope, offset: 0, length: 5 },
        fileIndex,
        resolvePath: async (_viewer, path) => {
          if (path !== root) throw new Error("授权撤销");
          return path;
        },
        limits: {
          codeReadMaxBytes: 1024,
          codeSearchMaxResults: 5,
          codeSearchMaxBytes: 1024,
        },
      }),
    ).rejects.toThrow("授权撤销");
    for (let index = 0; index < 5; index++)
      await writeFile(join(root, `file-${index}.txt`), "data");
    await expect(
      call("listWorkspaceFilesLength", { rootPath: root }),
    ).rejects.toThrow("扫描预算");
  });
});
