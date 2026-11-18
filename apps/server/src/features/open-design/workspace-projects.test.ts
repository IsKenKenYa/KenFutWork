import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  openDesignWorkspaceProjectsPath,
  readOpenDesignWorkspaceProject,
  writeOpenDesignWorkspaceProject,
} from "./workspace-projects.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kfw-od-binding-"));
}

describe("OpenDesign 项目绑定", () => {
  it("按 workspaceKey 哈希落盘并可读回，不写原始目录", () => {
    const dataDir = tempDir();
    writeOpenDesignWorkspaceProject({
      dataDir,
      workspaceKey: "C:/Users/me/secret-project",
      project: { projectId: "p-1", name: "测试项目" },
    });
    expect(
      readOpenDesignWorkspaceProject({
        dataDir,
        workspaceKey: "C:/Users/me/secret-project",
      }),
    ).toMatchObject({ projectId: "p-1", name: "测试项目" });
    const raw = readFileSync(openDesignWorkspaceProjectsPath(dataDir), "utf8");
    expect(raw).not.toContain("secret-project");
    expect(raw).not.toContain("C:/Users/me");
  });

  it("文件损坏按「没有绑定」处理", () => {
    const dataDir = tempDir();
    const file = openDesignWorkspaceProjectsPath(dataDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{not-json", "utf8");
    expect(
      readOpenDesignWorkspaceProject({ dataDir, workspaceKey: "proj-1" }),
    ).toBeNull();
    writeOpenDesignWorkspaceProject({
      dataDir,
      workspaceKey: "proj-1",
      project: { projectId: "p-1", name: "设计" },
    });
    expect(
      readOpenDesignWorkspaceProject({ dataDir, workspaceKey: "proj-1" })
        ?.projectId,
    ).toBe("p-1");
  });

  it("只保留最近 200 条绑定", () => {
    const dataDir = tempDir();
    for (let index = 0; index < 205; index += 1)
      writeOpenDesignWorkspaceProject({
        dataDir,
        workspaceKey: `proj-${index}`,
        project: { projectId: `p-${index}`, name: `设计 ${index}` },
        now: new Date(2026, 0, 1, 0, 0, index),
      });
    expect(
      readOpenDesignWorkspaceProject({ dataDir, workspaceKey: "proj-0" }),
    ).toBeNull();
    expect(
      readOpenDesignWorkspaceProject({ dataDir, workspaceKey: "proj-204" })
        ?.projectId,
    ).toBe("p-204");
  });
});
