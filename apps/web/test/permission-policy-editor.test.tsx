// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServiceProvider } from "@zui/hooks/useServices";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { PermissionTierSection } from "../src/components/workbench/zcode/host/PermissionTierControl";
import { codeHostNotificationResponse } from "./setup/code-host-http";

// jsdom 没有布局，Base UI 的 Select 滚动选中项时会调用 scrollIntoView。
if (!Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value() {},
  });
}

/**
 * 权限页规则编辑器：工具 / 路径 / 命令三张表与禁用清单。
 *
 * 这些字段是服务端 `permissionPolicySchema` 的界面入口——判定本身由
 * `permission-service.test.ts` 锁死，这里只证明界面读得回、存得出、空白不落库。
 */

type RuleAction = "allow" | "ask" | "deny";
/** 「规则与放行」卡片提交的策略形状（不含内置运行时——那属于沙箱安全卡片）。 */
type PolicyDraft = {
  rules: Array<{ pattern: string; action: RuleAction }>;
  disabledTools: string[];
  pathRules: Array<{ path: string; action: RuleAction }>;
  commandRules: Array<{ prefix: string; action: RuleAction }>;
  domainRules: Array<{ domain: string; action: RuleAction }>;
  deleteProtection: { enabled: boolean; batchThreshold: number };
  sensitiveProtection: { enabled: boolean; patterns: string[] };
};
/** 服务端读回的完整策略：比提交形状多内置运行时开关。 */
type FetchedPolicy = PolicyDraft & { bundledRuntimes: { enabled: boolean } };
type PolicySettings = {
  tier: string;
  automationTier: string;
  rules: { allow: string[]; deny: string[] };
  policy: FetchedPolicy;
  browserControlEnabled: boolean;
  browserAutoScreenshot: boolean;
  browserHeadless: boolean;
  browserDevtoolsReadEnabled: boolean;
  browserEvalEnabled: boolean;
  approvedForever: string[];
};

/**
 * 「规则与放行」卡片保存时带的数据安全字段（与界面缺省一致）。
 *
 * `bundledRuntimes` 不在这里：它属于「沙箱安全」卡片，单独提交，规则卡片不会带它。
 */
const DEFAULT_DATA_SAFETY = {
  deleteProtection: { enabled: false, batchThreshold: 50 },
  sensitiveProtection: { enabled: true, patterns: [] },
};

/** 服务端读回时的完整策略：比规则卡片多一个内置运行时开关。 */
const FETCHED_POLICY_DEFAULTS = {
  ...DEFAULT_DATA_SAFETY,
  bundledRuntimes: { enabled: true },
};

const EMPTY_SETTINGS: PolicySettings = {
  tier: "default",
  automationTier: "default",
  rules: { allow: [], deny: [] },
  policy: {
    rules: [],
    disabledTools: [],
    pathRules: [],
    commandRules: [],
    domainRules: [],
    ...FETCHED_POLICY_DEFAULTS,
  },
  browserControlEnabled: false,
  browserAutoScreenshot: false,
  browserHeadless: false,
  browserDevtoolsReadEnabled: false,
  browserEvalEnabled: false,
  approvedForever: [],
};

let client: CodeHttpChannelClient | undefined;

afterEach(() => {
  cleanup();
  client?.dispose();
  vi.unstubAllGlobals();
});

