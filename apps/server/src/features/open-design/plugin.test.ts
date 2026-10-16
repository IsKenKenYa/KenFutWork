import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { createOpenDesignHostPlugin } from "./plugin.js";

/** 最小 env（open-design 插件不吃治理字段；对位 kernel.test 的夹具口径）。 */
function makeEnv(): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test-model",
    port: 0,
    version: "test",
    webOrigin: "http://localhost:3000",
  } as unknown as ServerEnv;
}

/** 路由注册所需的最小服务替身（compose 的 overrides 入口，测试专用）。 */
const serviceOverrides = {
  localAccess: { authenticate: async () => true },
  localInstance: { serviceActor: async () => ({}) },
  modelProviders: {
    listInstances: async () => [],
    resolveCredentialsById: async () => [],
  },
};

const tempComposeFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "kfw-od-plugin-"));
  const file = join(dir, "docker-compose.open-design.yml");
  writeFileSync(file, "name: test\n");
  return file;
};

const asFetch = (impl: unknown) => impl as unknown as typeof fetch;

interface ComposeCall {
  args: readonly string[];
  env?: Record<string, string>;
}

function recordingRun(calls: ComposeCall[]) {
  return async (
    args: readonly string[],
    options: { env?: Record<string, string>; timeoutMs?: number },
  ) => {
    calls.push({ args, ...(options.env ? { env: options.env } : {}) });
    return { code: 0, stderr: "" };
  };
}

async function assemble(input: {
  frontendUrl?: string;
  secret?: string;
  calls: ComposeCall[];
}) {
  const composeFile = tempComposeFile();
  const kernel = composePlugins(
    makeEnv(),
    [
      createOpenDesignHostPlugin({
        ...(input.frontendUrl ? { frontendUrl: input.frontendUrl } : {}),
        ...(input.secret ? { secret: input.secret } : {}),
        composeFile,
        composeRun: recordingRun(input.calls),
        fetchImpl: asFetch(async () => new Response("ok", { status: 200 })),
      }),
    ],
    { app: Fastify(), overrides: serviceOverrides as never },
  );
  // 起栈是装配上的非阻塞副作用：让 promise 落定再断言命令序列
  await new Promise((resolve) => setImmediate(resolve));
  return { kernel, composeFile };
}

describe("OpenDesign 宿主插件的伴随容器装配", () => {
  it("伴随 origin：装配即 up -d 并注入成对 token，dispose 即 down", async () => {
    const calls: ComposeCall[] = [];
    const { kernel, composeFile } = await assemble({
      frontendUrl: "http://127.0.0.1:7456",
      secret: "paired-secret",
      calls,
    });
    expect(calls[0]?.args).toEqual(["-f", composeFile, "up", "-d"]);
    expect(calls[0]?.env).toEqual({ OD_API_TOKEN: "paired-secret" });

    await kernel.dispose();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(["-f", composeFile, "down"]);
  });

  it("未配密钥的托管模式：仍起栈但注入空 token（画布可用，凭证缝 503）", async () => {
    const calls: ComposeCall[] = [];
    const { kernel } = await assemble({
      frontendUrl: "http://127.0.0.1:7456",
      calls,
    });
    expect(calls[0]?.env).toEqual({ OD_API_TOKEN: "" });
    await kernel.dispose();
  });

  it("外部地址：装配与 dispose 全程一个 docker 命令都不发", async () => {
    const calls: ComposeCall[] = [];
    const { kernel } = await assemble({
      frontendUrl: "http://od.example.com",
      secret: "paired-secret",
      calls,
    });
    await kernel.dispose();
    expect(calls).toEqual([]);
  });

  it("未配置（none）：同样零 docker 调用（缺省绝不起栈）", async () => {
    const calls: ComposeCall[] = [];
    const { kernel } = await assemble({ calls });
    await kernel.dispose();
    expect(calls).toEqual([]);
  });
});
