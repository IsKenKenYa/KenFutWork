import {
  EMPTY_PERMISSION_POLICY,
  type PermissionPolicy,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import {
  createPermissionService,
  isDangerousCall,
  isDangerousTool,
  type PermissionService,
} from "./permission-service.js";
import { DEFAULT_PERMISSION_SETTINGS } from "./tier-store.js";

describe("permissions 缝（DEC-4）", () => {
  it("不带调用绑定的 once 不再假装授权成功", () => {
    const service = createPermissionService();
    expect(() => service.approve("Write", { scope: "once" })).toThrow(/绑定/);
    expect(service.evaluate({ toolName: "Write" }).decision).toBe("deny");
  });

  it("真实 Code 写入与命令工具在 default 档等待审批", () => {
    const service = createPermissionService();
    for (const toolName of ["Write", "Edit", "ApplyPatch", "Bash"]) {
      expect(service.evaluate({ toolName }).decision, toolName).toBe("deny");
    }
  });

  it("安全工具在任意档位直接放行", () => {
    const svc = createPermissionService();
    expect(svc.evaluate({ toolName: "preview_file" }).decision).toBe("allow");
    expect(svc.evaluate({ toolName: "inspect_canvas" }).decision).toBe("allow");
  });

  it("default 档：危险工具未审批即拒绝（含理由）", () => {
    const svc = createPermissionService();
    const decision = svc.evaluate({ toolName: "mcp__fs__write" });
    expect(decision.decision).toBe("deny");
    // 理由必须说清**去哪批准**（模型据此转述给用户，含糊会让它编出「审批弹窗」）
    expect(decision.reason).toMatch(/设置 → 权限 → 工具审批/);
  });

  it("永久审批记忆放行；thread 记忆只影响该会话", () => {
    const svc = createPermissionService();
    svc.approve("mcp__fs__write", { scope: "thread", threadId: "t1" });
    expect(
      svc.evaluate({ toolName: "mcp__fs__write", threadId: "t1" }).decision,
    ).toBe("allow");
    expect(
      svc.evaluate({ toolName: "mcp__fs__write", threadId: "t2" }).decision,
    ).toBe("deny");
    svc.approve("execute", { scope: "forever" });
    expect(svc.evaluate({ toolName: "execute" }).decision).toBe("allow");
    expect(svc.listApprovedForever()).toEqual(["execute"]);
  });

  it("永久批准随 applySettings 恢复、随 getSettings 读出（重启持久化的内存侧契约）", () => {
    // 启动期读回：持久化里带着上次的永久批准，服务一建好就生效
    const restored = createPermissionService();
    restored.applySettings({
      tier: "default",
      automationTier: "default",
      rules: { allow: [], deny: [] },
      policy: EMPTY_PERMISSION_POLICY,
      approvedForever: ["execute", "mcp__py__run"],
      browserControlEnabled: false,
      browserAutoScreenshot: false,
      browserHeadless: false,
      browserDevtoolsReadEnabled: true,
      browserEvalEnabled: false,
    });
    expect(restored.listApprovedForever()).toEqual(["execute", "mcp__py__run"]);
    expect(restored.evaluate({ toolName: "execute" }).decision).toBe("allow");

    // 读回后再增补：getSettings 里的 approvedForever 同步增长（写穿存储的数据源）
    restored.approve("write_file", { scope: "forever" });
    expect(restored.getSettings().approvedForever).toEqual([
      "execute",
      "mcp__py__run",
      "write_file",
    ]);
    expect(restored.evaluate({ toolName: "write_file" }).decision).toBe(
      "allow",
    );

    // PUT tier 的合并路径：getSettings() 展开再 applySettings，批准清单不丢
    const merged = { ...restored.getSettings(), tier: "auto-approve" as const };
    restored.applySettings(merged);
    expect(restored.listApprovedForever()).toEqual([
      "execute",
      "mcp__py__run",
      "write_file",
    ]);
  });

  it("auto-approve 档自动放行危险工具；full-access 全放行；线程档位覆盖全局", () => {
    const svc = createPermissionService();
    svc.setTier(undefined, "auto-approve");
    expect(svc.evaluate({ toolName: "execute" }).decision).toBe("allow");
    svc.setTier("t1", "default");
    expect(svc.getTier("t1")).toBe("default");
    expect(svc.evaluate({ toolName: "execute", threadId: "t1" }).decision).toBe(
      "deny",
    );
    svc.setTier("t1", "full-access");
    expect(svc.evaluate({ toolName: "execute", threadId: "t1" }).decision).toBe(
      "allow",
    );
  });

  it("isDangerousTool 覆盖 shell/MCP/写类模式", () => {
    expect(isDangerousTool("LocalShell_execute")).toBe(true);
    expect(isDangerousTool("mcp__anything")).toBe(true);
    expect(isDangerousTool("execute")).toBe(true);
    expect(isDangerousTool("diff_patch")).toBe(true);
    expect(isDangerousTool("diff_files")).toBe(false);
    expect(isDangerousTool("generate_image")).toBe(false);
  });

  /**
   * 回归：模式表必须匹配**真实注册名**。
   * 曾经写成 `/^file_write$/`（错拼），而 deepagents 内置工具真实名是 `write_file`——
   * 于是默认档下「写文件需审批」静默失效，而当时的用例恰好也用了同一个错拼名，双双漏过。
   */
  it("deepagents 内置写工具按真实名进入审批（回归）", () => {
    expect(isDangerousTool("write_file")).toBe(true);
    expect(isDangerousTool("edit_file")).toBe(true);
  });

  /**
   * 回归：插件工具名（mihome_control / ha_control…）不进名表，只按名字判会**静默放行
   * 设备写入**。判据因此纳入属主声明的执行效果（内核随 tool-pre-execute 带来）。
   */
  it("属主声明的非只读效果进默认档审批：插件写工具不再静默放行", () => {
    const svc = createPermissionService();

    // 声明只读：放行（设备/实体查询不该拦）
    expect(
      svc.evaluate({ toolName: "ha_entities", access: "read" }).decision,
    ).toBe("allow");

    for (const access of ["write", "execute"] as const) {
      const decision = svc.evaluate({ toolName: "ha_control", access });
      expect(decision.decision, access).toBe("deny");
      expect(decision.reason).toContain("危险");
    }

    // 审批记忆按工具名生效：永久批准后放行，且立刻对新会话有效
    svc.approve("ha_control", { scope: "forever" });
    expect(
      svc.evaluate({ toolName: "ha_control", access: "write" }).decision,
    ).toBe("allow");

    // 未声明（旧工具/无属主信息的调用点）维持按名字判，行为不变
    expect(svc.evaluate({ toolName: "ha_control" }).decision).toBe("allow");
    // 只读声明不能豁免名表命中的工具（声明不能掩盖已确认的危险效果）
    expect(
      svc.evaluate({ toolName: "mcp__anything", access: "read" }).decision,
    ).toBe("deny");
  });

  it("isDangerousCall：名表或非只读声明任一命中即危险", () => {
    expect(
      isDangerousCall({ toolName: "mihome_control", access: "write" }),
    ).toBe(true);
    expect(isDangerousCall({ toolName: "unknown_plugin_tool" })).toBe(false);
    expect(
      isDangerousCall({ toolName: "unknown_plugin_tool", access: "execute" }),
    ).toBe(true);
    expect(isDangerousCall({ toolName: "ha_entities", access: "read" })).toBe(
      false,
    );
    expect(isDangerousCall({ toolName: "mcp__x", access: "read" })).toBe(true);
  });
});

/**
 * R5-3：第 4 档「自定义」与分场景档位（常规 / 自动化）。
 * 规则判定顺序固定为 **deny → allow → default 兜底**，且这几条是安全边界，逐条锁死。
 */
describe("permissions 缝（R5-3 自定义档与分场景）", () => {
  it("custom 档：拒绝项命中即拒（拒绝优先于放行），放行项命中即放", () => {
    const svc = createPermissionService();
    svc.applySettings({
      tier: "custom",
      automationTier: "default",
      rules: {
        allow: ["write_file", "mcp__py-helper__echo"],
        deny: ["mcp__py-helper__add"],
      },
      policy: EMPTY_PERMISSION_POLICY,
      browserControlEnabled: false,
      browserAutoScreenshot: false,
      browserHeadless: false,
      approvedForever: [],
      browserDevtoolsReadEnabled: false,
      browserEvalEnabled: false,
    });
    // 放行项：危险工具（write_file）也放行
    expect(svc.evaluate({ toolName: "write_file" }).decision).toBe("allow");
    // 拒绝项：即便同一个前缀也被拒
    const denied = svc.evaluate({ toolName: "mcp__py-helper__add" });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toMatch(/自定义规则/);
    // 都没命中 → 回落 default：危险工具要审批
    expect(svc.evaluate({ toolName: "execute" }).decision).toBe("deny");
    // 安全工具照旧放行
    expect(svc.evaluate({ toolName: "preview_file" }).decision).toBe("allow");
  });

  it("通配：`mcp__*` 命中所有 MCP 工具，但不命中普通工具", () => {
    const svc = createPermissionService();
    svc.applySettings({
      tier: "custom",
      automationTier: "default",
      rules: { allow: [], deny: ["mcp__*"] },
      policy: EMPTY_PERMISSION_POLICY,
      browserControlEnabled: false,
      browserAutoScreenshot: false,
      browserHeadless: false,
      approvedForever: [],
      browserDevtoolsReadEnabled: false,
      browserEvalEnabled: false,
    });
    expect(svc.evaluate({ toolName: "mcp__fs__write" }).decision).toBe("deny");
    expect(svc.evaluate({ toolName: "mcp__py-helper__echo" }).decision).toBe(
      "deny",
    );
    // 普通工具不受这条规则影响（execute 仍走 default 的审批要求）
    expect(svc.evaluate({ toolName: "execute" }).reason).toMatch(
      /设置 → 权限 → 工具审批/,
    );
  });

  it("分场景：自动化任务（目标/循环）用 automationTier，不受常规档影响", () => {
    const svc = createPermissionService();
    svc.applySettings({
      tier: "full-access",
      automationTier: "default",
      rules: { allow: [], deny: [] },
      policy: EMPTY_PERMISSION_POLICY,
      browserControlEnabled: false,
      browserAutoScreenshot: false,
      browserHeadless: false,
      approvedForever: [],
      browserDevtoolsReadEnabled: false,
      browserEvalEnabled: false,
    });
    // 常规：全放行
    expect(
      svc.evaluate({ toolName: "write_file", scenario: "interactive" })
        .decision,
    ).toBe("allow");
    // 自动化：仍按 default 要求审批（无人值守时更严）
    expect(
      svc.evaluate({ toolName: "write_file", scenario: "automation" }).decision,
    ).toBe("deny");
    // 反过来：自动化放开、常规收紧，同样各按各的
    svc.applySettings({
      tier: "default",
      automationTier: "auto-approve",
      rules: { allow: [], deny: [] },
      policy: EMPTY_PERMISSION_POLICY,
      browserControlEnabled: false,
      browserAutoScreenshot: false,
      browserHeadless: false,
      approvedForever: [],
      browserDevtoolsReadEnabled: false,
      browserEvalEnabled: false,
    });
    expect(
      svc.evaluate({ toolName: "write_file", scenario: "automation" }).decision,
    ).toBe("allow");
    expect(
      svc.evaluate({ toolName: "write_file", scenario: "interactive" })
        .decision,
    ).toBe("deny");
  });

  it("线程显式设过的档位优先于场景档（会话级覆盖）", () => {
    const svc = createPermissionService();
    svc.applySettings({
      tier: "default",
      automationTier: "default",
      rules: { allow: [], deny: [] },
      policy: EMPTY_PERMISSION_POLICY,
      browserControlEnabled: false,
      browserAutoScreenshot: false,
      browserHeadless: false,
      approvedForever: [],
      browserDevtoolsReadEnabled: false,
      browserEvalEnabled: false,
    });
    svc.setTier("t1", "full-access");
    expect(
      svc.evaluate({
        toolName: "execute",
        threadId: "t1",
        scenario: "automation",
      }).decision,
    ).toBe("allow");
  });
});

describe("工具策略：三态规则与禁用清单", () => {
  const withPolicy = (
    policy: Partial<PermissionPolicy>,
    tier: "default" | "full-access" = "default",
  ) => {
    const svc = createPermissionService();
    svc.applySettings({
      ...DEFAULT_PERMISSION_SETTINGS,
      tier,
      policy: { ...EMPTY_PERMISSION_POLICY, ...policy },
    });
    return svc;
  };

  it("禁用清单是硬拒绝：完全访问档也拦，且不给审批机会", () => {
    const svc = withPolicy(
      { rules: [], disabledTools: ["shell_*"] },
      "full-access",
    );
    const decision = svc.evaluate({ toolName: "shell_exec" });
    expect(decision.decision).toBe("deny");
    expect(decision.blocked).toBe(true);
  });

  it("三态 deny 是硬拒绝，ask 只阻断但不带 blocked（照常弹审批）", () => {
    const denied = withPolicy({
      rules: [{ pattern: "mcp__*", action: "deny" }],
      disabledTools: [],
    }).evaluate({ toolName: "mcp__fs__write" });
    expect(denied.decision).toBe("deny");
    expect(denied.blocked).toBe(true);

    const asked = withPolicy({
      rules: [{ pattern: "execute", action: "ask" }],
      disabledTools: [],
    }).evaluate({ toolName: "execute" });
    expect(asked.decision).toBe("deny");
    expect(asked.blocked).toBeUndefined();
  });

  it("三态 allow 直接放行，不看档位", () => {
    const svc = withPolicy({
      rules: [{ pattern: "write_file", action: "allow" }],
      disabledTools: [],
    });
    expect(svc.evaluate({ toolName: "write_file" }).decision).toBe("allow");
  });

  it("规则按表内顺序取第一条命中", () => {
    const svc = withPolicy({
      rules: [
        { pattern: "mcp__fs__*", action: "allow" },
        { pattern: "mcp__*", action: "deny" },
      ],
      disabledTools: [],
    });
    expect(svc.evaluate({ toolName: "mcp__fs__write" }).decision).toBe("allow");
    expect(svc.evaluate({ toolName: "mcp__other__run" }).decision).toBe("deny");
  });

  it("策略未命中时回落档位判定，行为与改造前一致", () => {
    const svc = withPolicy({ rules: [], disabledTools: [] });
    // default 档下危险工具仍需审批（deny 但非 blocked）
    const decision = svc.evaluate({ toolName: "write_file" });
    expect(decision.decision).toBe("deny");
    expect(decision.blocked).toBeUndefined();
  });

  it("checkToolPolicy 只报策略命中，未命中返回 undefined", () => {
    const svc = withPolicy({
      rules: [{ pattern: "execute", action: "deny" }],
      disabledTools: ["shell_*"],
    });
    expect(svc.checkToolPolicy("execute")?.blocked).toBe(true);
    expect(svc.checkToolPolicy("shell_exec")?.blocked).toBe(true);
    expect(svc.checkToolPolicy("read_file")).toBeUndefined();
  });

  it("路径规则按前缀判：规则目录及其下层命中，同前缀的邻居目录不命中", () => {
    const svc = withPolicy({
      pathRules: [{ path: "/repo/app", action: "deny" }],
    });
    const write = (filePath: string) =>
      svc.evaluate({ toolName: "write_file", args: { file_path: filePath } });

    expect(write("/repo/app").blocked).toBe(true);
    expect(write("/repo/app/src/index.ts").blocked).toBe(true);
    // `/repo/app-old` 与 `/repo/app` 是邻居，前缀相同但不是同一棵树
    expect(write("/repo/app-old/x.ts").blocked).toBeUndefined();
    // 规则外的路径不受影响，回落档位（default 档写文件需审批）
    const outside = write("/repo/other/x.ts");
    expect(outside.decision).toBe("deny");
    expect(outside.blocked).toBeUndefined();
  });

  it("路径规则两种分隔符与小写都认（Windows 路径大小写不敏感）", () => {
    const svc = withPolicy({
      pathRules: [{ path: "C:\\Users\\me\\secrets", action: "deny" }],
    });
    expect(
      svc.evaluate({
        toolName: "write_file",
        args: { path: "c:/users/ME/secrets/token.txt" },
      }).blocked,
    ).toBe(true);
  });

  it("命令规则按前缀判；未带命令参数的工具不受命令规则影响", () => {
    const svc = withPolicy({
      commandRules: [{ prefix: "rm -rf", action: "deny" }],
    });
    expect(
      svc.evaluate({ toolName: "execute", args: { command: "rm -rf /data" } })
        .blocked,
    ).toBe(true);
    // 同前缀但更短/更长都不该命中
    expect(
      svc.evaluate({ toolName: "execute", args: { command: "rm -r x" } })
        .blocked,
    ).toBeUndefined();
    // 写文件没有 command 字段 → 命令规则不参与判定
    expect(
      svc.evaluate({ toolName: "write_file", args: { file_path: "a.txt" } })
        .blocked,
    ).toBeUndefined();
  });

  it("路径/命令的 allow 规则可越过档位，但硬拒绝仍然优先", () => {
    const svc = withPolicy({
      pathRules: [{ path: "/repo/app", action: "allow" }],
      commandRules: [{ prefix: "rm -rf", action: "deny" }],
    });
    expect(
      svc.evaluate({
        toolName: "write_file",
        args: { file_path: "/repo/app/x.ts" },
      }).decision,
    ).toBe("allow");
    expect(
      svc.evaluate({ toolName: "execute", args: { command: "rm -rf /" } })
        .blocked,
    ).toBe(true);
  });

  it("工具规则先于路径/命令规则命中", () => {
    const svc = withPolicy({
      rules: [{ pattern: "execute", action: "allow" }],
      commandRules: [{ prefix: "rm -rf", action: "deny" }],
    });
    expect(
      svc.evaluate({ toolName: "execute", args: { command: "rm -rf /" } })
        .decision,
    ).toBe("allow");
  });

  it("域名规则拦下指定站点，allow 规则可越过档位", () => {
    const svc = withPolicy(
      {
        domainRules: [
          { domain: "*.internal.example", action: "deny" },
          { domain: "docs.example.com", action: "allow" },
        ],
      },
      "default",
    );

    // 工具门：browser_open 带 url，按域名判
    const denied = svc.evaluate({
      toolName: "browser_open",
      args: { url: "https://secret.internal.example/wiki" },
    });
    expect(denied.decision).toBe("deny");
    expect(denied.blocked).toBe(true);

    // 放行域名在默认档也放行（策略先于档位）
    expect(
      svc.evaluate({
        toolName: "browser_open",
        args: { url: "https://docs.example.com/guide" },
      }).decision,
    ).toBe("allow");

    // 未命中规则的地址按档位判（默认档下 browser_open 走浏览器控制门，不看这里）
    expect(
      svc.evaluate({
        toolName: "browser_open",
        args: { url: "https://elsewhere.example.org" },
      }).blocked,
    ).toBeUndefined();
  });

  it("checkUrlPolicy 只报域名命中；非 http(s) 与解析不出的地址不参与", () => {
    const svc = withPolicy({
      domainRules: [{ domain: "example.com", action: "deny" }],
    });
    expect(svc.checkUrlPolicy("https://example.com/x")?.blocked).toBe(true);
    expect(svc.checkUrlPolicy("https://sub.example.com/x")?.blocked).toBe(true);
    expect(svc.checkUrlPolicy("https://other.com")).toBeUndefined();
    expect(svc.checkUrlPolicy("file:///C:/x")).toBeUndefined();
    expect(svc.checkUrlPolicy("不是地址")).toBeUndefined();
  });

  it("域名「询问」不硬拦，交给审批链路", () => {
    const svc = withPolicy({
      domainRules: [{ domain: "example.com", action: "ask" }],
    });
    const decision = svc.checkUrlPolicy("https://example.com");
    expect(decision?.decision).toBe("deny");
    expect(decision?.blocked).toBeUndefined();
  });
});

describe("审计中心：判定流水", () => {
  const withSink = (policy: Partial<PermissionPolicy> = {}) => {
    const records: Parameters<
      NonNullable<Parameters<PermissionService["setAuditSink"]>[0]>
    >[0][] = [];
    const svc = createPermissionService();
    svc.applySettings({
      ...DEFAULT_PERMISSION_SETTINGS,
      policy: { ...EMPTY_PERMISSION_POLICY, ...policy },
    });
    svc.setAuditSink((record) => records.push(record));
    return { svc, records };
  };

  it("工具门每条结论都记：放行与拦截都在，且带命中来源", () => {
    const { svc, records } = withSink({
      rules: [{ pattern: "blocked_tool", action: "deny" }],
    });
    svc.evaluate({ toolName: "preview_file" });
    svc.evaluate({ toolName: "blocked_tool" });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      toolName: "preview_file",
      decision: "allow",
      blocked: false,
    });
    expect(records[1]).toMatchObject({
      toolName: "blocked_tool",
      decision: "deny",
      source: "tool-rule",
      blocked: true,
    });
  });

  it("审批入口只在命中策略时记一条（未命中留给档位判定，不重复记）", () => {
    const { svc, records } = withSink({
      disabledTools: ["shell_*"],
    });
    expect(svc.checkToolPolicy("read_file")).toBeUndefined();
    expect(records).toHaveLength(0);

    svc.checkToolPolicy("shell_exec");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: "disabled", blocked: true });
  });

  it("不记工具参数与命令原文（只记命中的规则，理由可定位）", () => {
    const { svc, records } = withSink({
      pathRules: [{ path: "/secret", action: "deny" }],
      commandRules: [{ prefix: "curl -H Authorization", action: "deny" }],
    });
    svc.evaluate({
      toolName: "write_file",
      args: { file_path: "/secret/token.txt", content: "top-secret-value" },
    });
    svc.evaluate({
      toolName: "execute",
      args: { command: "curl -H Authorization: Bearer sk-live-123 https://x" },
    });

    const serialized = JSON.stringify(records);
    // 内容与凭据一个字都不落库
    expect(serialized).not.toContain("top-secret-value");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("sk-live-123");
    // 也不记被操作的路径/命令原文
    expect(serialized).not.toContain("token.txt");
    // 理由指向**命中的规则**，用户据此能定位是哪条配错了
    expect(records[0]).toMatchObject({ source: "path-rule", blocked: true });
    expect(records[0]?.reason).toContain("/secret");
    expect(records[1]).toMatchObject({ source: "command-rule", blocked: true });
    expect(records[1]?.reason).toContain("curl -H Authorization");
  });

  it("记录器抛错不影响判定（审计是旁路）", () => {
    const svc = createPermissionService();
    svc.applySettings({
      ...DEFAULT_PERMISSION_SETTINGS,
      policy: {
        ...EMPTY_PERMISSION_POLICY,
        rules: [{ pattern: "blocked_tool", action: "deny" }],
      },
    });
    svc.setAuditSink(() => {
      throw new Error("落库失败");
    });
    expect(svc.evaluate({ toolName: "blocked_tool" }).blocked).toBe(true);
    expect(svc.evaluate({ toolName: "preview_file" }).decision).toBe("allow");
  });

  it("摘掉记录器后不再记流水", () => {
    const { svc, records } = withSink();
    svc.setAuditSink(null);
    svc.evaluate({ toolName: "preview_file" });
    expect(records).toHaveLength(0);
  });
});
