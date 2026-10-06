import "@testing-library/jest-dom/vitest";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_GOVERNANCE_LIMITS } from "@kenfutwork/shared";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AGENT_GOVERNANCE_FIELDS } from "../src/lib/agent-governance-settings";
import {
  type Server,
  startGovernanceUiServer,
} from "./setup/governance-ui-server-client.fixture";
import {
  assertDisplayed,
  governanceInput,
  mountSurface,
  UI_TIMEOUT_MS,
} from "./setup/governance-ui-surface.fixture";

let server: Server;
const previousBase = process.env.NEXT_PUBLIC_SERVER_BASE_URL;
const enabled = process.env.RUN_GOVERNANCE_UI_INTEGRATION === "1";
beforeAll(async () => {
  if (!enabled) return;
  server = await startGovernanceUiServer();
  process.env.NEXT_PUBLIC_SERVER_BASE_URL = server.baseUrl;
}, 180_000); // 真实隔离PG/服务子进程启动预算，非运行时治理值。
afterEach(cleanup);
afterAll(async () => {
  try {
    await server?.stop();
  } finally {
    if (previousBase === undefined)
      delete process.env.NEXT_PUBLIC_SERVER_BASE_URL;
    else process.env.NEXT_PUBLIC_SERVER_BASE_URL = previousBase;
  }
});

describe.skipIf(!enabled).each(["code", "design"] as const)(
  "%s真实治理UI读取与整数范围 integration",
  (surface) => {
    it("真实实例读取后保存合法范围端点；空值/小数/越界禁用保存且无PATCH，后端真实读回与UI相等", async () => {
      const original = await server.inspect();
      const entry = await mountSurface(surface, server);
      await entry.open();
      await assertDisplayed(original.values);
      const save = () => screen.getByRole("button", { name: "保存" });
      const patchCount = original.requests.filter(
        (request) => request.method === "PATCH",
      ).length;

      for (const field of AGENT_GOVERNANCE_FIELDS) {
        const { min, max } = AGENT_GOVERNANCE_LIMITS[field.key];
        const input = governanceInput(field.key);
        expect(input).toHaveAttribute("type", "number");
        expect(input).toHaveAttribute("min", String(min));
        expect(input).toHaveAttribute("max", String(max));
        for (const invalid of [
          "",
          String(min - 1),
          String(max + 1),
          String(min + 0.5),
        ]) {
          fireEvent.change(input, { target: { value: invalid } });
          expect(save()).toBeDisabled();
          fireEvent.click(save());
        }
        fireEvent.change(input, {
          target: { value: String(original.values[field.key]) },
        });
      }
      const afterInvalid = await server.inspect();
      expect(
        afterInvalid.requests.filter((request) => request.method === "PATCH"),
      ).toHaveLength(patchCount);
      expect(afterInvalid.values).toEqual(original.values);

      const expected = {
        ...original.values,
        llmInfiniteRetry: !original.values.llmInfiniteRetry,
      };
      for (const [index, field] of AGENT_GOVERNANCE_FIELDS.entries()) {
        const limit = AGENT_GOVERNANCE_LIMITS[field.key];
        expected[field.key] = index % 2 === 0 ? limit.min : limit.max;
        fireEvent.change(governanceInput(field.key), {
          target: { value: String(expected[field.key]) },
        });
      }
      fireEvent.click(screen.getByRole("switch", { name: "模型请求无限重试" }));
      expect(save()).toBeEnabled();
      fireEvent.click(save());
      await screen.findByText(
        "Agent 治理设置已更新",
        {},
        { timeout: UI_TIMEOUT_MS },
      );
      await assertDisplayed(expected);
      const persisted = await server.inspect();
      expect(persisted.instanceId).toBe(server.instanceId);
      expect(persisted.values).toEqual(expected);
      expect(persisted.stored).toEqual(expected);
      const sent = persisted.requests
        .filter((request) => request.method === "PATCH")
        .slice(patchCount);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.status).toBe(200);
      expect(sent[0]?.patch).toEqual(expected);
      expect(sent[0]?.patchKeys?.sort()).toEqual(
        [
          ...AGENT_GOVERNANCE_FIELDS.map((field) => field.key),
          "llmInfiniteRetry",
        ].sort(),
      );
      await entry.close();
      await entry.open();
      await assertDisplayed(expected);
      await waitFor(() =>
        expect(screen.queryByText("Agent 治理设置已更新")).toBeNull(),
      );
    }, 90_000); // 每例真实HTTP/PG预算，非业务阈值。
  },
);

