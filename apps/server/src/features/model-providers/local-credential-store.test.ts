import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalCredentialStore } from "./local-credential-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return { ...filesystem, rename: vi.fn(filesystem.rename) };
});

const directories: string[] = [];

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kenfutwork-byok-"));
  directories.push(directory);
  return directory;
}

function credentialPath(dataDir: string): string {
  return join(dataDir, "credentials", "byok.json");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.mocked(rename).mockReset();
  const filesystem =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rename).mockImplementation(filesystem.rename);
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("LocalCredentialStore（DEC-7 本地明文凭据）", () => {
  it("缺失文件为空，明文文件仅保存 Key，重新创建存取对象后可读取", async () => {
    const dataDir = await makeDirectory();
    const store = createLocalCredentialStore(dataDir);
    expect(await store.get("provider-a")).toBeNull();
    await store.set("provider-a", "sk-local-plaintext");

    const contents = await readFile(credentialPath(dataDir), "utf8");
    expect(JSON.parse(contents)).toEqual({
      "provider-a": "sk-local-plaintext",
    });
    expect(await createLocalCredentialStore(dataDir).get("provider-a")).toBe(
      "sk-local-plaintext",
    );
    if (process.platform !== "win32") {
      expect((await stat(credentialPath(dataDir))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dataDir, "credentials"))).mode & 0o777).toBe(
        0o700,
      );
    }
  });

  it("空字符串保留为空字符串，只有 null 清除，清除不影响其他 Key", async () => {
    const dataDir = await makeDirectory();
    const store = createLocalCredentialStore(dataDir);
    await store.set("empty", "");
    await store.set("other", "other-key");
    expect(await store.get("empty")).toBe("");
    await store.set("empty", null);
    expect(await store.get("empty")).toBeNull();
    expect(await store.get("other")).toBe("other-key");
    expect(JSON.parse(await readFile(credentialPath(dataDir), "utf8"))).toEqual(
      {
        other: "other-key",
      },
    );
  });

  it("特殊属性名按 own-key 读写，不把原型属性当作凭据", async () => {
    const store = createLocalCredentialStore(await makeDirectory());
    expect(await store.get("constructor")).toBeNull();
    expect(await store.get("toString")).toBeNull();
    await store.set("__proto__", "prototype-key");
    await store.set("constructor", "constructor-key");
    expect(await store.get("__proto__")).toBe("prototype-key");
    expect(await store.get("constructor")).toBe("constructor-key");
    await store.set("__proto__", null);
    expect(await store.get("__proto__")).toBeNull();
    expect(await store.get("constructor")).toBe("constructor-key");
  });

  it("不同及相同 Key 的并发写入共用串行门，读取等待提交完成", async () => {
    const dataDir = await makeDirectory();
    const store = createLocalCredentialStore(dataDir);
    const anotherStore = createLocalCredentialStore(dataDir);
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    const first = store.change("same", "first", async () => {
      order.push("first-enter");
      entered.resolve();
      await release.promise;
      order.push("first-commit");
      return "first-result";
    });
    await entered.promise;
    const different = anotherStore.change(
      "different",
      "different-key",
      async () => {
        order.push("different-commit");
      },
    );
    const same = store.change("same", "last", async () => {
      order.push("same-commit");
    });
    const read = anotherStore.get("same");
    expect(order).toEqual(["first-enter"]);
    release.resolve();
    expect(await first).toBe("first-result");
    await Promise.all([different, same]);
    expect(await read).toBe("last");
    expect(await store.get("different")).toBe("different-key");
    expect(order).toEqual([
      "first-enter",
      "first-commit",
      "different-commit",
      "same-commit",
    ]);
  });

  it("提交失败精确恢复旧文件原文，返回原提交错误", async () => {
    const dataDir = await makeDirectory();
    await mkdir(join(dataDir, "credentials"));
    const previous = '{"old":"old-key", "other":"other-key"}\n';
    await writeFile(credentialPath(dataDir), previous);
    const store = createLocalCredentialStore(dataDir);
    const conflict = new Error("数据库 CAS 冲突");
    await expect(
      store.change("old", "new-key", async () => {
        expect(
          JSON.parse(await readFile(credentialPath(dataDir), "utf8")),
        ).toEqual({
          old: "new-key",
          other: "other-key",
        });
        throw conflict;
      }),
    ).rejects.toBe(conflict);
    expect(await readFile(credentialPath(dataDir), "utf8")).toBe(previous);
    expect(await store.get("old")).toBe("old-key");
  });

  it("新文件提交失败恢复文件不存在，失败回滚不覆盖排队的后续写入", async () => {
    const dataDir = await makeDirectory();
    const store = createLocalCredentialStore(dataDir);
    const entered = deferred();
    const release = deferred();
    const conflict = new Error("数据库 CAS 冲突");
    const failing = store.change("same", "uncommitted", async () => {
      entered.resolve();
      await release.promise;
      throw conflict;
    });
    const rejected = expect(failing).rejects.toBe(conflict);
    await entered.promise;
    const succeeding = store.change("same", "committed", async () => {
      expect(
        JSON.parse(await readFile(credentialPath(dataDir), "utf8")),
      ).toEqual({
        same: "committed",
      });
    });
    release.resolve();
    await rejected;
    await succeeding;
    expect(await store.get("same")).toBe("committed");

    const emptyDataDir = await makeDirectory();
    await expect(
      createLocalCredentialStore(emptyDataDir).change(
        "new",
        "key",
        async () => {
          throw conflict;
        },
      ),
    ).rejects.toBe(conflict);
    await expect(
      readFile(credentialPath(emptyDataDir), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["malformed", '{"provider":"sensitive-key"'],
    ["array", '["sensitive-key"]'],
    ["null", "null"],
    ["number", '{"provider":123}'],
    ["nested", '{"__proto__":{"key":"sensitive-key"}}'],
  ])(
    "损坏文件 %s 明确拒绝并保持文件原文，错误不携带 Key",
    async (_name, contents) => {
      const dataDir = await makeDirectory();
      await mkdir(join(dataDir, "credentials"));
      await writeFile(credentialPath(dataDir), contents);
      const store = createLocalCredentialStore(dataDir);
      const commit = vi.fn(async () => undefined);
      await expect(store.get("provider")).rejects.toThrow(/本地凭据/);
      await expect(
        store.change("provider", "replacement", commit),
      ).rejects.toThrow(/本地凭据/);
      expect(commit).not.toHaveBeenCalled();
      expect(await readFile(credentialPath(dataDir), "utf8")).toBe(contents);
      try {
        await store.get("provider");
      } catch (error) {
        expect(String(error)).not.toContain("sensitive-key");
      }
    },
  );

  it("磁盘拒绝发布新文件时不执行提交，旧 Key 和文件保持可读", async () => {
    const dataDir = await makeDirectory();
    const store = createLocalCredentialStore(dataDir);
    await store.set("provider", "old-key");
    const previous = await readFile(credentialPath(dataDir), "utf8");
    const diskError = Object.assign(new Error("磁盘拒绝写入"), {
      code: "EACCES",
    });
    // 真实文件系统负责其余 I/O；只在最终原子发布点注入磁盘拒绝。
    vi.mocked(rename).mockRejectedValueOnce(diskError);
    const commit = vi.fn(async () => undefined);
    await expect(store.change("provider", "new-key", commit)).rejects.toBe(
      diskError,
    );
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(credentialPath(dataDir), "utf8")).toBe(previous);
    expect(await store.get("provider")).toBe("old-key");
    expect(await readdir(join(dataDir, "credentials"))).toEqual(["byok.json"]);
  });

  it("磁盘读取故障不会伪装成空凭据", async () => {
    const dataDir = await makeDirectory();
    await writeFile(join(dataDir, "credentials"), "not-a-directory");
    const store = createLocalCredentialStore(dataDir);
    await expect(store.get("provider")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    await expect(store.set("provider", "key")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    expect(await readFile(join(dataDir, "credentials"), "utf8")).toBe(
      "not-a-directory",
    );
  });

  it("提交失败且磁盘拒绝回滚时明确报告两个故障", async () => {
    const dataDir = await makeDirectory();
    const store = createLocalCredentialStore(dataDir);
    await store.set("provider", "old-key");
    const conflict = new Error("数据库 CAS 冲突");
    const diskError = Object.assign(new Error("磁盘拒绝恢复"), {
      code: "EACCES",
    });
    const failure = store.change("provider", "new-key", async () => {
      vi.mocked(rename).mockRejectedValueOnce(diskError);
      throw conflict;
    });
    await expect(failure).rejects.toMatchObject({
      name: "AggregateError",
      errors: [conflict, diskError],
    });
    expect(await store.get("provider")).toBe("new-key");
  });

  it("目录备份复制后可读取，已有对象随后读取文件最新值", async () => {
    const sourceDir = await makeDirectory();
    const restoredDir = await makeDirectory();
    const source = createLocalCredentialStore(sourceDir);
    await source.set("provider", "backup-key");
    await cp(join(sourceDir, "credentials"), join(restoredDir, "credentials"), {
      recursive: true,
    });
    const restored = createLocalCredentialStore(restoredDir);
    expect(await restored.get("provider")).toBe("backup-key");
    await writeFile(
      credentialPath(restoredDir),
      '{"provider":"restored-latest"}\n',
    );
    expect(await restored.get("provider")).toBe("restored-latest");
    expect(await source.get("provider")).toBe("backup-key");
  });
});
