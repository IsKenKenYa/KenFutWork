import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManagedRootRebinder } from "./root-binding.js";
import { createLocalInstanceService } from "./service.js";

describe("应用数据根路径重绑定", () => {
  let temporary: string;
  let previous: string;
  let current: string;
  beforeEach(async () => {
    temporary = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-root-binding-")),
    );
    previous = join(temporary, "old");
    current = join(temporary, "new");
    await Promise.all([
      mkdir(previous, { recursive: true }),
      mkdir(current, { recursive: true }),
    ]);
  });
  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  it("只移动真实托管子树，外部授权目录和相似前缀保持原路径", async () => {
    const mapper = await createManagedRootRebinder(previous, current);
    for (const tree of [
      "sandbox",
      "checkpoints",
      "blobs",
      "plugins",
      "execution-output",
      "index",
      "browser",
    ])
      expect(await mapper.rewritePath(join(previous, tree, "文件"))).toBe(
        join(current, tree, "文件"),
      );
    for (const path of [
      previous,
      join(previous, "sandbox-extra", "文件"),
      join(previous, "sandboxes", "文件"),
      join(previous, "logs", "文件"),
      join(`${previous}-other`, "sandbox", "文件"),
      join(temporary, "external-code", "文件"),
      "sandbox/relative.txt",
    ])
      expect(await mapper.rewritePath(path)).toBe(path);
  });

  it("旧根删除后的文件夹恢复仍使用旧账本根与物理祖先映射", async () => {
    await mkdir(join(previous, "sandbox", "task"), { recursive: true });
    await cp(previous, current, { recursive: true });
    await rm(previous, { recursive: true });
    const mapper = await createManagedRootRebinder(previous, current);
    expect(
      await mapper.rewritePath(join(previous, "sandbox", "task", "absent")),
    ).toBe(join(current, "sandbox", "task", "absent"));
  });

  it("根目录别名被规范化，旧托管树中指向外部的软链不被纳入应用数据", async () => {
    const alias = join(temporary, "alias");
    const external = join(temporary, "external");
    await Promise.all([mkdir(join(previous, "sandbox")), mkdir(external)]);
    await symlink(previous, alias, "dir");
    await symlink(external, join(previous, "sandbox", "external"), "dir");
    const mapper = await createManagedRootRebinder(alias, current);
    expect(await mapper.rewritePath(join(alias, "sandbox", "task"))).toBe(
      join(current, "sandbox", "task"),
    );
    const escaped = join(alias, "sandbox", "external", "file");
    expect(await mapper.rewritePath(escaped)).toBe(escaped);
    expect(mapper.previous).toBe(previous);
  });

  it("复制目的地的越界软链使启动失败，不能悄悄授权外部目录", async () => {
    const external = join(temporary, "external");
    await Promise.all([
      mkdir(join(previous, "sandbox", "task"), { recursive: true }),
      mkdir(join(current, "sandbox")),
      mkdir(external),
    ]);
    await symlink(external, join(current, "sandbox", "task"), "dir");
    const mapper = await createManagedRootRebinder(previous, current);
    await expect(
      mapper.rewritePath(join(previous, "sandbox", "task", "file")),
    ).rejects.toThrow("越界软链");
  });

  it("重写明确路径、原wire目录身份和偏好字典键，保留任意消息与代际", async () => {
    const path = join(previous, "sandbox", "task");
    const next = join(current, "sandbox", "task");
    const identity = JSON.stringify(["project-id", path]);
    const nextIdentity = JSON.stringify(["project-id", next]);
    const text = `历史消息提到 ${path}`;
    const mapper = await createManagedRootRebinder(previous, current);
    expect(
      await mapper.rewriteJson({
        path,
        workspaceId: path,
        workspaceIdentity: identity,
        workspaceKey: "unqualified-id",
        additionalDirectories: [{ path, access: "read-only" }],
        preferences: { [identity]: { cwd: path }, [path]: { pinned: true } },
        text,
        opaque: identity,
        generation: 7,
        branchGeneration: 9,
        attachment: { objectPath: "relative/blob.png" },
      }),
    ).toEqual({
      path: next,
      workspaceId: next,
      workspaceIdentity: nextIdentity,
      workspaceKey: "unqualified-id",
      additionalDirectories: [{ path: next, access: "read-only" }],
      preferences: {
        [nextIdentity]: { cwd: next },
        [next]: { pinned: true },
      },
      text,
      opaque: identity,
      generation: 7,
      branchGeneration: 9,
      attachment: { objectPath: "relative/blob.png" },
    });
    await expect(
      mapper.rewriteJson({ workspaceIdentity: "[invalid" }),
    ).resolves.toEqual({ workspaceIdentity: "[invalid" });
  });

  it("拒绝非绝对数据根", async () => {
    await expect(
      createManagedRootRebinder("relative", current),
    ).rejects.toThrow("绝对路径");
  });
});

describe("启动期根绑定屏障", () => {
  const instanceId = "6f9e0aa8-eef5-4d83-979e-72393bdecb3b";
  it("所有客户端等待同一个根绑定完成，访问身份不改变实例归属", async () => {
    let enter!: () => void;
    let finish!: (path: string) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const result = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const ensure = vi.fn(async () => instanceId);
    const bindRoot = vi.fn(async () => {
      enter();
      return result;
    });
    const instance = createLocalInstanceService({
      repository: { ensure },
      dataDir: "/tmp/new-data",
      bindRoot,
    });
    let exposed = false;
    const desktop = instance
      .resolve({ instanceId, accessClientId: "desktop-client" })
      .then((context) => {
        exposed = true;
        return context;
      });
    const browser = instance.resolve({
      instanceId,
      accessClientId: "browser-client",
    });
    await entered;
    expect(exposed).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(bindRoot).toHaveBeenCalledExactlyOnceWith(
      instanceId,
      "/tmp/new-data",
    );
    finish("/physical/new-data");
    const context = await desktop;
    expect(await browser).toBe(context);
    expect(context).toEqual({ instanceId, dataDir: "/physical/new-data" });
    expect(await instance.serviceActor()).toEqual({
      instanceId,
      accessClientId: null,
    });
  });

  it("绑定失败原样透出并重置初始化，下一次调用可重试", async () => {
    const failure = new Error("检查点影子仓库未复制完整");
    const bindRoot = vi
      .fn<(id: string, path: string) => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue("/physical/new-data");
    const instance = createLocalInstanceService({
      repository: { ensure: async () => instanceId },
      dataDir: "/tmp/new-data",
      bindRoot,
    });
    await expect(instance.getContext()).rejects.toBe(failure);
    await expect(instance.getContext()).resolves.toEqual({
      instanceId,
      dataDir: "/physical/new-data",
    });
    expect(bindRoot).toHaveBeenCalledTimes(2);
  });
});