describe.skipIf(!enabled)("Design 真实并发设置写入", () => {
  it.each(["commands", "hooks"] as const)(
    "无关索引回包保留%s的未保存草稿",
    async (collection) => {
      const original = await server.inspect();
      const entry = await mountSurface("design", server);
      await entry.open();
      await assertDisplayed(original.values);
      fireEvent.click(screen.getByRole("button", { name: "索引库" }));
      const gate = `index-while-${collection}-draft`;
      await server.gate(gate, "PATCH", {
        phase: "response",
        match: {
          key: "codeIndexAutoNewFolder",
          value: !original.indexValues.autoNewFolder,
        },
      });
      fireEvent.click(screen.getByRole("switch", { name: "索引新文件夹" }));
      await server.waitGate(gate, "captured", 200);
      fireEvent.click(
        screen.getByRole("button", {
          name: collection === "commands" ? "命令" : "钩子",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: collection === "commands" ? "新增命令" : "新增钩子",
        }),
      );
      if (collection === "commands") {
        fireEvent.change(screen.getByRole("textbox", { name: "命令名 1" }), {
          target: { value: "review-draft" },
        });
        fireEvent.change(
          screen.getByRole("textbox", { name: "命令提示词 1" }),
          { target: { value: "Review {{args}}" } },
        );
      } else {
        fireEvent.change(screen.getByRole("textbox", { name: "钩子命令 1" }), {
          target: { value: "echo draft-only" },
        });
      }
      await act(async () => {
        await server.release(gate);
        await server.waitGate(gate, "delivered", 200);
        await delay(100);
      });
      if (collection === "commands") {
        expect(screen.getByRole("textbox", { name: "命令名 1" })).toHaveValue(
          "review-draft",
        );
        expect(
          screen.getByRole("textbox", { name: "命令提示词 1" }),
        ).toHaveValue("Review {{args}}");
      } else {
        expect(screen.getByRole("textbox", { name: "钩子命令 1" })).toHaveValue(
          "echo draft-only",
        );
      }
      await entry.close();
    },
    90_000,
  );

  it("无关索引真实回包不抹掉尚未保存的治理草稿", async () => {
    const original = await server.inspect();
    const entry = await mountSurface("design", server);
    await entry.open();
    await assertDisplayed(original.values);
    fireEvent.click(screen.getByRole("button", { name: "索引库" }));
    const nextAuto = !original.indexValues.autoNewFolder;
    await server.gate("index-while-draft", "PATCH", {
      phase: "response",
      match: { key: "codeIndexAutoNewFolder", value: nextAuto },
    });
    fireEvent.click(screen.getByRole("switch", { name: "索引新文件夹" }));
    await server.waitGate("index-while-draft", "captured", 200);
    fireEvent.click(screen.getByRole("button", { name: "Agent 治理" }));
    await assertDisplayed(original.values);
    const draft = original.values.compactKeepMessages === 7 ? 8 : 7;
    fireEvent.change(governanceInput("compactKeepMessages"), {
      target: { value: String(draft) },
    });
    await act(async () => {
      await server.release("index-while-draft");
      await server.waitGate("index-while-draft", "delivered", 200);
      // 仅真实HTTP→React更新同步预算，不是运行时上限或伪造数据。
      await delay(100);
    });
    const persisted = await server.inspect();
    expect(persisted.indexValues.autoNewFolder).toBe(nextAuto);
    expect(persisted.values).toEqual(original.values);
    expect(governanceInput("compactKeepMessages").value).toBe(String(draft));
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    await entry.close();
  }, 90_000);

  it("两个索引PATCH提交顺序改变后，最终显示仍与真实后端一致", async () => {
    const original = await server.inspect();
    const nextEnabled = !original.indexValues.enabled;
    const nextAuto = !original.indexValues.autoNewFolder;
    const entry = await mountSurface("design", server);
    await entry.open();
    await assertDisplayed(original.values);
    fireEvent.click(screen.getByRole("button", { name: "索引库" }));
    const enabledToggle = () =>
      screen.getByRole("switch", {
        name: "索引存储库以实现即时搜索（测试版）",
      });
    const autoToggle = () =>
      screen.getByRole("switch", { name: "索引新文件夹" });
    await server.gate("early-index", "PATCH", {
      phase: "request",
      match: { key: "codeIndexEnabled", value: nextEnabled },
    });
    fireEvent.click(enabledToggle());
    await server.waitGate("early-index", "captured", null);
    fireEvent.click(autoToggle());
    // 测试时序预算：旧并发实现让B先真实提交；串行实现由预算放行A后再提交B。
    const releaseDeadline = Date.now() + 1_500;
    while (Date.now() < releaseDeadline) {
      const current = await server.inspect();
      if (
        current.requests
          .slice(original.requests.length)
          .some(
            (request) =>
              request.patch?.codeIndexAutoNewFolder === nextAuto &&
              request.status === 200,
          )
      )
        break;
      await delay(25);
    }
    await server.release("early-index");
    await waitFor(
      async () => {
        const current = await server.inspect();
        expect(current.indexValues).toEqual({
          enabled: nextEnabled,
          autoNewFolder: nextAuto,
        });
        expect(
          current.requests
            .slice(original.requests.length)
            .filter(
              (request) =>
                request.method === "PATCH" &&
                (request.patch?.codeIndexEnabled === nextEnabled ||
                  request.patch?.codeIndexAutoNewFolder === nextAuto),
            ),
        ).toHaveLength(2);
        expect(
          enabledToggle(),
          "最终UI不能把已成功写入的开关停在旧值",
        ).toHaveProperty("checked", nextEnabled);
        expect(autoToggle()).toHaveProperty("checked", nextAuto);
      },
      { timeout: UI_TIMEOUT_MS },
    );
    await entry.close();
  }, 90_000);
});

