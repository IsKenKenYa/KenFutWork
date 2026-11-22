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
/** 服务端策略里界面会读写的字段（规则卡片 + 基础配置 + 安全防护）。 */
type PolicyDraft = {
  rules: Array<{ pattern: string; action: RuleAction }>;
  disabledTools: string[];
  pathRules: Array<{
    path: string;
    operation: "read" | "write" | "delete";
    action: RuleAction;
  }>;
  commandRules: Array<{ prefix: string; action: RuleAction }>;
  domainRules: Array<{ domain: string; action: RuleAction }>;
  networkPolicy: {
    networkMode: "allow-all" | "auto" | "ask" | "whitelist" | "blacklist";
    httpAllowed: boolean;
    tlsVerification: boolean;
  };
  deleteMode: "ask" | "auto-approve" | "trash" | "permanent";
  deleteProtection: { enabled: boolean; batchThreshold: number };
  commandReview: "auto" | "strict" | "off";
  commandReviewPatterns: string[];
  sensitiveProtection: { enabled: boolean; patterns: string[] };
};
/** 服务端读回的完整策略：比规则字段多内置运行时、沙箱总开关与 AI 安全防护。 */
type FetchedPolicy = PolicyDraft & {
  bundledRuntimes: { enabled: boolean };
  sandbox: { enabled: boolean };
  aiSafety: { injectionGuard: boolean; approvalReview: boolean };
};
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
 * 数据安全的缺省值（`permissionPolicySchema` 的缺省，与界面读回一致）。
 *
 * 规则卡片读回整份策略再合并，所以这些字段会原样再提交回去——断言里用同一份，
 * 就能同时证明「没把别人刚改的字段冲掉」。
 */
const DEFAULT_DATA_SAFETY = {
  deleteMode: "ask" as const,
  deleteProtection: { enabled: true, batchThreshold: 50 },
  commandReview: "auto" as const,
  commandReviewPatterns: ["rm "],
  networkPolicy: {
    networkMode: "auto" as const,
    httpAllowed: true,
    tlsVerification: true,
  },
  sensitiveProtection: { enabled: true, patterns: [] },
};

/** 服务端读回时的完整策略：除规则字段外还有内置运行时、沙箱总开关与 AI 安全防护。 */
const FETCHED_POLICY_DEFAULTS = {
  ...DEFAULT_DATA_SAFETY,
  bundledRuntimes: { enabled: true },
  sandbox: { enabled: true },
  aiSafety: { injectionGuard: false, approvalReview: false },
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

  // 禁用清单读回时折成排在最前的「工具规则 + 拦截」：两条都在同一张工具规则表里
  const toolInputs = await screen.findAllByLabelText("工具名或前缀");
  expect(toolInputs.map((input) => (input as HTMLInputElement).value)).toEqual([
    "shell_*",
    "mcp__*",
  ]);
  expect(screen.getByLabelText("路径前缀")).toHaveValue("D:\\项目\\密钥");
  expect(screen.getByLabelText("命令前缀")).toHaveValue("rm -rf");
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

  await user.click(screen.getByRole("button", { name: "保存规则" }));

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  // 规则卡片读回整份策略再合并：其它分组的字段原样带回，禁用清单清空（已并入工具规则）。
  expect(tierPuts[0]).toEqual({
    policy: {
      rules: [],
      disabledTools: [],
      pathRules: [{ path: "C:\\机密", operation: "read", action: "ask" }],
      commandRules: [{ prefix: "git push", action: "ask" }],
      domainRules: [],
      ...FETCHED_POLICY_DEFAULTS,
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
  await user.click(screen.getByRole("button", { name: "保存规则" }));

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  expect(tierPuts[0]).toEqual({
    policy: {
      rules: [{ pattern: "mcp__*", action: "allow" }],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [],
      ...FETCHED_POLICY_DEFAULTS,
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
  await user.click(screen.getByRole("button", { name: "保存规则" }));

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
      ...FETCHED_POLICY_DEFAULTS,
    },
  });
});

it("规则与放行保存时原样带回敏感保护等其它字段，不把别人刚改的冲掉", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection({
    ...EMPTY_SETTINGS,
    policy: {
      rules: [],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [],
      deleteMode: "ask",
      deleteProtection: { enabled: true, batchThreshold: 20 },
      // 用户口径（2026-11-22）：敏感保护不再在权限页配置，但服务端字段仍在，
      // 规则卡片保存时**必须原样带回**，不能把它冲回缺省值。
      sensitiveProtection: { enabled: true, patterns: ["内部工号\\s*\\d{6}"] },
      commandReview: "auto",
      commandReviewPatterns: ["rm "],
      networkPolicy: {
        networkMode: "auto",
        httpAllowed: true,
        tlsVerification: true,
      },
      bundledRuntimes: { enabled: true },
      sandbox: { enabled: true },
      aiSafety: { injectionGuard: false, approvalReview: false },
    },
  });

  await user.click(await screen.findByRole("button", { name: "添加命令规则" }));
  await user.type(screen.getByLabelText("命令前缀"), "git push");
  await user.click(screen.getByRole("button", { name: "保存规则" }));

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  expect(tierPuts[0]).toEqual({
    policy: {
      rules: [],
      disabledTools: [],
      pathRules: [],
      commandRules: [{ prefix: "git push", action: "ask" }],
      domainRules: [],
      deleteMode: "ask",
      deleteProtection: { enabled: true, batchThreshold: 20 },
      commandReview: "auto",
      commandReviewPatterns: ["rm "],
      networkPolicy: {
        networkMode: "auto",
        httpAllowed: true,
        tlsVerification: true,
      },
      sensitiveProtection: {
        enabled: true,
        patterns: ["内部工号\\s*\\d{6}"],
      },
      bundledRuntimes: { enabled: true },
      sandbox: { enabled: true },
      aiSafety: { injectionGuard: false, approvalReview: false },
    },
  });
});

it("删除模式：四选一写回 deleteMode，批量阈值同卡片提交", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection({
    ...EMPTY_SETTINGS,
    policy: {
      rules: [],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [],
      deleteMode: "ask",
      deleteProtection: { enabled: true, batchThreshold: 50 },
      sensitiveProtection: { enabled: true, patterns: [] },
      commandReview: "auto",
      commandReviewPatterns: ["rm "],
      networkPolicy: {
        networkMode: "auto",
        httpAllowed: true,
        tlsVerification: true,
      },
      bundledRuntimes: { enabled: true },
      sandbox: { enabled: true },
      aiSafety: { injectionGuard: false, approvalReview: false },
    },
  });

  const trigger = await screen.findByLabelText("删除模式");
  expect(trigger.textContent).toContain("删除前询问");

  // Base UI 的 Select 在 jsdom 下走键盘交互（与「改动作档」那条同一手法）。
  act(() => trigger.focus());
  await userEvent.keyboard("[Space]");
  await user.click(await screen.findByRole("option", { name: "先移到回收站" }));

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  const body = tierPuts[0] as {
    policy: { deleteMode: string; deleteProtection: unknown };
  };
  expect(body.policy.deleteMode).toBe("trash");
  expect(body.policy.deleteProtection).toEqual({
    enabled: true,
    batchThreshold: 50,
  });
});