/** 渲染权限分区；`tierPuts` 收集 PUT /api/permissions/tier 的请求体。 */
function openPermissionSection(settings: typeof EMPTY_SETTINGS) {
  const tierPuts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/events"))
        return codeHostNotificationResponse(init?.signal);
      if (String(url).endsWith("/api/permissions/tier")) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          tierPuts.push(body);
          return Response.json({ ...settings, ...body });
        }
        return Response.json(settings);
      }
      // 审批模型下拉走 Code 宿主 RPC：给它一份空供应商目录，界面照常渲染。
      const request = JSON.parse(String(init?.body));
      if (request.service === "providerSettingsService") {
        if (request.method === "getModelDefaults") {
          return Response.json({
            result: {
              chat: null,
              approval: null,
              image: { mode: "auto" },
              video: { mode: "auto" },
            },
          });
        }
        return Response.json({
          result: {
            revision: 1,
            providerTemplates: [],
            providerOrder: [],
            providers: [],
          },
        });
      }
      return Response.json({ result: {} });
    }),
  );
  client = new CodeHttpChannelClient({ apiBase: "http://localhost:3001" });
  render(
    <ServiceProvider services={client.services}>
      <PermissionTierSection />
    </ServiceProvider>,
  );
  return { tierPuts };
}

it("读回已保存的三张规则表与禁用清单", async () => {
  openPermissionSection({
    ...EMPTY_SETTINGS,
    policy: {
      rules: [{ pattern: "mcp__*", action: "deny" }],
      disabledTools: ["shell_*"],
      pathRules: [{ path: "D:\\项目\\密钥", operation: "read", action: "ask" }],
      commandRules: [{ prefix: "rm -rf", action: "deny" }],
      domainRules: [],
      ...FETCHED_POLICY_DEFAULTS,
    },
  });

  expect(await screen.findByLabelText("工具名或前缀")).toHaveValue("mcp__*");
  expect(screen.getByLabelText("路径前缀")).toHaveValue("D:\\项目\\密钥");
  expect(screen.getByLabelText("命令前缀")).toHaveValue("rm -rf");
  expect(screen.getByLabelText("禁用工具名或前缀")).toHaveValue("shell_*");
});

it("新增路径与命令规则后保存，空白行不落库", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection(EMPTY_SETTINGS);

  await user.click(await screen.findByRole("button", { name: "添加路径规则" }));
  await user.type(screen.getByLabelText("路径前缀"), "  C:\\机密  ");
  await user.click(screen.getByRole("button", { name: "添加命令规则" }));
  await user.type(screen.getByLabelText("命令前缀"), "git push");
  // 多加一行但不填：保存时必须被剔除，空规则会命中一切。
  await user.click(screen.getByRole("button", { name: "添加工具规则" }));

  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  expect(tierPuts[0]).toEqual({
    policy: {
      rules: [],
      disabledTools: [],
      pathRules: [{ path: "C:\\机密", operation: "read", action: "ask" }],
      commandRules: [{ prefix: "git push", action: "ask" }],
      domainRules: [],
      ...DEFAULT_DATA_SAFETY,
    },
  });
  expect(await screen.findByText("已保存")).toBeInTheDocument();
});

it("改动作档与删除行写回同一个策略对象", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection({
    ...EMPTY_SETTINGS,
    policy: {
      rules: [{ pattern: "mcp__*", action: "deny" }],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [],
      ...FETCHED_POLICY_DEFAULTS,
    },
  });

  const patternInput = await screen.findByLabelText("工具名或前缀");
  const ruleRow = patternInput.parentElement as HTMLElement;
  // Base UI 的 Select 在 jsdom 下走键盘交互（与 code-model-defaults 同一手法）。
  act(() => within(ruleRow).getByRole("combobox", { name: "动作" }).focus());
  await userEvent.keyboard("[Space]");
  await userEvent.keyboard("[Home][Enter]");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  expect(tierPuts[0]).toEqual({
    policy: {
      rules: [{ pattern: "mcp__*", action: "allow" }],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [],
      ...DEFAULT_DATA_SAFETY,
    },
  });
});

