import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";

const { request, pluginsDirectory } = useCodeUiHttpFixture();
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原MCP管理接口 integration",
  () => {
    it("原连接页读取真实stdio工具并重连，不能执行UI提供的替代命令", async () => {
      // 外部stdio边界替身；通过真实SDK的initialize/tools/list协议验证宿主消费。
      const script = `
        import { createInterface } from "node:readline";
        for await (const line of createInterface({ input: process.stdin })) {
          const request = JSON.parse(line);
          if (request.id === undefined) continue;
          const result = request.method === "initialize"
            ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ui-mcp-probe", version: "1.0.0" } }
            : request.method === "tools/list"
              ? { tools: [{ name: "probe", inputSchema: { type: "object", properties: {} } }] }
              : {};
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
        }
      `;
      const scriptPath = join(pluginsDirectory(), "..", "stdio-probe.mjs");
      await writeFile(scriptPath, script);
      const saved = await request("/api/code-ui/rpc", {
        service: "mcp-sync",
        method: "saveMcpToUserDirectory",
        args: [
          {
            action: "upsert",
            source: "zcodeagentmcp",
            hostRecordId: null,
            name: "stdio-probe",
            config: {
              command: process.execPath,
              args: [scriptPath],
              enable: true,
            },
          },
        ],
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const rows = (await request("/api/mcp/servers")).body.servers;
      expect(
        rows.find((row: { name: string }) => row.name === "stdio-probe"),
      ).toMatchObject({ status: "connected", toolCount: 1 });
      const reconnected = await request("/api/code-ui/rpc", {
        service: "mcp-sync",
        method: "listWorkspaceMcpServerStatuses",
        args: [
          {
            mode: "connect",
            mcpServers: [
              {
                name: "stdio-probe",
                command: "must-not-run",
                args: [],
                env: [],
              },
            ],
          },
        ],
      });
      expect(reconnected.status, JSON.stringify(reconnected.body)).toBe(200);
      expect(reconnected.body.result.statuses["stdio-probe"]).toMatchObject({
        status: "connected",
        transport: "stdio",
        toolCount: 1,
      });
    });

    it("原CRUD与REST共用真实记录，停用/删除可读回，删除后迟到编辑不创建新记录", async () => {
      const save = (input: unknown) =>
        request("/api/code-ui/rpc", {
          service: "mcp-sync",
          method: "saveMcpToUserDirectory",
          args: [input],
        });
      const base = { source: "zcodeagentmcp", name: "native-edit" };
      expect(
        (
          await save({
            ...base,
            action: "upsert",
            hostRecordId: null,
            config: {
              command: "not-a-real-mcp",
              args: [],
              env: { TOKEN: "draft-secret" },
              enable: false,
            },
          })
        ).status,
      ).toBe(200);
      const first = (await request("/api/mcp/servers")).body.servers.find(
        (row: { name: string }) => row.name === base.name,
      );
      expect(first).toMatchObject({
        enabled: false,
        command: "not-a-real-mcp",
      });
      expect(
        (
          await save({
            ...base,
            action: "upsert",
            hostRecordId: first.id,
            config: {
              command: "updated-mcp",
              args: ["中文", ""],
              env: { TOKEN: "new-secret" },
              enable: false,
            },
          })
        ).status,
      ).toBe(200);
      expect(
        (await request("/api/mcp/servers")).body.servers.find(
          (row: { id: string }) => row.id === first.id,
        ),
      ).toMatchObject({
        command: "updated-mcp",
        args: ["中文", ""],
        enabled: false,
      });
      expect(
        (
          await save({
            ...base,
            action: "set-enabled",
            hostRecordId: first.id,
            enabled: false,
          })
        ).status,
      ).toBe(200);
      expect(
        (await save({ ...base, action: "delete", hostRecordId: first.id }))
          .status,
      ).toBe(200);
      expect(
        (
          await save({
            ...base,
            action: "upsert",
            hostRecordId: first.id,
            config: { command: "late", args: [], enable: false },
          })
        ).status,
      ).toBe(404);
      expect(
        (await request("/api/mcp/servers")).body.servers.some(
          (row: { name: string }) => row.name === base.name,
        ),
      ).toBe(false);
    });

    it("无Project读取真实本机配置与运行状态，不虚构文件目录，普通目录不携带秘密", async () => {
      const initial = await request("/api/projects?kind=code");
      for (const project of initial.body.projects) {
        expect(
          (await request(`/api/projects/${project.id}`, undefined, "DELETE"))
            .status,
        ).toBe(204);
      }
      expect((await request("/api/projects?kind=code")).body.projects).toEqual(
        [],
      );
      const created = await request("/api/mcp/servers", {
        name: "native-probe",
        command: "not-a-real-mcp-binary",
        args: ["--测试"],
        env: { PRIVATE_TOKEN: "mcp-setting-secret" },
        enabled: false,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const read = await request("/api/code-ui/rpc", {
        service: "mcp-sync",
        method: "loadMcpFromUserDirectory",
        args: [{}],
      });
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body.result.servers).toEqual([
        {
          source: "zcodeagentmcp",
          scope: "user",
          name: "native-probe",
          enabled: false,
          origin: "managed",
          hostRecordId: created.body.server.id,
          envKeys: ["PRIVATE_TOKEN"],
          config: { command: "not-a-real-mcp-binary", args: ["--测试"] },
        },
      ]);
      expect(JSON.stringify(read.body)).not.toContain("mcp-setting-secret");
      const editor = await request("/api/code-ui/rpc", {
        service: "mcp-sync",
        method: "readMcpServerConfiguration",
        args: [{ hostRecordId: created.body.server.id }],
      });
      expect(editor.status, JSON.stringify(editor.body)).toBe(200);
      expect(editor.body.result.config.env).toEqual({
        PRIVATE_TOKEN: "mcp-setting-secret",
      });
      const status = await request("/api/code-ui/rpc", {
        service: "mcp-sync",
        method: "listWorkspaceMcpServerStatuses",
        args: [{ mode: "status" }],
      });
      expect(status.status, JSON.stringify(status.body)).toBe(200);
      expect(status.body.result.statuses["native-probe"]).toMatchObject({
        status: "disconnected",
        transport: "stdio",
        toolCount: 0,
      });
      expect(JSON.stringify(status.body)).not.toContain("mcp-setting-secret");
      expect(
        JSON.stringify((await request("/api/mcp/servers")).body),
      ).not.toContain("mcp-setting-secret");
      expect((await request("/api/projects?kind=code")).body.projects).toEqual(
        [],
      );
    });
  },
);
