// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

/**
 * 打开某一组规则的编辑弹窗（用户口径 2026-11-22：规则表改为点「编辑」进弹窗）。
 *
 * 弹窗先展示条目列表，点某一条进入那一条的编辑面板——各用例在输入内容之前
 * 都要先经过这一步（列表里没有输入框，只有可点的条目）。
 */
async function openRuleDialog(title: string): Promise<void> {
  const open = await screen.findByRole("button", { name: `编辑${title}` });
  act(() => open.click());
  await screen.findByRole("dialog");
}

/** 在已打开的规则弹窗里点开第 `index` 条（列表顺序），进入单条编辑面板。 */
async function openRuleDetail(index = 0): Promise<void> {
  const rows = await screen.findAllByRole("button", { name: /^编辑规则/ });
  const row = rows[index];
  if (!row) throw new Error(`规则列表里没有第 ${index} 条`);
  act(() => row.click());
}

/** 关闭当前弹窗（弹窗里的主按钮叫「完成」）。 */
async function closeRuleDialog(): Promise<void> {
  act(() => screen.getByRole("button", { name: "完成" }).click());
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

  // 禁用清单读回时折成排在最前的「工具规则 + 拦截」：两条都在同一张工具规则表里。
  // 弹窗先列条目，点第几条就进那条的编辑面板（用户口径：点击对应的规则直接编辑）。
  await openRuleDialog("工具规则");
  expect(
    screen
      .getAllByRole("button", { name: /^编辑规则/ })
      .map((row) => (row.textContent ?? "").trim()),
  ).toEqual(["shell_*拦截", "mcp__*拦截"]);
  await openRuleDetail(0);
  expect(await screen.findByLabelText("工具名或前缀")).toHaveValue("shell_*");
  await closeRuleDialog();
  await openRuleDialog("文件路径规则");
  await openRuleDetail(0);
  expect(await screen.findByLabelText("路径前缀")).toHaveValue(
    "D:\\项目\\密钥",
  );
  await closeRuleDialog();
  await openRuleDialog("命令规则");
  await openRuleDetail(0);
  expect(await screen.findByLabelText("命令前缀")).toHaveValue("rm -rf");
});

it("新增路径与命令规则后保存，空白行不落库", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection(EMPTY_SETTINGS);

  await openRuleDialog("文件路径规则");
  // 添加后直接进新条目的编辑面板：列表里没有输入框。
  await user.click(await screen.findByRole("button", { name: "添加" }));
  await user.type(await screen.findByLabelText("路径前缀"), "  C:\\机密  ");
  await closeRuleDialog();

  await openRuleDialog("命令规则");
  await user.click(screen.getByRole("button", { name: "添加" }));
  await user.type(await screen.findByLabelText("命令前缀"), "git push");
  // 再加一条不填：保存时必须被剔除，空规则会命中一切。
  act(() => screen.getByRole("button", { name: "返回列表" }).click());
  await user.click(screen.getByRole("button", { name: "添加" }));
  await closeRuleDialog();

  await waitFor(() => expect(tierPuts.length).toBeGreaterThanOrEqual(2));
  // 两组的最后一次提交都读回整份策略再合并：分组互相不冲掉对方，空行被剔除。
  const last = tierPuts[tierPuts.length - 1] as {
    policy: Record<string, unknown>;
  };
  expect(last.policy.pathRules).toEqual([
    { path: "C:\\机密", operation: "read", action: "ask" },
  ]);
  expect(last.policy.commandRules).toEqual([
    { prefix: "git push", action: "ask" },
  ]);
  // 禁用清单清空（已并入工具规则）。
  expect(last.policy.disabledTools).toEqual([]);
});

