import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zcodePluginsDescribeResultSchema } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
describe.skipIf(!enabled)(
  "原插件技能详情独占HTTP与Postgres integration",
  () => {
    it("候选技能真实经SSE连接后的原pluginRPC读取，未知来源拒绝且不执行模块或生成安装缓存", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "kfw-plugin-skills-http-"),
      );
      const builtinPluginsDir = join(directory, "bundled");
      const packageDirectory = join(builtinPluginsDir, "clock");
      const packageSource = fileURLToPath(
        new URL("../../../../../plugins/example-clock/", import.meta.url),
      );
      let host: Awaited<ReturnType<typeof createCodeUiHttpFixture>> | undefined;
      try {
        await cp(packageSource, packageDirectory, { recursive: true });
        const skillDirectory = join(
          packageDirectory,
          "skills",
          "inspect-project",
        );
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
          join(skillDirectory, "SKILL.md"),
          "---\nname: inspect-project\ndescription: 检查真实项目文件\n---\n读取项目目录。\n",
        );
        const entryPath = join(packageDirectory, "index.js");
        const entry = `${await readFile(entryPath, "utf8")}\nthrow new Error("技能详情不得执行模块");\n`;
        await writeFile(entryPath, entry);
        host = await createCodeUiHttpFixture({
          builtinPluginsDir,
          allowThirdPartyPlugins: false,
        });
        const { client } = host;
        expect((await client.request("/api/viewer")).status).toBe(200);
        const stream = await client.openCodeStream();
        const connectionId = stream.ready.hello.connectionId;
        const projectDirectory = join(directory, "project");
        await mkdir(projectDirectory);
        const opened = await client.request("/api/code-ui/rpc", {
          connectionId,
          service: "workspace",
          method: "open",
          args: [{ path: projectDirectory }],
        });
        expect(opened.status, JSON.stringify(opened.body)).toBe(200);
        const target = {
          workspacePath: opened.body.result.path,
          projectId: opened.body.result.projectId,
        };
        const rpc = (method: string, value: unknown) =>
          client.request("/api/code-ui/rpc", {
            connectionId,
            service: "plugin-management",
            method,
            args: [value],
          });
        const before = await readdir(host.pluginsDir, { recursive: true });
        const result = await rpc("describePlugin", {
          ...target,
          pluginName: "kenfutwork-example-clock",
          marketplace: "kenfutwork-bundled",
        });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect(
          zcodePluginsDescribeResultSchema.parse(result.body.result),
        ).toMatchObject({
          metadata: { version: "1.0.0" },
          components: [
            {
              kind: "skill",
              items: [
                { name: "inspect-project", description: "检查真实项目文件" },
              ],
            },
          ],
        });
        const unknown = await rpc("describePlugin", {
          ...target,
          pluginName: "kenfutwork-example-clock",
          marketplace: "unknown",
        });
        expect(unknown.status).toBe(404);
        const remote = await rpc("describePlugin", {
          ...target,
          pluginName: "kenfutwork-example-clock",
          marketplace: "kenfutwork-bundled",
          remoteSessionId: "remote-unknown",
        });
        expect(remote.body.error.message).toContain("未装配远程");
        const list = await rpc("listPlugins", {
          ...target,
          configScope: "user",
        });
        expect(list.status, JSON.stringify(list.body)).toBe(200);
        expect(list.body.result.plugins).toEqual([]);
        expect(await readdir(host.pluginsDir, { recursive: true })).toEqual(
          before,
        );
        expect(await readFile(entryPath, "utf8")).toBe(entry);
        await expect(
          readFile(join(host.pluginsDir, "installed.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        try {
          await host?.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    });
  },
);
