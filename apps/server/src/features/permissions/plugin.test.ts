import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { ToolDeniedError } from "../../kernel/context.js";
import type { ToolRegistry } from "../../kernel/types.js";
import { createConsumerLocalAccessService } from "../local-access/test-consumer-service.js";
import { createLocalInstanceService } from "../local-instance/service.js";
import type { LocalActor } from "../local-instance/types.js";
import { loadCompatPlugin } from "../plugins/compat-context.js";
import { createPermissionsPlugin } from "./plugin.js";

/**
 * 权限闸门的**整链**回归：compat bundle 声明 `access` → 内核 `tool-pre-execute` 事件带
 * `access` → permissions 插件据此判危险（危险名表不认识插件工具名）。
 *
 * 缺口背景（《HA 插件规划》§3.3）：插件工具名（`mihome_control`/`ha_control`…）不进
 * `DANGEROUS_TOOL_PATTERNS`，只按名字判会**静默放行设备写入**。判据补上「属主声明的非只读
 * 效果」后这条链必须整条锁死——单元测试分别覆盖了 compat 映射、事件透传与判据本身，
 * 但没有任何一处验证过它们串起来真的拦住写工具。
 */

const testEnv: ServerEnv = {
  agentBackendMode: "state",
  agentModel: "test-model",
  port: 0,
  version: "test",
  webOrigin: "http://localhost:3000",
};

const fakeUser: LocalActor = {
  instanceId: "instance-1",
  accessClientId: "client-1",
};

/** 真实内核 + 真实 permissions 插件（fake 只替本机接入与持久化，判据全走生产代码）。 */
function assembly() {
  const app = Fastify({ logger: false });
  const kernel = composePlugins(testEnv, [createPermissionsPlugin({})], {
    app,
    overrides: {
      localAccess: createConsumerLocalAccessService(async () => fakeUser),
      localInstance: createLocalInstanceService({
        repository: { ensure: async () => fakeUser.instanceId },
        dataDir: "/tmp/permissions-gate-test",
      }),
      // 档位读回失败只记日志并回落 default（宁严勿松），用例正要在 default 档下断言。
      persistence: {} as never,
    },
  });
  return { app, kernel, tools: kernel.get("tools") as ToolRegistry };
}

/** 经 compat 层（第三方 bundle 的唯一入口）注册三类工具：读 / 写 / 未声明。 */
async function registerBundleTools(tools: ToolRegistry) {
  return loadCompatPlugin(
    {
      name: "kenfutwork-test-devices",
      inject: ["tools"],
      apply(ctx: { tools: { register: (definition: unknown) => unknown } }) {
        ctx.tools.register({
          name: "device_read",
          access: "read",
          execute: async () => "listed",
        });
        ctx.tools.register({
          name: "device_write",
          access: "write",
          execute: async () => "written",
        });
        ctx.tools.register({
          name: "device_undeclared",
          execute: async () => "did-something",
        });
      },
    } as never,
    {
      tools,
      label: "test-bundle",
      subscribe: () => () => {},
      promptFragments: () => () => {},
      routes: () => () => {},
      ui: () => () => {},
      storage: {
        get: async () => null,
        set: async () => {},
        remove: async () => true,
        keys: async () => [],
      },
    },
  );
}

describe("permissions 插件：插件工具 access 判据的整链", () => {
  it("默认档：声明 write 与未声明的插件工具都被拦（原因可读），声明 read 放行", async () => {
    const { app, kernel, tools } = assembly();
    const loaded = await registerBundleTools(tools);

    // 声明写、以及未声明（未知效果按执行策略人审）：默认档下不静默放行
    for (const name of ["device_write", "device_undeclared"]) {
      await expect(tools.execute(name, {})).rejects.toBeInstanceOf(
        ToolDeniedError,
      );
      await expect(tools.execute(name, {})).rejects.toThrow(/危险操作/);
    }

    // 只读声明放行，且真的执行到插件代码
    await expect(tools.execute("device_read", {})).resolves.toBe("listed");

    loaded.dispose();
    await app.close();
    await kernel.dispose();
  });

  it("永久批准后同一工具放行（审批记忆按工具名），其它工具不受影响", async () => {
    const { app, kernel, tools } = assembly();
    const loaded = await registerBundleTools(tools);

    kernel.get("permissions").approve("device_write", { scope: "forever" });

    await expect(tools.execute("device_write", {})).resolves.toBe("written");
    await expect(tools.execute("device_undeclared", {})).rejects.toThrow(
      /危险操作/,
    );

    loaded.dispose();
    await app.close();
    await kernel.dispose();
  });

  it("未声明 access 的内建注册工具维持按名字判（无回归）", async () => {
    const { app, kernel, tools } = assembly();

    tools.register({
      name: "inspect_something",
      description: "只读检查（未声明 access 的旧工具形状）",
      scope: "shared",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
    });

    await expect(tools.execute("inspect_something", {})).resolves.toBe("ok");

    await app.close();
    await kernel.dispose();
  });
});
