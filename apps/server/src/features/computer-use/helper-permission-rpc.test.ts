import { describe, expect, it } from "vitest";
import type { CodeUiHostRpcContext } from "../code-ui/host-rpc-handler.js";
import {
  createHelperPermissionRequestRpc,
  createHelperPermissionRpc,
  createHelperRestartRpc,
} from "./helper-permission-rpc.js";

const CONTEXT = {} as CodeUiHostRpcContext;
const ACTOR = {} as never;

describe("Helper 权限宿主方法", () => {
  it("插件门禁失败时状态如实不可用", async () => {
    const rpc = createHelperPermissionRpc({
      gate: async () => ({ ok: false, message: "Computer Use 插件未安装" }),
      helper: () => ({ available: false, reason: "不应读取" }),
    });
    expect(await rpc.call(ACTOR, ["/workspace"], CONTEXT)).toEqual({
      available: false,
      reason: "Computer Use 插件未安装",
    });
  });

  it("Helper 不存在时状态与重启都返回可读原因", async () => {
    const helper = () => ({
      available: false as const,
      reason: "Computer Use Helper 不存在：/tmp/missing.app",
    });
    const gate = async () => ({ ok: true as const });
    expect(
      await createHelperPermissionRpc({ gate, helper }).call(
        ACTOR,
        ["/workspace"],
        CONTEXT,
      ),
    ).toEqual({
      available: false,
      reason: "Computer Use Helper 不存在：/tmp/missing.app",
    });
    expect(
      await createHelperRestartRpc({ gate, helper }).call(
        ACTOR,
        ["/workspace"],
        CONTEXT,
      ),
    ).toEqual({
      ok: false,
      reason: "Computer Use Helper 不存在：/tmp/missing.app",
    });
  });

  it("重启参数接受省略 workspace 的调用", async () => {
    const rpc = createHelperRestartRpc({
      gate: async () => ({ ok: false, message: "未安装" }),
      helper: () => ({ available: false, reason: "不可用" }),
    });
    expect(await rpc.call(ACTOR, [], CONTEXT)).toEqual({
      ok: false,
      reason: "未安装",
    });
  });

  it("权限请求在 Helper 不可用时不会假装已请求", async () => {
    const rpc = createHelperPermissionRequestRpc({
      gate: async () => ({ ok: true }),
      helper: () => ({ available: false, reason: "Helper 未启动" }),
    });
    expect(await rpc.call(ACTOR, [{ kind: "accessibility" }], CONTEXT)).toEqual(
      { requested: false, reason: "Helper 未启动" },
    );
  });

  it("插件门禁失败时不会触发 Helper 权限框", async () => {
    let called = false;
    const rpc = createHelperPermissionRequestRpc({
      gate: async () => ({ ok: false, message: "Computer Use 插件未安装" }),
      helper: () => {
        called = true;
        return { available: false, reason: "不可用" };
      },
    });
    expect(await rpc.call(ACTOR, [{ kind: "accessibility" }], CONTEXT)).toEqual(
      { requested: false, reason: "Computer Use 插件未安装" },
    );
    expect(called).toBe(false);
  });

  it("未知权限类型在启动 Helper 前就被拒绝", async () => {
    let called = false;
    const rpc = createHelperPermissionRequestRpc({
      gate: async () => ({ ok: true }),
      helper: () => {
        called = true;
        return { available: false, reason: "不可用" };
      },
    });
    await expect(
      rpc.call(ACTOR, [{ kind: "camera" }], CONTEXT),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
