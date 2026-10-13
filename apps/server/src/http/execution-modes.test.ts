import { applicationErrorResponseSchema } from "@kenfutwork/shared";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionModeService,
  RetiredExecutionModeError,
} from "../features/agent-modes/execution-mode-service.js";
import { registerExecutionModeRoutes } from "./execution-modes.js";

describe("停用旧循环执行模式的 HTTP 行为", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function fixture() {
    const app = Fastify();
    apps.push(app);
    const agentModes = createExecutionModeService({
      store: {
        lookup: async () => ({ exists: true, mode: "loop" }),
        save: async () => true,
      },
    });
    void registerExecutionModeRoutes(app, {
      localAccess: {
        authenticate: async () => ({
          instanceId: "instance",
          accessClientId: "client",
        }),
      } as never,
      viewer: { resolve: async () => ({ instanceId: "instance" }) } as never,
      agentModes,
    });
    return app;
  }

  it("旧持久 loop 在 GET 时返回 409 与重新选择提示", async () => {
    const app = fixture();
    const response = await app.inject({
      method: "GET",
      url: "/api/execution-modes/thread",
    });
    expect(response.statusCode).toBe(409);
    expect(
      applicationErrorResponseSchema.parse(response.json()).error,
    ).toMatchObject({
      code: "invalid_request",
      message: new RetiredExecutionModeError().message,
    });
  });

  it("PUT 明确拒绝重新选择旧 loop，且不写入存储", async () => {
    const save = vi.fn(async () => true);
    const app = Fastify();
    apps.push(app);
    const agentModes = createExecutionModeService({
      store: {
        lookup: async () => ({ exists: true, mode: "agent" }),
        save,
      },
    });
    void registerExecutionModeRoutes(app, {
      localAccess: {
        authenticate: async () => ({
          instanceId: "instance",
          accessClientId: "client",
        }),
      } as never,
      viewer: { resolve: async () => ({ instanceId: "instance" }) } as never,
      agentModes,
    });
    const response = await app.inject({
      method: "PUT",
      url: "/api/execution-modes/thread",
      payload: { mode: "loop" },
    });
    expect(response.statusCode).toBe(400);
    expect(
      applicationErrorResponseSchema.parse(response.json()).error.message,
    ).toContain("循环模式已停用");
    expect(save).not.toHaveBeenCalled();
  });
});
