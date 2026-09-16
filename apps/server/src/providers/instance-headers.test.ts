import { describe, expect, it } from "vitest";

import { instanceHeadersOption, renderInstanceHeaders } from "./instance-headers.js";

describe("instance-headers 渲染（§4.8 自定义请求头）", () => {
  it("无配置返回 undefined——适配器保持库默认行为，不注入空头表", () => {
    expect(renderInstanceHeaders(undefined, {})).toBeUndefined();
    expect(renderInstanceHeaders({}, { sessionId: "s-1" })).toBeUndefined();
    expect(instanceHeadersOption(undefined, {})).toEqual({});
  });

  it("静态头原样透传，占位符按上下文替换", () => {
    expect(
      renderInstanceHeaders(
        {
          "x-tenant-id": "ws-42",
          "x-opencode-session": "{{sessionId}}",
          "x-opencode-thread": "thread-{{threadId}}",
        },
        { sessionId: "sess-abc", threadId: "t-1" },
      ),
    ).toEqual({
      "x-tenant-id": "ws-42",
      "x-opencode-session": "sess-abc",
      "x-opencode-thread": "thread-t-1",
    });
  });

  it("同一会话多轮取到同一个值、不同会话值不同（亲和成立）", () => {
    const headers = { "x-opencode-session": "{{sessionId}}" };
    const first = renderInstanceHeaders(headers, { sessionId: "sess-a" });
    const second = renderInstanceHeaders(headers, { sessionId: "sess-a" });
    const other = renderInstanceHeaders(headers, { sessionId: "sess-b" });

    expect(first).toEqual(second);
    expect(first?.["x-opencode-session"]).toBe("sess-a");
    expect(other?.["x-opencode-session"]).toBe("sess-b");
  });

  it("占位符取不到上下文值即抛错——不把字面量 {{sessionId}} 发出去", () => {
    expect(() =>
      renderInstanceHeaders({ "x-opencode-session": "{{sessionId}}" }, {}),
    ).toThrow(/取不到值/);
    expect(() =>
      renderInstanceHeaders({ "x-t": "{{threadId}}" }, { sessionId: "s-1" }),
    ).toThrow(/取不到值/);
  });

  it("白名单外占位符、保留头、非法头名一律拒绝（纵深防御，写入时已先拒）", () => {
    expect(() =>
      renderInstanceHeaders({ "x-t": "{{workspaceId}}" }, { sessionId: "s" }),
    ).toThrow(/不支持的占位符/);
    expect(() =>
      renderInstanceHeaders({ Authorization: "Bearer evil" }, {}),
    ).toThrow(/保留头/);
    expect(() =>
      renderInstanceHeaders({ "x bad": "v" }, {}),
    ).toThrow(/合法 HTTP token/);
  });

  it("渲染后再校验字符集：会话 id 带 CRLF 也注入不了额外头", () => {
    expect(() =>
      renderInstanceHeaders(
        { "x-opencode-session": "{{sessionId}}" },
        { sessionId: "s-1\r\nX-Evil: 1" },
      ),
    ).toThrow(/非可打印字符/);
  });
});
