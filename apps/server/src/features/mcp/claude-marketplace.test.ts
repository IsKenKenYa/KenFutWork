// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 断言对象就是含 `${VAR}` 的原始声明文本
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_OFFICIAL_MARKETPLACE,
  ClaudeMarketplaceError,
  compileMarketplaceServer,
  instantiateMarketplaceServer,
  parseMarketplaceFile,
  pluginFileUrl,
  readPluginDefinitions,
  resolvePluginLocation,
} from "./claude-marketplace.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 2026-11-27 的官方市场清单快照（317 个插件）。 */
function realMarketplaceText(): string {
  return readFileSync(
    join(HERE, "fixtures", "claude-marketplace-2026-11-27.json"),
    "utf8",
  );
}

function realMarketplace() {
  return parseMarketplaceFile(realMarketplaceText());
}

/** 按名字取一个真实插件（清单结构变了会直接报错，提示夹具过期）。 */
function pluginNamed(name: string) {
  const plugin = realMarketplace().plugins.find((entry) => entry.name === name);
  if (!plugin) throw new Error(`夹具里没有插件 ${name}`);
  return plugin;
}

describe("市场清单解析", () => {
  it("真实清单解析出 317 个插件与作者", () => {
    const marketplace = realMarketplace();
    expect(marketplace.name).toBe("claude-plugins-official");
    expect(marketplace.owner).toBe("Anthropic");
    expect(marketplace.plugins).toHaveLength(317);
    expect(marketplace.plugins.map((plugin) => plugin.name)).toContain(
      "github",
    );
    // 描述与分类原样带出；displayName 优先作标题
    const adobe = pluginNamed("adobe-for-creativity");
    expect(adobe.title).toBe("adobe-for-creativity");
    expect(adobe.category).toBe("design");
    expect(adobe.author).toBe("Adobe");
    const convex = pluginNamed("convex");
    expect(convex.title).toBe("Convex");
  });

  it("格式不对时给可读原因，不是静默空列表", () => {
    expect(() => parseMarketplaceFile("不是 JSON")).toThrow(
      ClaudeMarketplaceError,
    );
    expect(() => parseMarketplaceFile("{}")).toThrow(/格式不对/);
    expect(() => parseMarketplaceFile('{"name":"m","plugins":{}}')).toThrow(
      /格式不对/,
    );
  });
});

describe("插件来源换算", () => {
  it("相对路径插件从官方市场仓库读，目录去掉 ./", () => {
    expect(resolvePluginLocation(pluginNamed("github"))).toEqual({
      kind: "located",
      location: {
        ...CLAUDE_OFFICIAL_MARKETPLACE.repository,
        subdir: "external_plugins/github",
      },
    });
  });

  it("url 来源按固定提交号读，不是用分支（清单里是 sha）", () => {
    const resolved = resolvePluginLocation(pluginNamed("convex"));
    expect(resolved).toEqual({
      kind: "located",
      location: {
        owner: "get-convex",
        repo: "convex-backend-skill",
        ref: "6ca54f6e2e7582812187b8a5a4783fb4dff52692",
        subdir: "",
      },
    });
  });

  it("git-subdir 来源带 path 与 ref", () => {
    const resolved = resolvePluginLocation(
      pluginNamed("42crunch-api-security-testing"),
    );
    expect(resolved).toMatchObject({
      kind: "located",
      location: {
        owner: "42Crunch-AI",
        repo: "claude-plugins",
        subdir: "plugins/api-security-testing",
      },
    });
  });

  it("构建命令来源没有可读目录，不算失败", () => {
    const resolved = resolvePluginLocation({
      ...pluginNamed("github"),
      source: { source: "command", command: "build-plugin" },
    });
    expect(resolved).toEqual({ kind: "noFiles" });
  });

  it("非 GitHub、缺版本、路径越界都按失败给原因", () => {
    const base = pluginNamed("github");
    expect(
      resolvePluginLocation({
        ...base,
        source: {
          source: "url",
          url: "https://gitlab.com/a/b.git",
          sha: "abc",
        },
      }),
    ).toEqual({ kind: "failed", reason: "插件来源不是 GitHub 公开仓库。" });
    expect(
      resolvePluginLocation({
        ...base,
        source: { source: "url", url: "https://github.com/a/b.git" },
      }),
    ).toEqual({ kind: "failed", reason: "插件来源没有固定版本。" });
    expect(
      resolvePluginLocation({
        ...base,
        source: {
          source: "git-subdir",
          url: "https://github.com/a/b.git",
          sha: "abc",
          path: "../escape",
        },
      }),
    ).toEqual({ kind: "failed", reason: "插件路径不合法。" });
    expect(resolvePluginLocation({ ...base, source: "./../../etc" })).toEqual({
      kind: "failed",
      reason: "插件路径不合法。",
    });
  });

  it("文件地址按 仓库/固定版本/子目录 拼接", () => {
    expect(
      pluginFileUrl(
        "https://raw.githubusercontent.com",
        { owner: "o", repo: "r", ref: "sha1", subdir: "plugins/x" },
        ".mcp.json",
      ),
    ).toBe("https://raw.githubusercontent.com/o/r/sha1/plugins/x/.mcp.json");
  });
});