it("改动作档与删除行写回同一个策略对象", async () => {
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

  await openRuleDialog("工具规则");
  await openRuleDetail(0);
  expect(await screen.findByLabelText("工具名或前缀")).toHaveValue("mcp__*");
  // Base UI 的 Select 在 jsdom 下走键盘交互（与 code-model-defaults 同一手法）。
  // 详情面板里匹配值与动作各占一行，所以动作下拉直接按名字取。
  act(() => screen.getByRole("combobox", { name: "动作" }).focus());
  await userEvent.keyboard("[Space]");
  await userEvent.keyboard("[Home][Enter]");
  await closeRuleDialog();

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

  await openRuleDialog("网络规则");
  expect(
    (await screen.findAllByRole("button", { name: /^编辑规则/ })).map((row) =>
      (row.textContent ?? "").trim(),
    ),
  ).toEqual(["*.internal.example拦截"]);
  await user.click(screen.getByRole("button", { name: "添加" }));
  // 新条目直接进编辑面板，填完返回列表继续操作。
  await user.type(await screen.findByLabelText("域名"), "docs.example.com");
  await closeRuleDialog();

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

  await openRuleDialog("命令规则");
  await user.click(await screen.findByRole("button", { name: "添加" }));
  await user.type(await screen.findByLabelText("命令前缀"), "git push");
  await closeRuleDialog();

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

it("删除模式：四选一写回 deleteMode，其它策略字段原样带回", async () => {
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
  // 批量删除审批不在权限页配置（用户口径 2026-11-22），保存时必须原样带回。
  expect(body.policy.deleteProtection).toEqual({
    enabled: true,
    batchThreshold: 50,
  });
});

it("批量删除审批与内置运行时不在权限页出现", async () => {
  openPermissionSection(EMPTY_SETTINGS);
  // 用户口径：基础配置只有清单里的五项，这两行随之移除。
  expect(screen.queryByLabelText("批量删除审批")).toBeNull();
  expect(screen.queryByLabelText("批量删除审批阈值")).toBeNull();
  expect(screen.queryByLabelText("内置运行时")).toBeNull();
  expect(screen.queryByLabelText("文件访问")).toBeNull();
  expect(screen.queryByLabelText("网络访问")).toBeNull();
  // 沙箱隔离仍在（清单第 2 项）。
  expect(screen.getByLabelText("沙箱隔离")).toBeTruthy();
});

it("沙箱隔离开关读得回、保存时保留其它策略", async () => {
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

  // 沙箱隔离是开关（用户口径：与浏览器控制页同一个 Switch）。
  const toggle = await screen.findByRole("switch", { name: "沙箱隔离" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await user.click(toggle);

  await waitFor(() => expect(tierPuts).toHaveLength(1));
  const body = tierPuts[0] as { policy: Record<string, unknown> };
  expect(body.policy.sandbox).toEqual({ enabled: false });
  // 单独提交只改这一项：同卡片其它策略字段原样带回去
  expect(body.policy.rules).toEqual([{ pattern: "mcp__*", action: "deny" }]);
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

  // 自动档可进字典弹窗编辑（条数由弹窗里的输入框体现）
  act(() => screen.getByRole("button", { name: "编辑高危命令" }).click());
  expect(await screen.findAllByLabelText("高危命令前缀")).toHaveLength(2);
  // 关掉弹窗再切档，避免同一个 dialog 遮挡断言。
  act(() => screen.getByRole("button", { name: "完成" }).click());
  await waitFor(() => expect(tierPuts).toHaveLength(1));

  const trigger = await screen.findByLabelText("命令执行前审查");
  act(() => trigger.focus());
  await userEvent.keyboard("[Space]");
  await user.click(await screen.findByRole("option", { name: "严格" }));

  await waitFor(() => expect(tierPuts.length).toBeGreaterThanOrEqual(1));
  const body = tierPuts[tierPuts.length - 1] as {
    policy: { commandReview: string };
  };
  expect(body.policy.commandReview).toBe("strict");
  // 严格档不看字典：入口不出现（摆了会让人以为它们也生效）
  expect(screen.queryByRole("button", { name: "编辑高危命令" })).toBeNull();
});

it("文件安全：同一目录可分别配读 / 写 / 删三条规则", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection(EMPTY_SETTINGS);

  await openRuleDialog("文件路径规则");
  // 三条规则指向同一目录，但操作不同。每条添加后进各自的编辑面板填值。
  for (const operationLabel of ["读", "写", "删"]) {
    await user.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.change(await screen.findByLabelText("路径前缀"), {
      target: { value: "/repo/data" },
    });
    act(() => screen.getByRole("combobox", { name: "操作" }).focus());
    await userEvent.keyboard("[Space]");
    await user.click(
      await screen.findByRole("option", { name: operationLabel }),
    );
    act(() => screen.getByRole("button", { name: "返回列表" }).click());
  }

  await closeRuleDialog();

  await waitFor(() => expect(tierPuts.length).toBeGreaterThanOrEqual(1));
  const body = tierPuts[tierPuts.length - 1] as {
    policy: { pathRules: Array<{ operation: string }> };
  };
  expect(body.policy.pathRules.map((rule) => rule.operation)).toEqual([
    "read",
    "write",
    "delete",
  ]);
});

it("页面上不铺规则条目；条目都在弹窗里，可点开编辑、行尾可删除", async () => {
  const user = userEvent.setup();
  const { tierPuts } = openPermissionSection({
    ...EMPTY_SETTINGS,
    policy: {
      // 工具规则留空，让断言只落在网络规则这两条上。
      rules: [],
      disabledTools: [],
      pathRules: [],
      commandRules: [],
      domainRules: [
        { domain: "*.a.example", action: "ask" },
        { domain: "*.b.example", action: "deny" },
      ],
      ...FETCHED_POLICY_DEFAULTS,
    },
  });

  // 用户口径 2026-11-23：规则条目不在页面上显示，只留「编辑」入口。
  expect(screen.queryAllByRole("button", { name: /^编辑规则/ })).toHaveLength(
    0,
  );
  expect(screen.queryAllByRole("button", { name: /^删除规则/ })).toHaveLength(
    0,
  );

  // 进网络规则弹窗：条目逐行列出，行尾有删除按钮。
  await openRuleDialog("网络规则");
  const listed = await screen.findAllByRole("button", { name: /^编辑规则/ });
  expect(listed.map((row) => (row.textContent ?? "").trim())).toEqual([
    "*.a.example每次询问",
    "*.b.example拦截",
  ]);

  // 点某一条进那一条的编辑面板。
  const second = listed[1];
  if (!second) throw new Error("没有找到第二条规则");
  act(() => second.click());
  expect(await screen.findByLabelText("域名")).toHaveValue("*.b.example");
  act(() => screen.getByRole("button", { name: "返回列表" }).click());

  // 行尾垃圾桶删掉第一条，关闭弹窗后提交。
  const deletes = screen.getAllByRole("button", { name: /^删除规则/ });
  const firstDelete = deletes[0];
  if (!firstDelete) throw new Error("没有找到删除按钮");
  await user.click(firstDelete);
  await closeRuleDialog();

  await waitFor(() => expect(tierPuts.length).toBeGreaterThanOrEqual(1));
  const body = tierPuts[tierPuts.length - 1] as {
    policy: { domainRules: Array<{ domain: string }> };
  };
  expect(body.policy.domainRules).toEqual([
    { domain: "*.b.example", action: "deny" },
  ]);
});

it("HTTP 放行与 SSL 证书校验在网络规则的编辑弹窗里", async () => {
  openPermissionSection(EMPTY_SETTINGS);
  // 页面上不再有这两项（用户口径：归到网络规则编辑弹窗里）。
  expect(screen.queryByRole("switch", { name: "HTTP 放行" })).toBeNull();
  expect(screen.queryByRole("switch", { name: "SSL 证书校验" })).toBeNull();

  await openRuleDialog("网络规则");
  expect(await screen.findByRole("switch", { name: "HTTP 放行" })).toBeTruthy();
  expect(screen.getByRole("switch", { name: "SSL 证书校验" })).toBeTruthy();

  // 其它规则的弹窗里不出现这两项。
  await closeRuleDialog();
  await openRuleDialog("工具规则");
  expect(screen.queryByRole("switch", { name: "HTTP 放行" })).toBeNull();
});
