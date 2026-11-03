import { zcodeMcpListResultSchema } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { toZcodeMcpStatus } from "./code-ui-host.js";

describe("设置页 MCP 状态契约", () => {
  it("运行态 error 映射为 failed 并带原因，不再让整包 schema 解析成 400", () => {
    // 原实现原样透传 "error"：不在 zcode 枚举内，listWorkspaceMcpServerStatuses 整包失败。
    expect(
      zcodeMcpListResultSchema.safeParse({
        statuses: {
          broken: {
            status: "error",
            transport: "stdio",
            toolCount: 0,
            updatedAt: "2026-11-03T00:00:00.000Z",
            error: "EPERM: operation not permitted, lstat 'D:\\'",
          },
        },
      }).success,
    ).toBe(false);

    const status = toZcodeMcpStatus({ enabled: true, status: "error" });
    expect(status).toBe("failed");
    expect(
      zcodeMcpListResultSchema.safeParse({
        statuses: {
          broken: {
            status,
            transport: "stdio",
            toolCount: 0,
            updatedAt: "2026-11-03T00:00:00.000Z",
            error: "EPERM: operation not permitted, lstat 'D:\\'",
          },
        },
      }).success,
    ).toBe(true);
  });

  it("连接成功才报 connected，未启用报 disabled", () => {
    expect(toZcodeMcpStatus({ enabled: true, status: "connected" })).toBe(
      "connected",
    );
    expect(toZcodeMcpStatus({ enabled: false, status: "connected" })).toBe(
      "disabled",
    );
    expect(toZcodeMcpStatus({ enabled: true, status: "disabled" })).toBe(
      "disabled",
    );
  });
});
