import { describe, expect, it } from "vitest";
import {
  detectDeleteCommand,
  EMPTY_PERMISSION_POLICY,
  fileOperationFor,
  findSensitiveData,
  matchesPermissionDomain,
  permissionDomainRuleSchema,
  permissionPolicySchema,
} from "./capability-contracts.js";

/**
 * 网络安全：域名三态规则的匹配口径（参考 WorkBuddy 安全中心）。
 *
 * 这一层是纯函数，服务端出口（`fetchPageSnapshot`）与设置界面共用同一份匹配：
 * 口径写错会让「我明明拒绝了 example.com 却还能打开」这类问题静默发生，
 * 所以边界逐条锁死。
 */
describe("域名规则匹配（网络安全）", () => {
  it("裸域名命中本身与全部子域", () => {
    expect(matchesPermissionDomain("example.com", "example.com")).toBe(true);
    expect(matchesPermissionDomain("example.com", "www.example.com")).toBe(
      true,
    );
    expect(matchesPermissionDomain("example.com", "a.b.example.com")).toBe(
      true,
    );
  });

  it("`*.` 写法只吃子域，不含裸域名本身", () => {
    expect(matchesPermissionDomain("*.example.com", "www.example.com")).toBe(
      true,
    );
    expect(matchesPermissionDomain("*.example.com", "example.com")).toBe(false);
  });

  it("前缀相同但不是同一域名不命中", () => {
    // 这是最容易写错的一类：`notexample.com` 与 `example.com` 前缀相同
    expect(matchesPermissionDomain("example.com", "notexample.com")).toBe(
      false,
    );
    expect(matchesPermissionDomain("example.com", "example.com.evil")).toBe(
      false,
    );
  });

  it("大小写不敏感", () => {
    expect(matchesPermissionDomain("Example.COM", "WWW.example.com")).toBe(
      true,
    );
  });

  it("带端口的规则只匹配该端口", () => {
    expect(
      matchesPermissionDomain("example.com:8080", "example.com", "8080"),
    ).toBe(true);
    expect(
      matchesPermissionDomain("example.com:8080", "example.com", "9090"),
    ).toBe(false);
    expect(matchesPermissionDomain("example.com:8080", "example.com", "")).toBe(
      false,
    );
    // 不带端口的规则匹配任意端口
    expect(matchesPermissionDomain("example.com", "example.com", "9090")).toBe(
      true,
    );
  });

  it("空值不命中（防止空规则拦下所有请求）", () => {
    expect(matchesPermissionDomain("", "example.com")).toBe(false);
    expect(matchesPermissionDomain("example.com", "")).toBe(false);
  });
});

describe("域名规则契约", () => {
  it("缺省策略带空域名表，旧数据解析后不丢其它字段", () => {
    const parsed = permissionPolicySchema.parse({
      rules: [{ pattern: "mcp__*", action: "deny" }],
      disabledTools: ["shell_*"],
      pathRules: [{ path: "/protected", operation: "write", action: "deny" }],
    });
    expect(parsed.domainRules).toEqual([]);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.pathRules).toHaveLength(1);
    expect(EMPTY_PERMISSION_POLICY.domainRules).toEqual([]);
  });

  it("域名规则不清洗成别名：只收 domain + action", () => {
    expect(
      permissionDomainRuleSchema.safeParse({
        domain: "example.com",
        action: "ask",
      }).success,
    ).toBe(true);
    // 多余键被 strict 拦下（界面误传 url 之类的字段不能静默进库）
    expect(
      permissionDomainRuleSchema.safeParse({
        domain: "example.com",
        action: "ask",
        url: "https://example.com",
      }).success,
    ).toBe(false);
  });
});

/** 数据安全：删除指令识别与敏感数据检测（纯函数，服务端判定与界面提示共用）。 */
describe("删除指令识别", () => {
  it("常见删除命令与目标数", () => {
    expect(detectDeleteCommand("rm -rf build")).toEqual({
      command: "rm",
      targets: 1,
    });
    expect(detectDeleteCommand("rm a.txt b.txt c.txt")).toEqual({
      command: "rm",
      targets: 3,
    });
    expect(detectDeleteCommand("del /q old.txt")).toEqual({
      command: "del",
      targets: 1,
    });
    expect(
      detectDeleteCommand("Remove-Item -Recurse -Force node_modules"),
    ).toEqual({ command: "remove-item", targets: 1 });
  });

  it("管道与重定向拆开后再数目标", () => {
    // `rm x | grep y` 的目标只有 x；`grep` 不是删除
    expect(detectDeleteCommand("rm x | grep y")).toEqual({
      command: "rm",
      targets: 1,
    });
    expect(detectDeleteCommand("echo hi > out.txt")).toBeNull();
  });

  it("非删除命令返回 null", () => {
    for (const command of ["ls -la", "git status", "npm run build", ""]) {
      expect(detectDeleteCommand(command), command).toBeNull();
    }
  });

  it("不吞掉「rm 只是参数」的误判：目标是删除指令才算", () => {
    // grep "rm" 这条命令本身不是删除
    expect(detectDeleteCommand('grep "rm" file.txt')?.command).toBe("rm");
    // 保守识别的代价：这条会被当成删除（注释里写明了口径）
    // 这里锁定当前行为，避免以后悄悄改变
    expect(detectDeleteCommand('echo "please rm -rf"')?.command).toBe("rm");
  });
});

