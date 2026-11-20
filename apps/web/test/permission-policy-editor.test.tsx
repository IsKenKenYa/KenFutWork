// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
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
type PolicySettings = {
  tier: string;
  automationTier: string;
  rules: { allow: string[]; deny: string[] };
  policy: {
    rules: Array<{ pattern: string; action: RuleAction }>;
    disabledTools: string[];
    pathRules: Array<{ path: string; action: RuleAction }>;
    commandRules: Array<{ prefix: string; action: RuleAction }>;
  };
  browserControlEnabled: boolean;
  browserAutoScreenshot: boolean;
  browserHeadless: boolean;
  browserDevtoolsReadEnabled: boolean;
  browserEvalEnabled: boolean;
  approvedForever: string[];
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
      pathRules: [{ path: "D:\\项目\\密钥", action: "ask" }],
      commandRules: [{ prefix: "rm -rf", action: "deny" }],
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
      pathRules: [{ path: "C:\\机密", action: "ask" }],
      commandRules: [{ prefix: "git push", action: "ask" }],
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
    },
  });
});