describe("插件定义读取", () => {
  /** 用内存里的文件替身扮演一个插件目录。 */
  function pluginFiles(files: Record<string, string>) {
    return {
      readFile: async (relativePath: string) => files[relativePath] ?? null,
    };
  }

  it("只有 .mcp.json：逐条读出服务", async () => {
    const result = await readPluginDefinitions(
      pluginFiles({
        ".mcp.json": JSON.stringify({
          mcpServers: {
            neon: { type: "http", url: "https://mcp.neon.tech/mcp" },
            local: { command: "npx", args: ["-y", "x"] },
          },
        }),
      }),
    );
    expect(result.servers.map((server) => server.name)).toEqual([
      "neon",
      "local",
    ]);
  });

  it("plugin.json 内联声明覆盖同名服务（与 Claude Code 同一顺序）", async () => {
    const result = await readPluginDefinitions(
      pluginFiles({
        ".mcp.json": JSON.stringify({
          mcpServers: {
            server: { type: "http", url: "https://old/mcp" },
            onlyFile: { command: "a" },
          },
        }),
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "p",
          mcpServers: { server: { type: "http", url: "https://new/mcp" } },
        }),
      }),
    );
    expect(result.servers).toHaveLength(2);
    expect(
      result.servers.find((entry) => entry.name === "server")?.spec,
    ).toEqual({ type: "http", url: "https://new/mcp" });
  });

  it("plugin.json 里写文件路径的声明会再追一跳读取", async () => {
    const result = await readPluginDefinitions(
      pluginFiles({
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "supabase",
          mcpServers: "./agents/claude/.mcp.json",
        }),
        "agents/claude/.mcp.json": JSON.stringify({
          mcpServers: {
            supabase: {
              type: "http",
              url: "https://mcp.supabase.com/mcp",
              headers: { "X-Source-Name": "claude-code-plugin" },
            },
          },
        }),
      }),
    );
    expect(result.servers.map((server) => server.name)).toEqual(["supabase"]);
  });

  it("路径声明越界、文件缺失、内容不是 JSON 都给可读原因", async () => {
    const manifestOnly = (mcpServers: unknown) =>
      pluginFiles({
        ".claude-plugin/plugin.json": JSON.stringify({ name: "p", mcpServers }),
      });
    await expect(
      readPluginDefinitions(manifestOnly("/etc/passwd")),
    ).rejects.toThrow(/路径不合法/);
    await expect(
      readPluginDefinitions(manifestOnly("./missing.json")),
    ).rejects.toThrow(/文件不存在/);
    await expect(
      readPluginDefinitions(
        pluginFiles({
          ".mcp.json": "{不是 JSON",
        }),
      ),
    ).rejects.toThrow(/不是合法 JSON/);
  });

  it("读 userConfig 的填写提示", async () => {
    const result = await readPluginDefinitions(
      pluginFiles({
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "grafana-mcp",
          mcpServers: {
            grafana: {
              type: "http",
              url: "${user_config.grafana_url}/mcp",
              headers: {
                Authorization:
                  "Bearer ${user_config.grafana_service_account_token}",
              },
            },
          },
          userConfig: {
            grafana_url: {
              title: "Grafana instance URL",
              description: "Your Grafana instance URL.",
              required: true,
            },
            grafana_service_account_token: {
              title: "Grafana service account token",
              required: true,
              sensitive: true,
            },
          },
        }),
      }),
    );
    expect(result.userConfig.grafana_url?.title).toBe("Grafana instance URL");
    expect(result.userConfig.grafana_service_account_token?.sensitive).toBe(
      true,
    );
  });
});

