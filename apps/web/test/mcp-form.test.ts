import { describe, expect, it } from "vitest";

import {
  buildMcpServerPayload,
  formatArgsText,
  parseArgsText,
  parseEnvText,
} from "../src/lib/mcp-form.js";

/**
 * 回归背景：MCP 配置此前只能改环境变量，现在要能界面增删改。
 * 三个易错点必须由纯函数兜住：参数含空格（切分会碎）、编辑时误用空 env
 * 覆盖掉已存密钥（接口只回 envKeys，不回值）、两类传输（stdio/http）校验互斥。
 */
describe("MCP 表单解析与校验", () => {
  it("参数按行解析（保留含空格的值），并忽略空行与首尾空白", () => {
    expect(parseArgsText("--flag\n/path with space\n\n  --other  ")).toEqual([
      "--flag",
      "/path with space",
      "--other",
    ]);
    expect(parseArgsText("")).toEqual([]);
    expect(formatArgsText(["--a", "/b c"])).toBe("--a\n/b c");
  });

  it("env 按 KEY=VALUE 解析；非法行报错且不吞掉合法行", () => {
    const result = parseEnvText(
      "API_KEY=abc\nNO_EQUALS_HERE\n1BAD=x\nTOKEN=  spaced  ",
    );
    expect(result.env).toEqual({ API_KEY: "abc", TOKEN: "spaced" });
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("缺少 KEY=");
    expect(result.errors[1]).toContain("环境变量名不合法");
  });

  it("stdio 新建：名称必填/格式校验/命令必填，env 总是下发", () => {
    const bad = buildMcpServerPayload(
      {
        name: "bad name!",
        kind: "stdio",
        command: "",
        url: "",
        argsText: "",
        envText: "",
      },
      { mode: "create", envTouched: false },
    );
    expect(bad.errors).toEqual([
      "名称只允许字母、数字、- 与 _。",
      "启动命令必填。",
    ]);

    const ok = buildMcpServerPayload(
      {
        name: "py-helper",
        kind: "stdio",
        command: "python",
        url: "",
        argsText: "server.py",
        envText: "K=v",
      },
      { mode: "create", envTouched: false },
    );
    expect(ok.errors).toEqual([]);
    expect(ok.payload).toEqual({
      name: "py-helper",
      kind: "stdio",
      command: "python",
      args: ["server.py"],
      env: { K: "v" },
    });
  });

  it("http 新建：只要求 url（http/https），不下发 command/args/env", () => {
    const missing = buildMcpServerPayload(
      {
        name: "remote",
        kind: "http",
        command: "",
        url: "",
        argsText: "",
        envText: "",
      },
      { mode: "create", envTouched: false },
    );
    expect(missing.errors).toEqual(["远程端点 URL 必填。"]);

    const badScheme = buildMcpServerPayload(
      {
        name: "remote",
        kind: "http",
        command: "",
        url: "ftp://example.com",
        argsText: "",
        envText: "",
      },
      { mode: "create", envTouched: false },
    );
    expect(badScheme.errors).toEqual(["远程端点 URL 必须以 http(s):// 开头。"]);

    const ok = buildMcpServerPayload(
      {
        name: "remote",
        kind: "http",
        command: "",
        url: "  https://mcp.example.com/mcp  ",
        argsText: "--should-be-ignored",
        envText: "SHOULD=be-ignored",
      },
      { mode: "create", envTouched: false },
    );
    expect(ok.errors).toEqual([]);
    expect(ok.payload).toEqual({
      name: "remote",
      kind: "http",
      url: "https://mcp.example.com/mcp",
    });
  });

  it("stdio 编辑且未改动 env：不下发 env（否则空对象会覆盖已存密钥）", () => {
    const untouched = buildMcpServerPayload(
      {
        name: "s",
        kind: "stdio",
        command: "python",
        url: "",
        argsText: "",
        envText: "",
      },
      { mode: "edit", envTouched: false },
    );
    expect(untouched.payload).not.toHaveProperty("env");
    expect(untouched.payload).not.toHaveProperty("name");

    const touched = buildMcpServerPayload(
      {
        name: "s",
        kind: "stdio",
        command: "python",
        url: "",
        argsText: "",
        envText: "NEW=1",
      },
      { mode: "edit", envTouched: true },
    );
    expect(touched.payload.env).toEqual({ NEW: "1" });
  });

  it("http 编辑：只下发 url（name/env/command 都不动）", () => {
    const result = buildMcpServerPayload(
      {
        name: "remote",
        kind: "http",
        command: "",
        url: "https://mcp.example.com/mcp",
        argsText: "",
        envText: "NEW=1",
      },
      { mode: "edit", envTouched: true },
    );
    expect(result.errors).toEqual([]);
    expect(result.payload).toEqual({
      kind: "http",
      url: "https://mcp.example.com/mcp",
    });
  });

  it("编辑态不校验名称（改名不在编辑表单范围）", () => {
    const result = buildMcpServerPayload(
      {
        name: "",
        kind: "stdio",
        command: "node",
        url: "",
        argsText: "",
        envText: "",
      },
      { mode: "edit", envTouched: false },
    );
    expect(result.errors).toEqual([]);
  });
});
