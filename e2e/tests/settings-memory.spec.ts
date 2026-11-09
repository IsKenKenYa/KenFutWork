import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { dataDir, openWorkbench, serverApi } from "../support/local-access";
import { openSettingsSection } from "../support/settings";

const projectName = `e2e 记忆项目 ${Date.now()}`;
let projectId = "";

test.describe("记忆开关、目录与文件读取", () => {
  test.beforeAll(async () => {
    const response = await serverApi("POST", "/api/projects", {
      name: projectName,
      kind: "code",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    projectId = body.project.id;

    const memoryRoot = path.join(
      dataDir,
      "memories",
      "projects",
      projectId,
      "memory",
    );
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(
      path.join(memoryRoot, "MEMORY.md"),
      `# 记忆索引\n\n- [项目约定](topic.md) — e2e 种子\n`,
      "utf8",
    );
    await writeFile(
      path.join(memoryRoot, "topic.md"),
      "# 项目约定\n\n本仓库使用 pnpm workspace。\n",
      "utf8",
    );
  });

  test.beforeEach(async ({ page }) => {
    await openWorkbench(page);
  });

  test("画布项目记忆按项目列出并可通过服务端读取正文", async ({ page }) => {
    const management = await openSettingsSection(page, "记忆");
    const toggle = management.locator('[data-testid="settings-memory-switch"]');
    if (!(await toggle.isChecked())) {
      await Promise.all([
        page.waitForResponse((response) =>
          response.url().includes("/api/code-ui/rpc"),
        ),
        toggle.click(),
      ]);
    }
    await expect(toggle).toBeChecked();

    const scopeTrigger = management.locator(
      '[data-testid="settings-memory-scope-trigger"]',
    );
    await expect(scopeTrigger).toBeVisible();
    await expect(
      management.locator('[data-testid="settings-memory-file-MEMORY.md"]'),
    ).toBeVisible();
    await expect(
      management.locator('[data-testid="settings-memory-file-topic.md"]'),
    ).toBeVisible();

    const listed = await page.request.post("/api/code-ui/rpc", {
      data: { service: "memory", method: "listProjectMemories", args: [] },
    });
    expect(listed.status()).toBe(200);
    const listBody = await listed.json();
    const summary = listBody.result.find(
      (item: { id: string }) => item.id === projectId,
    );
    expect(summary.files.map((file: { name: string }) => file.name)).toEqual(
      expect.arrayContaining(["MEMORY.md", "topic.md"]),
    );

    const read = await page.request.post("/api/code-ui/rpc", {
      data: {
        service: "memory",
        method: "readProjectMemoryFile",
        args: [{ workspaceId: projectId, fileName: "topic.md" }],
      },
    });
    expect(read.status()).toBe(200);
    const readBody = await read.json();
    expect(readBody.result.content).toContain("本仓库使用 pnpm workspace。");
  });

  test("越权读取项目记忆被拒绝", async ({ page }) => {
    const traversal = await page.request.post("/api/code-ui/rpc", {
      data: {
        service: "memory",
        method: "readProjectMemoryFile",
        args: [{ workspaceId: projectId, fileName: "../MEMORY.md" }],
      },
    });
    expect(traversal.ok()).toBe(false);

    const unknownProject = await page.request.post("/api/code-ui/rpc", {
      data: {
        service: "memory",
        method: "readProjectMemoryFile",
        args: [{ workspaceId: "not-a-project", fileName: "MEMORY.md" }],
      },
    });
    expect(unknownProject.ok()).toBe(false);
  });

  test("工作区记忆开关保存后刷新仍生效", async ({ page }) => {
    let management = await openSettingsSection(page, "记忆");
    const toggle = management.locator('[data-testid="settings-memory-switch"]');
    const initialState = await toggle.isChecked();

    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/code-ui/rpc"),
      ),
      toggle.click(),
    ]);
    await expect(toggle).not.toBeChecked();

    await page.reload();
    management = await openSettingsSection(page, "记忆");
    await expect(
      management.locator('[data-testid="settings-memory-switch"]'),
    ).not.toBeChecked();

    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/code-ui/rpc"),
      ),
      management.locator('[data-testid="settings-memory-switch"]').click(),
    ]);
    await expect(
      management.locator('[data-testid="settings-memory-switch"]'),
    ).toBeChecked();

    if (!initialState) {
      await Promise.all([
        page.waitForResponse((response) =>
          response.url().includes("/api/code-ui/rpc"),
        ),
        management.locator('[data-testid="settings-memory-switch"]').click(),
      ]);
      await expect(
        management.locator('[data-testid="settings-memory-switch"]'),
      ).not.toBeChecked();
    }
  });
});
