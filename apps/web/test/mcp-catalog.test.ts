import type { McpCuratedServer } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import {
  buildCuratedServerPayload,
  requiredEnvKeys,
} from "../src/lib/mcp-catalog.js";

const filesystem: McpCuratedServer = {
  id: "filesystem",
  name: "filesystem",
  title: "本地文件系统",
  description: "",
  command: "npx",
  argsTemplate: ["-y", "@modelcontextprotocol/server-filesystem", "{{dir}}"],
  params: [
    { key: "dir", label: "允许访问的目录", example: "D:/x", required: true },
  ],
  requires: "node",
};

/**
 * 内置 MCP 目录的「一键添加」：必填参数没填不能提交（否则会把 {{dir}} 字面量
 * 当参数交给子进程）；填了则渲染成真实参数。
 */
describe("内置 MCP 目录参数渲染", () => {
  it("必填未填：报出参数名且不产出该参数", () => {
    const { payload, missing } = buildCuratedServerPayload(filesystem, {});
    expect(missing).toEqual(["允许访问的目录"]);
    expect(payload.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
    ]);
  });

  it("填写后渲染进参数；首尾空白被裁掉", () => {
    const { payload, missing } = buildCuratedServerPayload(filesystem, {
      dir: "  D:/proj  ",
    });
    expect(missing).toEqual([]);
    expect(payload.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "D:/proj",
    ]);
    expect(payload.command).toBe("npx");
  });

  it("无参数条目原样产出；envKeys 提示照传", () => {
    const fetchEntry: McpCuratedServer = {
      id: "fetch",
      name: "fetch",
      title: "网页抓取",
      description: "",
      command: "uvx",
      argsTemplate: ["mcp-server-fetch"],
      params: [],
      requires: "python",
    };
    expect(buildCuratedServerPayload(fetchEntry, {}).payload.args).toEqual([
      "mcp-server-fetch",
    ]);

    const github = { ...fetchEntry, envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] };
    expect(requiredEnvKeys(github)).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    expect(requiredEnvKeys(fetchEntry)).toEqual([]);
  });
});