it("域名规则（网络安全）读得回、存得出", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection({
    ...EMPTY_SETTINGS,
    policy: {
      rules: [],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [{ domain: "*.internal.example", action: "deny" }],
      ...FETCHED_POLICY_DEFAULTS,
    },
  });

  expect(await screen.findByLabelText("域名")).toHaveValue(
    "*.internal.example",
  );
  await user.click(screen.getByRole("button", { name: "添加域名规则" }));
  const inputs = screen.getAllByLabelText("域名");
  await user.type(inputs[1] as HTMLElement, "docs.example.com");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  expect(tierPuts[0]).toEqual({
    policy: {
      rules: [],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [
        { domain: "*.internal.example", action: "deny" },
        { domain: "docs.example.com", action: "ask" },
      ],
      ...DEFAULT_DATA_SAFETY,
    },
  });
});

it("数据安全：删除保护与敏感保护读得回、存得出", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection({
    ...EMPTY_SETTINGS,
    policy: {
      rules: [],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [],
      deleteProtection: { enabled: true, batchThreshold: 20 },
      sensitiveProtection: { enabled: true, patterns: ["内部工号\\s*\\d{6}"] },
      bundledRuntimes: { enabled: true },
    },
  });

  const deleteToggle = (await screen.findByLabelText(
    "删除保护",
  )) as HTMLInputElement;
  expect(deleteToggle.checked).toBe(true);
  expect(screen.getByLabelText("批量删除审批阈值")).toHaveValue(20);
  expect(screen.getByLabelText("自定义敏感规则")).toHaveValue(
    "内部工号\\s*\\d{6}",
  );

  // 加一条自定义敏感规则再保存。
  // 用 fireEvent.change 直接设值：`user.type` 会把 `[0-9]` 当键盘语法解析。
  await user.click(screen.getByRole("button", { name: "添加敏感规则" }));
  const patterns = screen.getAllByLabelText("自定义敏感规则");
  fireEvent.change(patterns[1] as HTMLElement, {
    target: { value: "token-[0-9]{8}" },
  });
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  expect(tierPuts[0]).toEqual({
    policy: {
      rules: [],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [],
      deleteProtection: { enabled: true, batchThreshold: 20 },
      sensitiveProtection: {
        enabled: true,
        patterns: ["内部工号\\s*\\d{6}", "token-[0-9]{8}"],
      },
    },
  });
});

it("沙箱安全：内置运行时开关读得回、单独保存时保留其它策略", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection({
    ...EMPTY_SETTINGS,
    policy: {
      rules: [{ pattern: "mcp__*", action: "deny" }],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [],
      ...FETCHED_POLICY_DEFAULTS,
    },
  });

  const toggle = (await screen.findByLabelText(
    "内置运行时",
  )) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  await user.click(toggle);

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  const body = tierPuts[0] as { policy: Record<string, unknown> };
  expect(body.policy.bundledRuntimes).toEqual({ enabled: false });
  // 单独提交只改这一项：同卡片其它策略字段原样带回去
  expect(body.policy.rules).toEqual([{ pattern: "mcp__*", action: "deny" }]);
});

it("文件安全：同一目录可分别配读 / 写 / 删三条规则", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection(EMPTY_SETTINGS);

  // 三条规则指向同一目录，但操作不同
  for (const [index, path] of [
    "/repo/data",
    "/repo/data",
    "/repo/data",
  ].entries()) {
    await user.click(screen.getByRole("button", { name: "添加路径规则" }));
    const inputs = screen.getAllByLabelText("路径前缀");
    fireEvent.change(inputs[index] as HTMLElement, {
      target: { value: path },
    });
  }
  // 第 2、3 条改成「写」「删」
  const operationTriggers = screen.getAllByRole("combobox", { name: "操作" });
  for (const [index, label] of [
    [1, "写"],
    [2, "删"],
  ] as const) {
    act(() => operationTriggers[index]?.focus());
    await userEvent.keyboard("[Space]");
    const option = await screen.findByRole("option", { name: label });
    await user.click(option);
  }

  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  const body = tierPuts[0] as {
    policy: { pathRules: Array<{ operation: string }> };
  };
  expect(body.policy.pathRules.map((rule) => rule.operation)).toEqual([
    "read",
    "write",
    "delete",
  ]);
});