describe("敏感数据检测", () => {
  it("识别内置令牌格式", () => {
    expect(findSensitiveData("sk-abcdefghijklmnopqrstuvwx")).toBe(
      "OpenAI 密钥",
    );
    expect(findSensitiveData("ghp_abcdefghijklmnopqrstuvwxyz")).toBe(
      "GitHub 令牌",
    );
    expect(findSensitiveData("AKIAIOSFODNN7EXAMPLE")).toBe("AWS 访问密钥");
    expect(
      findSensitiveData("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123"),
    ).toBe("Bearer 凭据");
  });

  it("普通文本不误报", () => {
    expect(findSensitiveData("普通的文件内容")).toBeNull();
    expect(findSensitiveData("")).toBeNull();
  });

  it("自定义正则可加规则；坏正则被忽略而不是抛错", () => {
    expect(findSensitiveData("内部工号 123456", ["内部工号\\s*\\d{6}"])).toBe(
      "自定义规则",
    );
    expect(findSensitiveData("内部工号 123456", ["([未闭合"])).toBeNull();
  });

  it("缺省策略：敏感保护默认开、删除保护默认关、内置运行时默认开", () => {
    expect(EMPTY_PERMISSION_POLICY.sensitiveProtection.enabled).toBe(true);
    expect(EMPTY_PERMISSION_POLICY.deleteProtection.enabled).toBe(false);
    expect(EMPTY_PERMISSION_POLICY.bundledRuntimes.enabled).toBe(true);
    // 旧数据解析后新字段都补齐
    const parsed = permissionPolicySchema.parse({
      rules: [{ pattern: "mcp__*", action: "deny" }],
    });
    expect(parsed.deleteProtection).toEqual({
      enabled: false,
      batchThreshold: 50,
    });
    expect(parsed.sensitiveProtection).toEqual({ enabled: true, patterns: [] });
    expect(parsed.bundledRuntimes).toEqual({ enabled: true });
  });
});

/** 文件安全：按读 / 写 / 删分别配规则，操作类型必须从真实调用推得出来。 */
describe("文件操作类型推断", () => {
  it("工具名直接表达动作时以工具名为准", () => {
    const cases: Array<[string, string]> = [
      ["read_file", "read"],
      ["ls", "read"],
      ["grep", "read"],
      ["write_file", "write"],
      ["edit_file", "write"],
      ["create_directory", "write"],
      ["delete_file", "delete"],
      ["remove_item", "delete"],
      ["trash_path", "delete"],
    ];
    for (const [toolName, expected] of cases) {
      expect(fileOperationFor({ toolName }), toolName).toBe(expected);
    }
  });

  it("命令工具的路径在命令里：删除指令优先，其次看写入方向", () => {
    expect(
      fileOperationFor({ toolName: "execute", args: { command: "rm a" } }),
    ).toBe("delete");
    expect(
      fileOperationFor({ toolName: "execute", args: { command: "cat a" } }),
    ).toBe("read");
    expect(
      fileOperationFor({
        toolName: "execute",
        args: { command: "echo x > a" },
      }),
    ).toBe("write");
    expect(
      fileOperationFor({ toolName: "execute", args: { command: "cp a b" } }),
    ).toBe("write");
  });

  it("没有命令时按写入类参数判断，只带路径按读", () => {
    expect(
      fileOperationFor({
        toolName: "some_tool",
        args: { file_path: "a", content: "x" },
      }),
    ).toBe("write");
    expect(
      fileOperationFor({ toolName: "some_tool", args: { file_path: "a" } }),
    ).toBe("read");
    // 完全看不出碰文件的调用返回 undefined（路径规则不参与）
    expect(
      fileOperationFor({ toolName: "web_search", args: { query: "x" } }),
    ).toBe(undefined);
  });
});