describe.skipIf(!enabled).each(["code", "design"] as const)(
  "%s真实设置关闭重开",
  (surface) => {
    it("GET连接失败时不显示默认真值，真实重试后显示后端设置", async () => {
      const original = await server.inspect();
      const entry = await mountSurface(surface, server);
      const gate = `failed-read-${surface}`;
      await server.gate(gate, "GET", { phase: "request" });
      await entry.open();
      await server.waitGate(gate, "captured", null);
      await server.drop(gate);
      const retryName = surface === "code" ? "重新加载" : "重试";
      await screen.findByRole("button", { name: retryName });
      expect(
        screen.queryByRole("spinbutton", {
          name: "压缩保留目标（窗口已知）",
        }),
      ).toBeNull();
      expect(screen.queryByText("Agent 治理设置已更新")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: retryName }));
      await assertDisplayed(original.values);
      await entry.close();
    }, 90_000);

    it("PATCH连接失败不显示成功，写队列仍允许后续真实重试", async () => {
      const original = await server.inspect();
      const next = original.values.compactKeepMessages === 7 ? 8 : 7;
      const entry = await mountSurface(surface, server);
      await entry.open();
      await assertDisplayed(original.values);
      const gate = `failed-save-${surface}`;
      await server.gate(gate, "PATCH", {
        phase: "request",
        match: { key: "compactKeepMessages", value: next },
      });
      fireEvent.change(governanceInput("compactKeepMessages"), {
        target: { value: String(next) },
      });
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await server.waitGate(gate, "captured", null);
      await server.drop(gate);
      await screen.findByRole("alert");
      expect(screen.queryByText("Agent 治理设置已更新")).toBeNull();
      expect((await server.inspect()).values).toEqual(original.values);
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await screen.findByText("Agent 治理设置已更新");
      await assertDisplayed({ ...original.values, compactKeepMessages: next });
      expect((await server.inspect()).values.compactKeepMessages).toBe(next);
      await entry.close();
    }, 90_000);

    it("旧GET迟到不覆盖新打开周期实际读取的值", async () => {
      const original = await server.inspect();
      const next = original.values.compactKeepMessages === 7 ? 8 : 7;
      const entry = await mountSurface(surface, server);
      const gate = `old-get-${surface}`;
      await server.gate(gate, "GET", { phase: "response" });
      await entry.open();
      await server.waitGate(gate, "captured", 200);
      expect(
        screen.queryByRole("spinbutton", {
          name: "压缩保留目标（窗口已知）",
        }),
      ).toBeNull();
      await entry.close();
      const changed = await fetch(`${server.baseUrl}/api/instance/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ compactKeepMessages: next }),
      });
      expect(changed.status).toBe(200);
      await entry.open();
      await assertDisplayed({ ...original.values, compactKeepMessages: next });
      await act(async () => {
        await server.release(gate);
        await server.waitGate(gate, "delivered", 200);
        await delay(100);
      });
      await assertDisplayed({ ...original.values, compactKeepMessages: next });
      expect((await server.inspect()).values.compactKeepMessages).toBe(next);
      await entry.close();
    }, 90_000);

    it("旧PATCH已发送未提交时重开读取等待真实写屏障且不保留旧成功反馈", async () => {
      const original = await server.inspect();
      const next = original.values.compactKeepMessages === 7 ? 8 : 7;
      const entry = await mountSurface(surface, server);
      await entry.open();
      await assertDisplayed(original.values);
      const gate = `old-patch-${surface}`;
      await server.gate(gate, "PATCH", {
        phase: "request",
        match: { key: "compactKeepMessages", value: next },
      });
      fireEvent.change(governanceInput("compactKeepMessages"), {
        target: { value: String(next) },
      });
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await server.waitGate(gate, "captured", null);
      await entry.close();
      await entry.open();
      expect(
        screen.queryByRole("spinbutton", {
          name: "压缩保留目标（窗口已知）",
        }),
      ).toBeNull();
      await act(async () => {
        await server.release(gate);
        await server.waitGate(gate, "delivered", 200);
      });
      await assertDisplayed({ ...original.values, compactKeepMessages: next });
      expect(screen.queryByText("Agent 治理设置已更新")).toBeNull();
      expect((await server.inspect()).values.compactKeepMessages).toBe(next);
      await entry.close();
    }, 90_000);
  },
);
