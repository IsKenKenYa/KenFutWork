import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isSagCliPlatformSupported,
  isSagConfigured,
  isSagIndexReady,
  SAG_CLI_INTEGRITY,
  SAG_CLI_SHASUM,
  SAG_CLI_TARBALL,
  SAG_CLI_VERSION,
  SAG_EXIT,
  SAG_QUERY_MAX_CHARS,
  sagAddOutputSchema,
  sagCheckOutputSchema,
  sagIndexCoverageSchema,
  sagListOutputSchema,
  sagMatchOutputSchema,
  sagModelConfigSchema,
  sagRemoveOutputSchema,
  sagSearchOutputSchema,
  sagStatusSchema,
  toKnowledgeEvidence,
} from "./sag-cli-contract.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/sag-0.1.8.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

describe("SAG CLI 0.1.8 输出契约（按上游 serde 定义推导的 fixture）", () => {
  it("list --json 顶层是数组，Root.error 可为 null", () => {
    const parsed = sagListOutputSchema.parse(fixture.list);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      path: "D:/work/kenfutwork",
      status: "ready",
      count: 1284,
    });
    expect(parsed[0]?.error).toBeNull();
  });

  it("check --json 解析覆盖度、就绪标记、扩展名列表与嵌套 roots", () => {
    const parsed = sagCheckOutputSchema.parse(fixture.check);
    expect(parsed.coverage).toBe("included");
    expect(parsed.extensions).toContain("ts");
    expect(parsed.roots[0]?.name).toBe("kenfutwork");
    expect(isSagIndexReady(parsed)).toBe(true);
  });

  it("check 未就绪时 isSagIndexReady 为 false，不误判成可用", () => {
    const parsed = sagCheckOutputSchema.parse(fixture.checkNotReady);
    expect(parsed.extensions).toBeUndefined();
    expect(isSagIndexReady(parsed)).toBe(false);
  });

  it("就绪判定四个条件缺一不可（主动越界）", () => {
    const base = sagCheckOutputSchema.parse(fixture.check);
    expect(isSagIndexReady({ ...base, coverage: "partial" })).toBe(false);
    expect(isSagIndexReady({ ...base, index_ready: false })).toBe(false);
    expect(isSagIndexReady({ ...base, enabled: false })).toBe(false);
    expect(isSagIndexReady({ ...base, indexed_files: 0 })).toBe(false);
  });

  it("add / remove 输出形状精确", () => {
    expect(sagAddOutputSchema.parse(fixture.add)).toEqual({
      path: "D:/work/kenfutwork",
      index_status: "ready",
      cli_authorized: true,
    });
    expect(sagRemoveOutputSchema.parse(fixture.remove)).toEqual({
      path: "D:/work/kenfutwork",
    });
  });

  it("search --json 归一化成宿主证据对象，可选字段不变成 undefined 键", () => {
    const output = sagSearchOutputSchema.parse(fixture.search);
    expect(output.protocol_version).toBe(2);
    expect(output.results).toHaveLength(2);
    const [first, second] = output.results;
    if (!first || !second) throw new Error("fixture 缺搜索结果");

    const withContent = toKnowledgeEvidence(first);
    expect(withContent).toEqual({
      path: "src/features/mcp/client.ts",
      absolutePath: "D:/work/kenfutwork/src/features/mcp/client.ts",
      startLine: 142,
      endLine: 158,
      heading: "重试逻辑",
      content: "if (status === 499) { retry(); }",
    });

    const withoutOptional = toKnowledgeEvidence(second);
    expect(withoutOptional).toEqual({
      path: "docs/api/ws-protocol.md",
      absolutePath: "D:/work/kenfutwork/docs/api/ws-protocol.md",
      startLine: 3,
      endLine: 9,
    });
    expect("content" in withoutOptional).toBe(false);
  });

  it("-E/-F 匹配输出带 matched / files / matched_lines", () => {
    const output = sagMatchOutputSchema.parse(fixture.match);
    expect(output.matched).toBe(true);
    expect(output.files[0]?.count).toBe(1);
    const firstMatch = output.results[0];
    if (!firstMatch) throw new Error("fixture 缺匹配结果");
    expect(toKnowledgeEvidence(firstMatch).matchedLines).toEqual([142]);
  });

  it("config 的 has_key + auth_mode 支撑「已配置则复用、绝不覆盖」", () => {
    const configured = sagModelConfigSchema.parse(fixture.config);
    const unset = sagModelConfigSchema.parse(fixture.configUnset);
    expect(isSagConfigured(configured)).toBe(true);
    expect(isSagConfigured(unset)).toBe(false);
    expect(isSagConfigured({ ...unset, auth_mode: "none" })).toBe(true);
    expect(isSagConfigured({ ...configured, model: "  " })).toBe(false);
  });

  it("0.1.8 实机 config 可能缺 auth_mode（发布版与 main 源码漂移，回归锁）", () => {
    const real = sagModelConfigSchema.parse(fixture.configNoAuthMode);
    expect(real.auth_mode).toBeUndefined();
    expect(isSagConfigured(real)).toBe(false);
    expect(isSagConfigured({ ...real, has_key: true })).toBe(true);
  });

  it("coverage 只收 snake_case 四值，拒绝 Rust 变体名", () => {
    for (const value of ["included", "partial", "excluded", "none"]) {
      expect(sagIndexCoverageSchema.safeParse(value).success).toBe(true);
    }
    expect(sagIndexCoverageSchema.safeParse("Included").success).toBe(false);
    expect(sagIndexCoverageSchema.safeParse("unknown").success).toBe(false);
  });

  it("缺必需字段显式报错，不静默吞掉", () => {
    const broken = {
      ...(fixture.search as Record<string, unknown>),
      results: [{ path: "a.ts" }],
    };
    expect(sagSearchOutputSchema.safeParse(broken).success).toBe(false);
    expect(sagCheckOutputSchema.safeParse({}).success).toBe(false);
  });

  it("上游新增字段被剥离而非崩溃（版本抖动宽容）", () => {
    const withExtra = {
      ...(fixture.add as Record<string, unknown>),
      future_field: { nested: true },
    };
    const parsed = sagAddOutputSchema.parse(withExtra);
    expect(parsed).not.toHaveProperty("future_field");
    expect(parsed.cli_authorized).toBe(true);
  });

  it("Root.error 省略也接受（上游若加 skip_serializing_if）", () => {
    const roots = [{ path: "D:/a", name: "a", status: "ready", count: 1 }];
    expect(sagListOutputSchema.safeParse(roots).success).toBe(true);
  });

  it("空结果集与 truncated 标志可解析", () => {
    expect(
      sagSearchOutputSchema.safeParse({
        protocol_version: 2,
        scope: "D:/empty",
        results: [],
        truncated: true,
      }).success,
    ).toBe(true);
  });

  it("status 是内部类型（sag status 不输出 JSON），仍按 serde 形状定义", () => {
    expect(
      sagStatusSchema.safeParse({
        protocol_version: 2,
        connected: true,
        enabled: true,
        jev_configured: true,
      }).success,
    ).toBe(true);
  });

  it("平台矩阵只放行 win32/x64 与 darwin/arm64", () => {
    expect(isSagCliPlatformSupported("win32", "x64")).toBe(true);
    expect(isSagCliPlatformSupported("darwin", "arm64")).toBe(true);
    expect(isSagCliPlatformSupported("darwin", "x64")).toBe(false);
    expect(isSagCliPlatformSupported("linux", "x64")).toBe(false);
    expect(isSagCliPlatformSupported("win32", "arm64")).toBe(false);
  });

  it("钉死的版本、校验和与退出码常量", () => {
    expect(SAG_CLI_VERSION).toBe("0.1.8");
    expect(SAG_CLI_TARBALL).toContain("sag-0.1.8.tgz");
    expect(SAG_CLI_SHASUM).toHaveLength(40);
    expect(SAG_CLI_INTEGRITY).toMatch(/^sha512-/);
    expect(SAG_EXIT).toEqual({
      ok: 0,
      degraded: 1,
      argument: 2,
      interrupted: 130,
    });
    expect(SAG_QUERY_MAX_CHARS).toBe(2000);
  });

  it("重复解析同一 fixture 结果一致（幂等重放）", () => {
    const first = sagSearchOutputSchema.parse(fixture.search);
    const second = sagSearchOutputSchema.parse(
      JSON.parse(JSON.stringify(fixture.search)),
    );
    expect(second).toEqual(first);
  });
});