it("命令执行前审查：三档写回，严格档不展示高危字典", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection({
    ...EMPTY_SETTINGS,
    policy: {
      rules: [],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [],
      deleteMode: "ask",
      deleteProtection: { enabled: true, batchThreshold: 50 },
      sensitiveProtection: { enabled: true, patterns: [] },
      commandReview: "auto",
      commandReviewPatterns: ["rm ", "sudo "],
      networkPolicy: {
        networkMode: "auto",
        httpAllowed: true,
        tlsVerification: true,
      },
      bundledRuntimes: { enabled: true },
      sandbox: { enabled: true },
      aiSafety: { injectionGuard: false, approvalReview: false },
    },
  });

  // 自动档展示字典（只有它按前缀筛）
  expect(await screen.findAllByLabelText("高危命令前缀")).toHaveLength(2);

  const trigger = await screen.findByLabelText("命令执行前审查");
  act(() => trigger.focus());
  await userEvent.keyboard("[Space]");
  await user.click(await screen.findByRole("option", { name: "严格" }));

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  const body = tierPuts[0] as { policy: { commandReview: string } };
  expect(body.policy.commandReview).toBe("strict");
  // 严格档不看字典：条目不渲染（摆了会让人以为它们也生效）
  await waitFor(() =>
    expect(screen.queryAllByLabelText("高危命令前缀")).toHaveLength(0),
  );
});

it("批量删除审批：关掉开关立刻落库，阈值离开输入框才提交", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection(EMPTY_SETTINGS);
  /** 第 n 次提交带上去的批量删除审批（其余字段不在这里判）。 */
  const submitted = (index: number) =>
    (tierPuts[index] as { policy: { deleteProtection: unknown } }).policy
      .deleteProtection;

  // 关掉批量审批：开关自身立即提交，阈值同时置灰。
  await user.click(await screen.findByLabelText("批量删除审批"));
  await waitFor(() => expect(tierPuts).toHaveLength(1));
  expect(submitted(0)).toEqual({ enabled: false, batchThreshold: 50 });
  expect(screen.getByLabelText("批量删除审批阈值")).toBeDisabled();

  // 再打开：阈值恢复可编辑。
  await user.click(screen.getByLabelText("批量删除审批"));
  await waitFor(() => expect(tierPuts).toHaveLength(2));
  expect(submitted(1)).toEqual({ enabled: true, batchThreshold: 50 });

  // 阈值离开输入框才提交：填到一半的「8」不会被当成最终值。
  const threshold = screen.getByLabelText("批量删除审批阈值");
  fireEvent.change(threshold, { target: { value: "80" } });
  expect(tierPuts).toHaveLength(2);
  fireEvent.blur(threshold);
  await waitFor(() => expect(tierPuts).toHaveLength(3));
  expect(submitted(2)).toEqual({ enabled: true, batchThreshold: 80 });
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

  await user.click(screen.getByRole("button", { name: "保存规则" }));

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