describe("服务定义换算", () => {
  const plugin = pluginNamed("convex");

  function compile(spec: unknown, userConfig = {}) {
    return compileMarketplaceServer({
      definition: { name: "server", spec },
      plugin,
      userConfig,
    });
  }

  it("http 与 streamable-http 都换算成本地 http 类型", () => {
    expect(compile({ type: "http", url: "https://a/mcp" })?.view.kind).toBe(
      "http",
    );
    expect(
      compile({ type: "streamable-http", url: "https://a/mcp" })?.view.kind,
    ).toBe("http");
    // sse 走 http 类型（本项目先试 Streamable HTTP，再退 SSE）
    expect(compile({ type: "sse", url: "https://a/sse" })?.view.kind).toBe(
      "http",
    );
  });

  it("没写类型：有启动命令就是本地服务，否则看地址", () => {
    expect(compile({ command: "npx", args: ["-y", "x"] })?.view.kind).toBe(
      "stdio",
    );
    expect(compile({ url: "https://a/mcp" })?.view.kind).toBe("http");
  });

  it("带变量时报出要填的字段：user_config 用插件里的标题与说明", () => {
    const compiled = compile(
      {
        type: "http",
        url: "${user_config.base_url}/mcp",
        headers: { Authorization: "Bearer ${user_config.token}" },
      },
      {
        base_url: {
          title: "服务地址",
          description: "填你的地址",
          required: true,
          sensitive: false,
          default: null,
        },
        token: {
          title: "访问令牌",
          description: null,
          required: true,
          sensitive: true,
          default: null,
        },
      },
    );
    expect(compiled?.view.addable).toBe(true);
    expect(compiled?.view.inputs).toEqual([
      {
        name: "user_config.base_url",
        label: "服务地址",
        description: "填你的地址",
        required: true,
        secret: false,
        default: null,
      },
      {
        name: "user_config.token",
        label: "访问令牌",
        description: null,
        required: true,
        secret: true,
        default: null,
      },
    ]);
  });

  it("环境变量占位符按名字兜底提示；名字像密钥按密码框", () => {
    const compiled = compile({
      command: "uvx",
      args: ["srv"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", REGION: "${REGION:-us-east-1}" },
    });
    const inputs = compiled?.view.inputs ?? [];
    expect(inputs.map((input) => input.name)).toEqual([
      "GITHUB_TOKEN",
      "REGION",
    ]);
    expect(inputs[0]?.secret).toBe(true);
    expect(inputs[0]?.required).toBe(true);
    expect(inputs[1]?.default).toBe("us-east-1");
    expect(inputs[1]?.required).toBe(false);
  });

  it("依赖 Claude 插件目录、要登录授权、要脚本生成头的服务标出原因", () => {
    expect(
      compile({
        type: "stdio",
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/x.js"],
      })?.view,
    ).toMatchObject({
      addable: false,
      unsupportedReason: "依赖 Claude 插件目录里的文件",
    });
    expect(
      compile({ type: "http", url: "https://a/mcp", oauth: { clientId: "x" } })
        ?.view,
    ).toMatchObject({
      addable: false,
      unsupportedReason: "要登录授权才能连接",
    });
    expect(
      compile({
        type: "http",
        url: "https://a/mcp",
        headersHelper: "gen",
      })?.view,
    ).toMatchObject({
      addable: false,
      unsupportedReason: "要运行脚本生成请求头",
    });
  });

  it("缺命令、缺地址、类型不支持、定义不是对象都给原因而不是静默丢弃", () => {
    expect(compile({ type: "stdio" })?.view).toMatchObject({
      addable: false,
      unsupportedReason: "缺少启动命令",
    });
    expect(compile({ type: "http" })?.view).toMatchObject({
      addable: false,
      unsupportedReason: "缺少服务地址",
    });
    expect(compile({ type: "ws", url: "wss://a" })?.view).toMatchObject({
      addable: false,
      unsupportedReason: "不支持的服务类型（ws）",
    });
    expect(compile("不是对象")?.view).toMatchObject({
      addable: false,
      unsupportedReason: "服务定义不是对象",
    });
  });

  it("disabled 的服务不列出（Claude Code 也不启动）", () => {
    expect(compile({ command: "uvx", args: ["x"], disabled: true })).toBeNull();
  });

  it("建议的服务名只留字母数字与下划线横线", () => {
    const compiled = compileMarketplaceServer({
      definition: { name: "RevenueCat Mirror", spec: { url: "https://a" } },
      plugin,
      userConfig: {},
    });
    expect(compiled?.view.suggestedName).toBe("RevenueCat-Mirror");
  });
});

describe("按填写值生成新建请求", () => {
  const plugin = pluginNamed("convex");
  function compiled() {
    const entry = compileMarketplaceServer({
      definition: {
        name: "srv",
        spec: {
          type: "http",
          url: "${user_config.base}/mcp",
          headers: { Authorization: "Bearer ${user_config.token}" },
        },
      },
      plugin,
      userConfig: {
        base: {
          title: "地址",
          description: null,
          required: true,
          sensitive: false,
          default: null,
        },
        token: {
          title: "令牌",
          description: null,
          required: true,
          sensitive: true,
          default: null,
        },
      },
    });
    if (!entry) throw new Error("样例应可添加");
    return entry;
  }

  it("变量按填写值替换，穿过与表单相同的校验", () => {
    const raw = instantiateMarketplaceServer(compiled(), {
      id: "convex:srv",
      name: "my-srv",
      values: {
        "user_config.base": "https://example.com",
        "user_config.token": "secret-token",
      },
    });
    expect(raw).toEqual({
      name: "my-srv",
      kind: "http",
      command: undefined,
      args: [],
      url: "https://example.com/mcp",
      env: {},
      headers: { Authorization: "Bearer secret-token" },
      enabled: true,
    });
  });

  it("必填变量缺值时给「请填写 标题」", () => {
    expect(() =>
      instantiateMarketplaceServer(compiled(), {
        id: "convex:srv",
        name: "my-srv",
        values: { "user_config.base": "https://example.com" },
      }),
    ).toThrow(/请填写 令牌/);
  });

  it("写法不合法、名称不合法的请求被拒", () => {
    expect(() =>
      instantiateMarketplaceServer(compiled(), {
        id: "convex:srv",
        name: "带 空格",
        values: {
          "user_config.base": "https://example.com",
          "user_config.token": "t",
        },
      }),
    ).toThrow();
    expect(() =>
      instantiateMarketplaceServer(compiled(), {
        id: "convex:srv",
        name: "ok",
        values: {
          "user_config.base": "不是网址",
          "user_config.token": "t",
        },
      }),
    ).toThrow();
  });

  it("填写值里再写占位符不会被继续展开", () => {
    const raw = instantiateMarketplaceServer(compiled(), {
      id: "convex:srv",
      name: "my-srv",
      values: {
        "user_config.base": "https://example.com/${user_config.token}",
        "user_config.token": "t",
      },
    });
    expect(raw.url).toBe("https://example.com/${user_config.token}/mcp");
  });

  it("不可添加的服务给出原因", () => {
    const entry = compileMarketplaceServer({
      definition: {
        name: "srv",
        spec: { type: "http", url: "https://a/mcp", oauth: { clientId: "x" } },
      },
      plugin,
      userConfig: {},
    });
    if (!entry) throw new Error("样例应存在");
    expect(() =>
      instantiateMarketplaceServer(entry, {
        id: "convex:srv",
        name: "ok",
        values: {},
      }),
    ).toThrow(/要登录授权/);
  });
});

describe("真实清单全量换算（不联网）", () => {
  it("317 个插件都能算出「可读目录 / 没有文件 / 不可读」之一，没有静默跳过", () => {
    const marketplace = realMarketplace();
    const kinds = { located: 0, noFiles: 0, failed: 0 };
    const failed: Array<{ plugin: string; reason: string }> = [];
    for (const plugin of marketplace.plugins) {
      const resolved = resolvePluginLocation(plugin);
      kinds[resolved.kind] += 1;
      if (resolved.kind === "failed") {
        failed.push({ plugin: plugin.name, reason: resolved.reason });
      }
    }
    // 实测（2026-11-27 夹具）：316 个可读、1 个构建命令来源、0 个不可读
    expect(kinds.located).toBe(316);
    expect(kinds.noFiles).toBe(1);
    expect(kinds.failed).toBe(0);
  });
});
