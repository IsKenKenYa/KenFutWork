import { expect, it } from "vitest";
import {
  computerUseMcpErrorResponseSchema,
  computerUseMcpMessageSchema,
  computerUseMcpQuerySchema,
  computerUseMcpTransportErrorSchema,
} from "./mcp-contracts.js";

it.each([null, 0, "request-id"])(
  "HTTP传输错误接受id=%s，普通MCP消息仍遵守SDK的RequestId约束",
  (id) => {
    const error = {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "MCP会话不存在或已结束。" },
    };
    expect(computerUseMcpTransportErrorSchema.parse(error)).toEqual(error);
    expect(computerUseMcpErrorResponseSchema.parse(error)).toEqual(error);
    expect(computerUseMcpMessageSchema.safeParse(error).success).toBe(
      id !== null,
    );
  },
);

it("HTTP出口要求Run参数，传输错误拒绝非法JSON-RPC版本", () => {
  expect(computerUseMcpQuerySchema.safeParse({}).success).toBe(false);
  expect(computerUseMcpQuerySchema.safeParse({ runId: "" }).success).toBe(
    false,
  );
  expect(
    computerUseMcpTransportErrorSchema.safeParse({
      jsonrpc: "1.0",
      id: null,
      error: { code: -32600, message: "bad" },
    }).success,
  ).toBe(false);
});
