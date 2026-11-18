import { describe, expect, it } from "vitest";

import { readPluginContributions } from "./plugin-contributions.js";

const BASE = {
  pluginId: "kenfutwork-tripo-3d",
  pluginName: "Tripo 3D",
  pluginRoot: "C:\\data\\plugins\\tripo-3d",
};

describe("插件贡献解析", () => {
  it("解析 mcp.json 的 http server，并替换 user_config 默认值", () => {
    const files = {
      "package.json": JSON.stringify({
        name: "kenfutwork-unreal-engine",
        kenfutwork: {
          userConfig: {
            endpoint: { type: "string", default: "http://127.0.0.1:8000/mcp" },
          },
        },
      }),
      "mcp.json": JSON.stringify({
        mcpServers: {
          "unreal-mcp": {
            type: "http",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: 意图保留 user_config 占位符
            url: "${user_config.endpoint}",
            timeoutMs: 60_000,
          },
        },
      }),
    };
    const result = readPluginContributions(files, BASE);
    expect(result.mcpServers).toEqual([
      {
        pluginId: BASE.pluginId,
        pluginName: BASE.pluginName,
        name: "unreal-mcp",
        kind: "http",
        command: "",
        args: [],
        url: "http://127.0.0.1:8000/mcp",
        env: {},
        headers: {},
        timeoutMs: 60_000,
        enabled: true,
      },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("解析 commands/*.md 的说明与正文，非法文件名跳过并记账", () => {
    const files = {
      "package.json": JSON.stringify({ name: "kenfutwork-godot" }),
      "commands/open.md":
        "---\ndescription: Open a local Godot project\n---\nFollow the CLI skill.\nResolve $ARGUMENTS.",
      "commands/bad name.md": "---\ndescription: x\n---\nbody",
    };
    const result = readPluginContributions(files, BASE);
    expect(result.commands).toEqual([
      {
        pluginId: BASE.pluginId,
        pluginName: BASE.pluginName,
        name: "open",
        description: "Open a local Godot project",
        prompt: "Follow the CLI skill.\nResolve $ARGUMENTS.",
      },
    ]);
    expect(result.issues.some((issue) => issue.includes("bad name.md"))).toBe(
      true,
    );
  });

  it("SessionStart 的 process 钩子映射为 turn-start，保留插件根目录", () => {
    const files = {
      "package.json": JSON.stringify({ name: "kenfutwork-tripo-3d" }),
      "hooks/hooks.json": JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup|clear|compact",
              hooks: [
                {
                  type: "process",
                  command: "node",
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: 意图保留 zcode 插件根占位符
                  args: ["${ZCODE_PLUGIN_ROOT}/hooks/session-start.mjs"],
                  timeoutMs: 5_000,
                },
                { type: "prompt", command: "ignored" },
              ],
            },
          ],
        },
      }),
    };
    const result = readPluginContributions(files, BASE);
    expect(result.hooks).toEqual([
      {
        pluginId: BASE.pluginId,
        pluginName: BASE.pluginName,
        event: "turn-start",
        matcher: "startup|clear|compact",
        command: "node",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: 意图保留 zcode 插件根占位符
        args: ["${ZCODE_PLUGIN_ROOT}/hooks/session-start.mjs"],
        timeoutMs: 5_000,
        pluginRoot: BASE.pluginRoot,
      },
    ]);
    expect(result.issues.some((issue) => issue.includes("process"))).toBe(true);
  });

  it("坏 JSON 与非法 MCP 配置只记账，不抛异常", () => {
    const files = {
      "package.json": JSON.stringify({ name: "kenfutwork-broken" }),
      "mcp.json": "{ not json",
      "hooks/hooks.json": JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "process" }] }] },
      }),
    };
    const result = readPluginContributions(files, BASE);
    expect(result.mcpServers).toEqual([]);
    expect(result.hooks).toEqual([]);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});
