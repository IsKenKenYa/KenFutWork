import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";

// 该用例归档默认项目，只允许显式指定全新独占开发数据库，避免修改共享工作区。
const isolatedHttp = useCodeUiHttpFixture();
const { request } = isolatedHttp;

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1" && true;
const ensure = () =>
  request("/api/code-ui/rpc", {
    service: "file",
    method: "ensureConversationWorkspace",
    args: [],
  });

describe.skipIf(!enabled)("原默认对话工作目录公开接口 integration", () => {
  it("冷并发只建一个真实Project/主画布，重开保留文件，归档后迟到ensure不复活", async () => {
    const concurrent = await Promise.all([ensure(), ensure(), ensure()]);
    for (const response of concurrent)
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      concurrent.filter((response) => response.body.result.created),
    ).toHaveLength(1);
    const { path } = concurrent[0]!.body.result;
    for (const response of concurrent)
      expect(response.body.result).toMatchObject({
        path,
        workspacePurpose: "conversation",
      });
    const replay = await ensure();
    expect(replay).toMatchObject({
      status: 200,
      body: { result: { path, created: false } },
    });
    const workspaces = await request("/api/code-ui/workspaces");
    const matches = workspaces.body.workspaces.filter(
      (workspace: { path: string }) => workspace.path === path,
    );
    expect(matches).toHaveLength(1);
    const workspace = matches[0];
    expect(workspace).toMatchObject({
      projectId: expect.any(String),
      canvasId: expect.any(String),
    });
    const filePath = join(path, `原Root-${randomUUID()}.txt`);
    try {
      await writeFile(filePath, "上一轮正文 🌟");
      const reopen = await request("/api/code-ui/rpc", {
        service: "workspace",
        method: "open",
        args: [{ path }],
      });
      expect(reopen.body.result).toEqual(workspace);
      const read = await request("/api/code-ui/rpc", {
        service: "file",
        method: "readTextFile",
        args: [{ path: filePath }],
      });
      expect(read).toMatchObject({
        status: 200,
        body: { result: { content: "上一轮正文 🌟", truncated: false } },
      });
      expect(
        (
          await request(
            `/api/projects/${workspace.projectId}`,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(204);
      for (const late of await Promise.all([ensure(), ensure()]))
        expect(late).toMatchObject({
          status: 409,
          body: {
            error: { message: "工作目录对应的项目已归档，无法重新打开。" },
          },
        });
      const after = await request("/api/code-ui/workspaces");
      expect(
        after.body.workspaces.filter(
          (entry: { path: string }) => entry.path === path,
        ),
      ).toEqual([]);
    } finally {
      await rm(filePath, { force: true });
      await request(
        `/api/projects/${workspace.projectId}`,
        undefined,
        "DELETE",
      );
    }
  });
});
