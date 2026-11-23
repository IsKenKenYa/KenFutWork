import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveExecutable } from "./resolve-executable.js";

/**
 * 解析可执行文件绝对路径。
 *
 * 回归锁定（用户口径 2026-11-23「这个弹不出 Windows 原生的文件夹选择器了」）：
 * 名字**自带扩展名**时不能再追加 PATHEXT。`powershell.exe` 曾被拼成
 * `powershell.exe.EXE`，那个文件永远不存在 → 返回 null → 调用方退回裸命令名
 * 交给 spawn；PATH 不可靠时对话框根本不弹（实测本机 powershell.exe 存在、
 * 解析却返回 null）。
 */

const tempDir = mkdtempSync(join(tmpdir(), "resolve-exec-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

it("名字已带扩展名时不再追加 PATHEXT", () => {
  const exe = join(tempDir, "powershell.exe");
  writeFileSync(exe, "");
  expect(
    resolveExecutable(["powershell.exe"], [tempDir], {
      path: "",
      pathExt: ".EXE;.CMD;.BAT",
      platform: "win32",
    }),
  ).toBe(exe);
});

it("名字不带扩展名时按 PATHEXT 逐个试", () => {
  const exe = join(tempDir, "zenity.EXE");
  writeFileSync(exe, "");
  expect(
    resolveExecutable(["zenity"], [tempDir], {
      path: "",
      pathExt: ".EXE;.CMD;.BAT",
      platform: "win32",
    }),
  ).toBe(exe);
});

it("带路径分隔符的常量只验存在性", () => {
  const exe = join(tempDir, "osascript");
  writeFileSync(exe, "");
  expect(
    resolveExecutable([exe], [], { path: "", pathExt: "", platform: "darwin" }),
  ).toBe(exe);
  expect(
    resolveExecutable([join(tempDir, "missing")], [], {
      path: "",
      pathExt: "",
      platform: "darwin",
    }),
  ).toBeNull();
});

it("找不到时返回 null，不返回裸名", () => {
  expect(
    resolveExecutable(["definitely-not-here"], [tempDir], {
      path: "",
      pathExt: ".EXE",
      platform: "win32",
    }),
  ).toBeNull();
});
