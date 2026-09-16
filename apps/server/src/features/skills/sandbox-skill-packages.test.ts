import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  listSandboxSkillPackages,
  readSandboxSkillPackage,
  resolveInsideRoot,
} from "./sandbox-skill-packages.js";

const roots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "kfw-sandbox-skill-"));
  roots.push(dir);
  return dir;
}

function writeFile(root: string, relative: string, content: string): void {
  const absolute = join(root, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

const SKILL_MD = (name: string, description = "") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n步骤…\n`;

afterEach(() => {
  roots.length = 0;
});

describe("工作目录里的技能包扫描（从工作目录导入）", () => {
  it("扫出含 SKILL.md 的目录，并解析出 name/description", () => {
    const root = makeRoot();
    writeFile(root, "en-zh-translate/SKILL.md", SKILL_MD("en-zh-translate", "英译中"));
    writeFile(root, "en-zh-translate/glossary.md", "# 术语表");
    writeFile(root, "普通目录/notes.md", "不是技能包");

    const packages = listSandboxSkillPackages(root);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      path: "en-zh-translate",
      name: "en-zh-translate",
      description: "英译中",
    });
  });

  it("跳过依赖/版本库/隐藏目录，也不把技能包内部文件当嵌套技能", () => {
    const root = makeRoot();
    writeFile(root, "node_modules/evil/SKILL.md", SKILL_MD("evil"));
    writeFile(root, ".hidden/SKILL.md", SKILL_MD("hidden"));
    writeFile(root, "pkg/SKILL.md", SKILL_MD("pkg"));
    writeFile(root, "pkg/references/example/SKILL.md", SKILL_MD("example"));

    const packages = listSandboxSkillPackages(root);
    expect(packages.map((p) => p.path)).toEqual(["pkg"]);
  });

  it("frontmatter 损坏的目录仍列为候选（导入时再严格校验）", () => {
    const root = makeRoot();
    writeFile(root, "broken/SKILL.md", "没有 frontmatter");

    const [first] = listSandboxSkillPackages(root);
    expect(first?.path).toBe("broken");
    expect(first?.name).toBe("broken");
    expect(first?.description).toBe("");
  });

  it("读技能包：返回 SKILL.md 与子目录文件，路径相对包根", () => {
    const root = makeRoot();
    writeFile(root, "pkg/SKILL.md", SKILL_MD("pkg"));
    writeFile(root, "pkg/scripts/run.py", "print('hi')");

    const files = readSandboxSkillPackage(root, "pkg");
    expect(files.map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "scripts/run.py",
    ]);
  });

  it("路径越界（../）被拒；合法子目录可读", () => {
    const root = makeRoot();
    writeFile(root, "inside/SKILL.md", SKILL_MD("inside"));

    expect(() => resolveInsideRoot(root, "../../etc")).toThrow("越出工作目录");
    expect(() => readSandboxSkillPackage(root, "../..")).toThrow();
    expect(readSandboxSkillPackage(root, "inside")).toHaveLength(1);
  });

  it("目录里没有 SKILL.md 时报错", () => {
    const root = makeRoot();
    writeFile(root, "plain/readme.md", "hello");

    expect(() => readSandboxSkillPackage(root, "plain")).toThrow("没有 SKILL.md");
  });
});
