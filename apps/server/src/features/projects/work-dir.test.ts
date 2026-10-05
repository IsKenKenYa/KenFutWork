import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createProjectWorkDirLoader,
  isAbsoluteWorkDir,
  normalizeWorkDir,
  validateWorkDir,
} from "./work-dir.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kfw-workdir-"));
}

describe("isAbsoluteWorkDir（跨平台判定）", () => {
  it("接受 POSIX / Windows 盘符 / UNC 三种绝对路径", () => {
    expect(isAbsoluteWorkDir("/home/me/app")).toBe(true);
    expect(isAbsoluteWorkDir("D:/Desktop/test")).toBe(true);
    expect(isAbsoluteWorkDir("D:\\Desktop\\test")).toBe(true);
    expect(isAbsoluteWorkDir("\\\\server\\share\\dir")).toBe(true);
  });

  it("拒绝相对路径、空串与含 NUL 的路径", () => {
    expect(isAbsoluteWorkDir("test")).toBe(false);
    expect(isAbsoluteWorkDir("./test")).toBe(false);
    expect(isAbsoluteWorkDir("../test")).toBe(false);
    expect(isAbsoluteWorkDir("C:test")).toBe(false);
    expect(isAbsoluteWorkDir("   ")).toBe(false);
    expect(isAbsoluteWorkDir("/tmp/\0bad")).toBe(false);
  });
});

describe("validateWorkDir", () => {
  it("存在的目录通过，并归一化（盘符/分隔符/末尾分隔符）", () => {
    const dir = makeDir();
    const verdict = validateWorkDir(
      `${dir}${process.platform === "win32" ? "\\" : "/"}`,
    );
    expect(verdict).toEqual({ ok: true, path: realpathSync(dir) });
  });

  it("相对路径给出可读原因（提示填完整路径）", () => {
    const verdict = validateWorkDir("test");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("不是绝对路径");
  });

  it("空串被拒", () => {
    const verdict = validateWorkDir("   ");
    expect(verdict.ok).toBe(false);
  });

  it("不存在的目录给出可读原因（含路径本身）", () => {
    const missing = join(makeDir(), "not-there");
    const verdict = validateWorkDir(missing);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("目录不存在");
    expect(verdict.reason).toContain(resolve(missing));
  });

  it("目标是文件而不是目录时给出可读原因", () => {
    const file = join(makeDir(), "a.txt");
    writeFileSync(file, "x", "utf8");
    const verdict = validateWorkDir(file);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("不是目录");
  });

  it("归一化把 `..` 与重复分隔符收干净（同目录只有一种拼写）", () => {
    const dir = makeDir();
    mkdirSync(join(dir, "sub"));
    const messy = join(dir, "sub", "..", "sub");
    const verdict = validateWorkDir(messy);
    expect(verdict).toEqual({ ok: true, path: realpathSync(join(dir, "sub")) });
    expect(normalizeWorkDir(messy)).toBe(resolve(join(dir, "sub")));
  });
});

describe("createProjectWorkDirLoader（可信实例 → 画布项目绑定目录）", () => {
  it("目标实例由调用者传入，画布不能反推或替换归属", async () => {
    const loader = createProjectWorkDirLoader({
      projects: {
        findWorkDirByCanvas: async (instanceId, canvasId) =>
          instanceId === "instance-1" && canvasId === "c1"
            ? "/work/project"
            : null,
      },
    });
    expect(await loader("instance-1", "c1")).toBe("/work/project");
    expect(await loader("foreign", "c1")).toBeNull();
  });
  it("未绑定返回 null；存储故障如实传播", async () => {
    expect(
      await createProjectWorkDirLoader({
        projects: { findWorkDirByCanvas: async () => null },
      })("instance-1", "c1"),
    ).toBeNull();
    const failure = new Error("db down");
    await expect(
      createProjectWorkDirLoader({
        projects: {
          findWorkDirByCanvas: async () => {
            throw failure;
          },
        },
      })("instance-1", "c1"),
    ).rejects.toBe(failure);
  });
});
