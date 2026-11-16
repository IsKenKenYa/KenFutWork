// @vitest-environment node
import "@testing-library/jest-dom/vitest";
import { createServer, type Server } from "node:http";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { setSurfaceApiBase } from "../src/components/workbench/zcode/host/surfaceApi.js";
import { installCodePublicHostDom } from "./setup/code-public-host-dom.js";

interface ApiFixture {
  baseUrl: string;
  origin: string;
  cookie: string;
  close(): Promise<void>;
}
const fixturePath = fileURLToPath(
  new URL(
    "../../server/src/features/code-ui/code-ui-http.fixture.ts",
    import.meta.url,
  ),
);
const permissionsPath = "/api/permissions/tier";
const cdpPath = "/api/browser/cdp/status";

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("转发服务缺少地址");
  return `http://127.0.0.1:${address.port}`;
}

async function createForwarder(fixture: ApiFixture) {
  const state = {
    denyPermissions: false,
    denyCdp: false,
    denyWrites: false,
    holdWrite: false,
  };
  const calls: Array<{ path: string; method: string }> = [];
  const failures: unknown[] = [];
  let releaseWrite!: () => void;
  let onWrite!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    onWrite = resolve;
  });
  const writeAllowed = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const server = createServer((request, reply) => {
    void (async () => {
      const path = request.url ?? "/";
      const method = request.method ?? "GET";
      calls.push({ path, method });
      const denied =
        (path === permissionsPath &&
          (method === "PUT" ? state.denyWrites : state.denyPermissions)) ||
        (path === cdpPath && state.denyCdp);
      const body = await buffer(request);
      const response = await fetch(`${fixture.baseUrl}${path}`, {
        method,
        headers: {
          origin: fixture.origin,
          "content-type": "application/json",
          connection: "close",
          ...(denied ? {} : { cookie: fixture.cookie }),
        },
        ...(body.length ? { body } : {}),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (path === permissionsPath && method === "PUT" && state.holdWrite) {
        onWrite();
        await writeAllowed;
      }
      reply.writeHead(response.status, {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
      });
      reply.end(bytes);
    })().catch((error: unknown) => {
      failures.push(error);
      reply.destroy(error instanceof Error ? error : undefined);
    });
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    state,
    calls,
    writeStarted,
    releaseWrite,
    async close() {
      releaseWrite();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (failures.length)
        throw new AggregateError(failures, "设置请求转发失败");
    },
  };
}

type Forwarder = Awaited<ReturnType<typeof createForwarder>>;
type View = ReturnType<typeof render>;
async function withSettings(
  prepare: (forwarder: Forwarder) => void,
  check: (input: {
    forwarder: Forwarder;
    view: View;
    remount(): void;
    readFlags(): Promise<Record<string, boolean>>;
  }) => Promise<void>,
  options: { url?: string } = {},
) {
  const http: { createCodeUiHttpFixture(): Promise<ApiFixture> } = await import(
    fixturePath
  );
  const fixture = await http.createCodeUiHttpFixture();
  let forwarder: Forwarder | undefined;
  let releaseDom: (() => void) | undefined;
  let view: View | undefined;
  const failures: unknown[] = [];
  try {
    forwarder = await createForwarder(fixture);
    prepare(forwarder);
    releaseDom = await installCodePublicHostDom(options);
    setSurfaceApiBase(forwarder.baseUrl);
    const { BrowserSettingsSection } = await import(
      "../src/components/workbench/zcode/host/BrowserSettingsSectionAdapter.js"
    );
    const mounted = render(<BrowserSettingsSection isDesktop={false} />);
    view = mounted;
    await check({
      forwarder,
      view,
      remount() {
        mounted.rerender(
          <BrowserSettingsSection key="read-saved" isDesktop={false} />,
        );
      },
      async readFlags() {
        const response = await fetch(`${fixture.baseUrl}${permissionsPath}`, {
          headers: {
            cookie: fixture.cookie,
            origin: fixture.origin,
            connection: "close",
          },
        });
        expect(response.status).toBe(200);
        return response.json();
      },
    });
  } catch (error) {
    failures.push(error);
  } finally {
    view?.unmount();
    setSurfaceApiBase("");
    for (const close of [
      () => forwarder?.close(),
      () => fixture.close(),
      () => releaseDom?.(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "浏览器设置验证失败", {
      cause: failures[0],
    });
}

it
  .skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")
  .each(["permissions", "cdp"] as const)(
  "%s 真实读取被拒绝时显示原因，恢复接入后可重新读取",
  async (kind) => {
    await withSettings(
      (forwarder) => {
        if (kind === "permissions") forwarder.state.denyPermissions = true;
        else forwarder.state.denyCdp = true;
      },
      async ({ forwarder, view }) => {
        await waitFor(() =>
          expect(view.getByRole("alert").textContent).toContain("本机连接"),
        );
        expect(view.queryByText("读取中…")).toBeNull();
        if (kind === "permissions")
          expect(view.queryAllByRole("switch")).toEqual([]);
        forwarder.state.denyPermissions = false;
        forwarder.state.denyCdp = false;
        fireEvent.click(
          view.getByRole("button", { name: "重新读取浏览器设置" }),
        );
        await waitFor(() => {
          expect(view.getAllByRole("switch")).toHaveLength(5);
          for (const control of view.getAllByRole("switch"))
            expect(control).toBeEnabled();
          expect(
            view.getByRole("button", { name: "连接到 Chrome" }),
          ).toBeEnabled();
          expect(view.queryByRole("alert")).toBeNull();
        });
      },
    );
  },
  60_000,
);

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "实际浏览器拒绝本地存储时显示处理方法，不显示未经读取的默认选择",
  async () => {
    await withSettings(
      () => {},
      async ({ view }) => {
        const error = await view.findByRole("alert");
        expect(error.textContent).toBe(
          "浏览器选择无法访问，请允许本地存储后重试。",
        );
        const trigger = view.getByRole("combobox", {
          name: "AI 任务默认浏览器",
        });
        expect(trigger).toBeDisabled();
        expect(trigger.textContent).toContain("未读取");
        expect(trigger).toHaveAttribute("aria-describedby", error.id);
        expect(trigger).toHaveAttribute("aria-invalid", "true");
        fireEvent.click(
          view.getByRole("button", { name: "重新读取默认浏览器" }),
        );
        expect(trigger.textContent).not.toContain("内置浏览器");
        await waitFor(() =>
          expect(view.getAllByRole("switch")).toHaveLength(5),
        );
      },
      { url: "about:blank" },
    );
  },
  60_000,
);

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "保存期间阻止重复操作，只显示已确认值，拒绝保存保留原值",
  async () => {
    await withSettings(
      () => {},
      async ({ forwarder, view, readFlags }) => {
        await waitFor(() =>
          expect(view.getByRole("switch", { name: "自动截图" })).toBeEnabled(),
        );
        const original = await readFlags();
        forwarder.state.holdWrite = true;
        fireEvent.click(view.getByRole("switch", { name: "自动截图" }));
        await forwarder.writeStarted;
        for (const control of view.getAllByRole("switch"))
          expect(control).toBeDisabled();
        expect(view.getByRole("switch", { name: "自动截图" })).toHaveAttribute(
          "aria-checked",
          String(original.browserAutoScreenshot),
        );
        fireEvent.click(view.getByRole("switch", { name: "无头浏览器" }));
        expect(
          forwarder.calls.filter((call) => call.method === "PUT"),
        ).toHaveLength(1);
        forwarder.releaseWrite();
        await waitFor(() => {
          expect(view.getByRole("switch", { name: "自动截图" })).toBeEnabled();
          expect(
            view.getByRole("switch", { name: "自动截图" }),
          ).toHaveAttribute(
            "aria-checked",
            String(!original.browserAutoScreenshot),
          );
        });
        expect((await readFlags()).browserAutoScreenshot).toBe(
          !original.browserAutoScreenshot,
        );
        forwarder.state.holdWrite = false;
        forwarder.state.denyWrites = true;
        fireEvent.click(view.getByRole("switch", { name: "无头浏览器" }));
        await waitFor(() =>
          expect(view.getByRole("alert").textContent).toContain("本机连接"),
        );
        expect(
          view.getByRole("switch", { name: "无头浏览器" }),
        ).toHaveAttribute("aria-checked", String(original.browserHeadless));
        expect((await readFlags()).browserHeadless).toBe(
          original.browserHeadless,
        );
      },
    );
  },
  60_000,
);

it.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "实际存储配额不足时保留默认浏览器，释放空间后可保存并恢复",
  async () => {
    await withSettings(
      () => {},
      async ({ view, remount }) => {
        const preferenceKey = "workbench:browser-open-target";
        const paddingKey = "browser-preference-quota-test";
        const trigger = view.getByRole("combobox", {
          name: "AI 任务默认浏览器",
        });
        await waitFor(() =>
          expect(trigger.textContent).toContain("内置浏览器"),
        );
        window.localStorage.setItem(preferenceKey, "panel");
        let used = 0;
        for (let index = 0; index < window.localStorage.length; index++) {
          const key = window.localStorage.key(index);
          if (key !== null)
            used +=
              key.length + (window.localStorage.getItem(key)?.length ?? 0);
        }
        // JSDOM 的既有独占 DOM 默认配额为 5,000,000 个 UTF-16 单元。
        window.localStorage.setItem(
          paddingKey,
          "x".repeat(5_000_000 - used - paddingKey.length),
        );
        const selectExternal = async () => {
          fireEvent.keyDown(trigger, { key: "ArrowDown", code: "ArrowDown" });
          fireEvent.click(
            await view.findByRole("option", { name: "外部浏览器" }),
          );
        };
        await selectExternal();
        expect((await view.findByRole("alert")).textContent).toContain(
          "存储空间不足",
        );
        expect(trigger.textContent).toContain("内置浏览器");
        expect(window.localStorage.getItem(preferenceKey)).toBe("panel");
        window.localStorage.removeItem(paddingKey);
        await selectExternal();
        await waitFor(() =>
          expect(trigger.textContent).toContain("外部浏览器"),
        );
        expect(window.localStorage.getItem(preferenceKey)).toBe("system");
        expect(view.queryByRole("alert")).toBeNull();
        remount();
        await waitFor(() =>
          expect(
            view.getByRole("combobox", { name: "AI 任务默认浏览器" })
              .textContent,
          ).toContain("外部浏览器"),
        );
      },
    );
  },
  60_000,
);
