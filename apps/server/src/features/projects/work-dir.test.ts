import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    expect(verdict).toEqual({ ok: true, path: resolve(dir) });
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
    expect(verdict).toEqual({ ok: true, path: resolve(join(dir, "sub")) });
    expect(normalizeWorkDir(messy)).toBe(resolve(join(dir, "sub")));
  });
});

describe("createProjectWorkDirLoader（画布 → 项目绑定目录）", () => {
  it("画布所属项目绑定了目录时返回该目录", async () => {
    const loader = createProjectWorkDirLoader({
      canvases: { findWorkspaceIdByCanvas: async () => "ws-1" },
      projects: {
        findWorkDirByCanvas: async (workspaceId, canvasId) =>
          workspaceId === "ws-1" && canvasId === "c1" ? "D:/work" : null,
      },
    });
    await expect(loader("c1")).resolves.toBe("D:/work");
  });

  it("画布不属于任何工作区、或未绑定，都返回 null（绑定是增强不是前置条件）", async () => {
    const noWorkspace = createProjectWorkDirLoader({
      canvases: { findWorkspaceIdByCanvas: async () => null },
      projects: { findWorkDirByCanvas: async () => "D:/work" },
    });
    await expect(noWorkspace("c1")).resolves.toBeNull();

    const unbound = createProjectWorkDirLoader({
      canvases: { findWorkspaceIdByCanvas: async () => "ws-1" },
      projects: { findWorkDirByCanvas: async () => null },
    });
    await expect(unbound("c1")).resolves.toBeNull();
  });

  it("数据访问抛错时不冒泡（整轮 run 不该因为读绑定目录失败而失败）", async () => {
    const loader = createProjectWorkDirLoader({
      canvases: {
        findWorkspaceIdByCanvas: async () => {
          throw new Error("db down");
        },
      },
      projects: {
        findWorkDirByCanvas: async () => {
          throw new Error("db down");
        },
      },
    });
    await expect(loader("c1")).resolves.toBeNull();

    const secondLoader = createProjectWorkDirLoader({
      canvases: { findWorkspaceIdByCanvas: async () => "ws-1" },
      projects: {
        findWorkDirByCanvas: async () => {
          throw new Error("db down");
        },
      },
    });
    await expect(secondLoader("c1")).resolves.toBeNull();
  });
});
