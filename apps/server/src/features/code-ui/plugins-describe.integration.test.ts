import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { request } from "./host-client.fixture.js";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
describe.skipIf(!enabled)("原插件详情公开宿主 integration", () => {
  it("未安装候选详情读取真实包版本与组件，不执行插件模块且未知来源明确失败", async () => {
    expect((await request("/api/viewer")).status).toBe(200);
    const dir = await mkdtemp(join(tmpdir(), "code-ui-plugin-description-"));
    let projectId = "";
    try {
      const opened = await request("/api/code-ui/rpc", {
        service: "workspace",
        method: "open",
        args: [{ path: dir }],
      });
      expect(opened.status).toBe(200);
      projectId = opened.body.result.projectId;
      const describePlugin = (marketplace: string, pluginName: string) =>
        request("/api/code-ui/rpc", {
          service: "plugin-management",
          method: "describePlugin",
          args: [
            { workspacePath: opened.body.result.path, marketplace, pluginName },
          ],
        });
      const result = await describePlugin(
        "kenfutwork-bundled",
        "kenfutwork-example-clock",
      );
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.result).toMatchObject({
        metadata: { version: "1.0.0" },
        components: [],
      });
      const unknown = await describePlugin(
        "not-a-marketplace",
        "kenfutwork-example-clock",
      );
      expect(unknown.status).toBe(404);
      const after = await request("/api/code-ui/rpc", {
        service: "plugin-management",
        method: "listPlugins",
        args: [{ workspacePath: opened.body.result.path, configScope: "user" }],
      });
      expect(
        after.body.result.plugins.some(
          (entry: { name: string }) =>
            entry.name === "kenfutwork-example-clock",
        ),
      ).toBe(false);
    } finally {
      if (projectId)
        await request(`/api/projects/${projectId}`, undefined, "DELETE");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
