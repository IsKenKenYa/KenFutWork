import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  moveDataLocation,
  restoreDataLocationPointer,
  runDataLocationCommand,
  validateDataLocationMove,
} from "./data-location.js";

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-data-location-")),
  );
  const source = join(root, "original");
  const target = join(root, "relocated");
  const pointerFile = join(root, "config", "data-location.json");
  await mkdir(source);
  for (const directory of [
    "postgres",
    "blobs",
    "local-access",
    "credentials",
    "plugins",
    "checkpoints",
    "sandbox",
  ]) {
    await mkdir(join(source, directory));
    await writeFile(join(source, directory, "owned"), `内容-${directory}`);
  }
  await mkdir(join(root, "config"));
  await writeFile(pointerFile, JSON.stringify({ dataDir: source }));
  return {
    root,
    source,
    target,
    pointerFile,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("整体数据目录移动", () => {
  it("停机复制全部应用状态、核验内容再切指针；保留原根和外部项目", async () => {
    const data = await fixture();
    try {
      const external = join(data.root, "external-project");
      await mkdir(external);
      await writeFile(join(external, "source.ts"), "外部源代码");
      await symlink(external, join(data.source, "sandbox", "external-link"));
      const result = await moveDataLocation(data);
      expect(result).toEqual({ dataDir: data.target, files: 7 });
      expect(JSON.parse(await readFile(data.pointerFile, "utf8"))).toEqual({
        dataDir: data.target,
      });
      for (const directory of await readdir(data.source)) {
        expect(
          await readFile(join(data.target, directory, "owned"), "utf8"),
        ).toBe(`内容-${directory}`);
        expect(
          await readFile(join(data.source, directory, "owned"), "utf8"),
        ).toBe(`内容-${directory}`);
      }
      expect(
        await readFile(
          join(data.target, "sandbox", "external-link", "source.ts"),
          "utf8",
        ),
      ).toBe("外部源代码");
      expect(await readFile(join(external, "source.ts"), "utf8")).toBe(
        "外部源代码",
      );
    } finally {
      await data.cleanup();
    }
  });

  it("目标非空拒绝合并；数据库尚未clean-stop拒绝任何复制", async () => {
    const data = await fixture();
    try {
      await mkdir(data.target);
      await writeFile(join(data.target, "important"), "保留");
      await expect(moveDataLocation(data)).rejects.toThrow("为空目录");
      expect(await readFile(join(data.target, "important"), "utf8")).toBe(
        "保留",
      );
      await rm(data.target, { recursive: true });
      await writeFile(join(data.source, "postgres", "postmaster.pid"), "123\n");
      await expect(moveDataLocation(data)).rejects.toThrow(
        "数据库尚未正常停止",
      );
      expect(JSON.parse(await readFile(data.pointerFile, "utf8")).dataDir).toBe(
        data.source,
      );
      expect(await readdir(data.root)).not.toContain("relocated");
    } finally {
      await data.cleanup();
    }
  });

  it("复制异常与校验损坏不改原指针，不留下半完成目标", async () => {
    const data = await fixture();
    try {
      await expect(
        moveDataLocation({
          ...data,
          copy: async () => {
            throw new Error("磁盘不可写");
          },
        }),
      ).rejects.toThrow("磁盘不可写");
      await expect(
        moveDataLocation({
          ...data,
          copy: async (source, target) => {
            await cp(source, target, { recursive: true });
            await writeFile(join(target, "blobs", "owned"), "损坏");
          },
        }),
      ).rejects.toThrow("复制校验失败");
      expect(JSON.parse(await readFile(data.pointerFile, "utf8")).dataDir).toBe(
        data.source,
      );
      expect(await readFile(join(data.source, "blobs", "owned"), "utf8")).toBe(
        "内容-blobs",
      );
      expect((await readdir(data.root)).sort()).toEqual(["config", "original"]);
    } finally {
      await data.cleanup();
    }
  });

  it("源在复制期间变化时拒绝发布，目标为空目录可以完整复制", async () => {
    const data = await fixture();
    try {
      await expect(
        moveDataLocation({
          ...data,
          copy: async (source, target) => {
            await cp(source, target, { recursive: true });
            await writeFile(join(source, "blobs", "owned"), "有人仍在写");
          },
        }),
      ).rejects.toThrow("复制校验失败");
      await mkdir(data.target);
      expect((await moveDataLocation(data)).dataDir).toBe(data.target);
      expect(await readFile(join(data.target, "blobs", "owned"), "utf8")).toBe(
        "有人仍在写",
      );
    } finally {
      await data.cleanup();
    }
  });

  it("拒绝互相包含、相同目录、指针卷入根及symlink绕回源目录", async () => {
    const data = await fixture();
    try {
      for (const target of [
        data.source,
        join(data.source, "nested"),
        data.root,
      ]) {
        await expect(
          validateDataLocationMove({ ...data, target }),
        ).rejects.toThrow();
      }
      await expect(
        validateDataLocationMove({
          ...data,
          pointerFile: join(data.target, "config.json"),
        }),
      ).rejects.toThrow("之外");
      await symlink(data.source, join(data.root, "alias"));
      await expect(
        validateDataLocationMove({
          ...data,
          target: join(data.root, "alias", "nested"),
        }),
      ).rejects.toThrow("符号链接");
    } finally {
      await data.cleanup();
    }
  });

  it("重启失败可恢复原指针，原来未配置指针时恢复默认；离线命令不启动应用", async () => {
    const data = await fixture();
    try {
      const previous = await readFile(data.pointerFile, "utf8");
      await moveDataLocation(data);
      await restoreDataLocationPointer(data.pointerFile, previous);
      expect(JSON.parse(await readFile(data.pointerFile, "utf8")).dataDir).toBe(
        data.source,
      );
      await restoreDataLocationPointer(data.pointerFile, null);
      expect(await runDataLocationCommand(["--unrelated"])).toBe(false);
      await expect(readFile(data.pointerFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await data.cleanup();
    }
  });
});
