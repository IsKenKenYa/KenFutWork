import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bootstrapDifyStack,
  bootstrapDifyStackWithRetry,
} from "./bootstrap.js";

function envFile(values: Record<string, string>) {
  const dataDir = mkdtempSync(join(tmpdir(), "dify-bootstrap-"));
  const file = join(dataDir, "dify-stack.env");
  writeFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  return file;
}

function validEnv() {
  return envFile({
    DIFY_INIT_PASSWORD: "init-secret",
    DIFY_ADMIN_EMAIL: "admin@kenfutwork.local",
    DIFY_ADMIN_PASSWORD: "admin-secret-with-enough-length",
  });
}

const options = () => ({
  envFile: validEnv(),
  consoleBase: "http://127.0.0.1:15001/console/api",
  requestTimeoutMs: 1000,
});

describe("Dify 首次初始化", () => {
  it("已完成的实例不重放 init/setup", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL) =>
      Response.json({ step: "finished" }),
    );

    await expect(
      bootstrapDifyStack({ ...options(), fetchImpl }),
    ).resolves.toEqual({ status: "already_initialized" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:15001/console/api/setup",
    );
  });

  it("init 与 setup 共用 cookie，成功后完成初始化", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, init });
      if (target.endsWith("/setup") && (init?.method ?? "GET") === "GET") {
        return Response.json({ step: "not_started" });
      }
      if (target.endsWith("/init") && (init?.method ?? "GET") === "GET") {
        return Response.json({ status: "not_started" });
      }
      if (target.endsWith("/init") && init?.method === "POST") {
        return new Response(JSON.stringify({ result: "success" }), {
          status: 201,
          headers: { "set-cookie": "session=abc; HttpOnly; Path=/" },
        });
      }
      if (target.endsWith("/setup") && init?.method === "POST") {
        expect(init.headers).toMatchObject({ cookie: "session=abc" });
        return Response.json({ result: "success" }, { status: 201 });
      }
      throw new Error(`unexpected ${target}`);
    });

    await expect(
      bootstrapDifyStack({ ...options(), fetchImpl }),
    ).resolves.toEqual({ status: "initialized" });
    expect(
      calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`),
    ).toEqual([
      "GET http://127.0.0.1:15001/console/api/setup",
      "GET http://127.0.0.1:15001/console/api/init",
      "POST http://127.0.0.1:15001/console/api/init",
      "POST http://127.0.0.1:15001/console/api/setup",
    ]);
  });

  it("管理员凭据复用 Flow 网关 env，并按 runtime 覆盖", async () => {
    const gatewayEnv = envFile({
      DIFY_ADMIN_EMAIL: "base@futureflow.local",
      DIFY_ADMIN_PASSWORD: "base-password-with-enough-length",
    });
    const runtimeEnv = envFile({
      DIFY_ADMIN_EMAIL: "runtime@futureflow.local",
      DIFY_ADMIN_PASSWORD: "runtime-password-with-enough-length",
    });
    let setupBody = "";
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/setup") && (init?.method ?? "GET") === "GET")
        return Response.json({ step: "not_started" });
      if (target.endsWith("/init") && (init?.method ?? "GET") === "GET")
        return Response.json({ status: "finished" });
      if (target.endsWith("/setup") && init?.method === "POST") {
        setupBody = String(init.body);
        return Response.json({ result: "success" }, { status: 201 });
      }
      throw new Error(`unexpected ${target}`);
    });

    await bootstrapDifyStack({
      envFile: envFile({ DIFY_INIT_PASSWORD: "init-secret" }),
      credentialEnvFiles: [gatewayEnv, runtimeEnv],
      consoleBase: "http://127.0.0.1:15001/console/api",
      requestTimeoutMs: 1000,
      fetchImpl,
    });

    expect(JSON.parse(setupBody)).toMatchObject({
      email: "runtime@futureflow.local",
      password: "runtime-password-with-enough-length",
    });
  });

  it("setup 响应丢失后重放按权威状态收口，不重复建管理员", async () => {
    let setupReads = 0;
    let setupWrites = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/setup") && (init?.method ?? "GET") === "GET") {
        setupReads += 1;
        return Response.json({
          step: setupReads === 1 ? "not_started" : "finished",
        });
      }
      if (target.endsWith("/init") && (init?.method ?? "GET") === "GET")
        return Response.json({ status: "finished" });
      if (target.endsWith("/setup") && init?.method === "POST") {
        setupWrites += 1;
        return Response.json({ error: "response lost" }, { status: 500 });
      }
      throw new Error(`unexpected ${target}`);
    });

    await expect(
      bootstrapDifyStack({ ...options(), fetchImpl }),
    ).resolves.toEqual({ status: "initialized" });
    expect(setupWrites).toBe(1);
    expect(setupReads).toBe(2);
  });

  it("Flow 网关管理员配置缺失时在发起请求前 fail loud", async () => {
    const fetchImpl = vi.fn();

    await expect(
      bootstrapDifyStack({
        envFile: envFile({
          DIFY_INIT_PASSWORD: "init-secret",
          DIFY_ADMIN_EMAIL: "admin@futureflow.local",
        }),
        consoleBase: "http://127.0.0.1:15001/console/api",
        requestTimeoutMs: 1000,
        fetchImpl,
      }),
    ).rejects.toThrow(/DIFY_ADMIN_PASSWORD.*Flow 网关/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("init 密码被拒绝时不进入 setup，并给出可读错误", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/setup") && (init?.method ?? "GET") === "GET")
        return Response.json({ step: "not_started" });
      if (target.endsWith("/init") && (init?.method ?? "GET") === "GET")
        return Response.json({ status: "not_started" });
      if (target.endsWith("/init") && init?.method === "POST")
        return Response.json({ message: "invalid password" }, { status: 401 });
      throw new Error(`unexpected ${target}`);
    });

    const sleep = vi.fn(async () => undefined);
    await expect(
      bootstrapDifyStackWithRetry(
        { ...options(), attempts: 3, retryDelayMs: 0, fetchImpl },
        { sleep },
      ),
    ).rejects.toThrow(/init.*401|初始化.*401/i);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("服务尚未就绪时按预算重试，重复启动不叠加副作用", async () => {
    let setupReads = 0;
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/setup") && (init?.method ?? "GET") === "GET") {
        setupReads += 1;
        if (setupReads === 1) throw new TypeError("fetch failed");
        return Response.json({ step: "finished" });
      }
      throw new Error(`unexpected ${target}`);
    });

    await expect(
      bootstrapDifyStackWithRetry(
        { ...options(), attempts: 2, retryDelayMs: 0, fetchImpl },
        { sleep },
      ),
    ).resolves.toEqual({ status: "already_initialized" });
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
