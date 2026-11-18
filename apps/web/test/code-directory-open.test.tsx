import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DirectoryBrowser } from "@zui/DirectoryBrowser";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { ProjectDirectoryChoiceProvider } from "../src/components/workbench/zcode/host/ProjectDirectoryChoice";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  ["code", "复用"],
  ["code", "独立创建"],
  ["code", "取消"],
  ["design", "复用"],
  ["design", "独立创建"],
  ["design", "取消"],
] as const)(
  "%s 原目录选择器打开已缓存同目录时等待明确%s",
  async (preset, choice) => {
    const projectId = "71000000-0000-4000-8000-000000000001";
    const independentProjectId = "71000000-0000-4000-8000-000000000002";
    const workspace = {
      projectId,
      name: "现有共享项目",
      path: "/目录",
      additionalDirectories: [],
    };
    const calls: Array<{ service: string; method: string; args: unknown[] }> =
      [];
    const candidatePaths: string[] = [];
    const mutations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, options) => {
        const url = String(input);
        if (url.endsWith("/events"))
          return codeHostNotificationResponse(options?.signal);
        if (url.includes("/api/projects/directory-candidates?")) {
          candidatePaths.push(new URL(url).searchParams.get("path") ?? "");
          return Response.json({
            projects: [
              {
                id: projectId,
                name: workspace.name,
                kind: "code",
                enabledModes: ["code", "design"],
                workDir: workspace.path,
              },
            ],
          });
        }
        if (options?.method === "PATCH") {
          mutations.push(url);
          return Response.json({});
        }
        const call = JSON.parse(options.body);
        calls.push(call);
        if (call.service === "system")
          return Response.json({
            result: { homedir: workspace.path, platform: "darwin" },
          });
        if (call.service === "file") return Response.json({ result: [] });
        if (call.service === "workspace" && call.method === "open")
          return Response.json({
            result: {
              ...workspace,
              projectId:
                call.args[0].directoryChoice === "independent"
                  ? independentProjectId
                  : projectId,
            },
          });
        throw new Error(`Unexpected RPC: ${call.service}.${call.method}`);
      }),
    );
    const client = new CodeHttpChannelClient({
      apiBase: "https://host.example",
    });
    await client.connect();
    client.registerWorkspaces([workspace]);
    client.setWorkPresetResolver(() => preset);
    expect(client.projectForPath(workspace.path)?.projectId).toBe(projectId);
    const platform = createCodePlatform(client);
    const opened = vi.fn();
    render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <ProjectDirectoryChoiceProvider>
          <DirectoryBrowser
            services={client.directoryServices()}
            onCancel={() => {}}
            onSelect={async (path) => {
              opened(await platform.activateOrSetWorkspace(path));
            }}
          />
        </ProjectDirectoryChoiceProvider>
      </ZCodeIntlProvider>,
    );
    const workspaceCalls = () =>
      calls.filter((call) => call.service === "workspace");
    try {
      const select = await screen.findByRole("button", {
        name: "选择此目录",
      });
      await screen.findByRole("button", { name: ".." });
      await userEvent.click(select);
      const dialog = await screen.findByRole("dialog", {
        name: "目录已关联项目",
      });
      expect(candidatePaths).toEqual([workspace.path]);
      expect(workspaceCalls()).toEqual([]);
      expect(mutations).toEqual([]);
      expect(opened).not.toHaveBeenCalled();
      expect(select.hasAttribute("disabled")).toBe(true);
      await userEvent.click(
        within(dialog).getByRole("button", {
          name: choice === "复用" ? workspace.name : choice,
        }),
      );
      if (choice === "取消") {
        await screen.findByText("无法读取目录：Error: 已取消目录选择。");
        expect(
          screen.queryByRole("dialog", { name: "目录已关联项目" }),
        ).toBeNull();
        expect(workspaceCalls()).toEqual([]);
        expect(opened).not.toHaveBeenCalled();
        expect(select.hasAttribute("disabled")).toBe(false);
      } else {
        const expectedProjectId =
          choice === "复用" ? projectId : independentProjectId;
        await waitFor(() =>
          expect(opened).toHaveBeenCalledWith({
            activated: false,
            workspacePath: workspace.path,
            workspaceIdentity: JSON.stringify([
              expectedProjectId,
              workspace.path,
            ]),
          }),
        );
        expect(workspaceCalls()).toEqual([
          {
            connectionId: "test-host",
            service: "workspace",
            method: "open",
            args: [
              {
                path: workspace.path,
                ...(choice === "复用"
                  ? { projectId }
                  : { directoryChoice: "independent" }),
                preset,
              },
            ],
          },
        ]);
      }
      expect(mutations).toEqual([]);
      expect(JSON.stringify(calls)).not.toMatch(/canvasId|taskId/);
    } finally {
      client.dispose();
    }
  },
);

it("原选择器等待真实Project绑定，失败保留目录与重试，Human metadata不派生Task或Canvas", async () => {
  let complete!: (response: Response) => void;
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, options) => {
      if (String(input).endsWith("/events"))
        return codeHostNotificationResponse(options?.signal);
      if (String(input).includes("/api/projects/directory-candidates?"))
        return Response.json({ projects: [] });
      const call = JSON.parse(options.body);
      calls.push(call);
      if (call.service === "system")
        return Response.json({
          result: { homedir: "/目录", platform: "darwin" },
        });
      if (call.service === "file") return Response.json({ result: [] });
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    }),
  );
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  const platform = createCodePlatform(client);
  const opened = vi.fn();
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <DirectoryBrowser
        services={client.directoryServices()}
        onCancel={() => {}}
        onSelect={async (path) => {
          await platform.activateOrSetWorkspace(path);
          opened(path);
        }}
      />
    </ZCodeIntlProvider>,
  );
  try {
    const select = await screen.findByRole("button", { name: "选择此目录" });
    await screen.findByRole("button", { name: ".." });
    await userEvent.click(select);
    await waitFor(() => expect(complete).toBeTypeOf("function"));
    expect(select.hasAttribute("disabled")).toBe(true);
    expect(opened).not.toHaveBeenCalled();
    complete(
      Response.json({ error: { message: "目录项目已归档" } }, { status: 409 }),
    );
    await screen.findByText(/目录项目已归档/);
    expect(select.hasAttribute("disabled")).toBe(false);
    await userEvent.click(select);
    await waitFor(() =>
      expect(calls.filter((call) => call.service === "workspace")).toHaveLength(
        2,
      ),
    );
    complete(
      Response.json({
        result: {
          projectId: "71000000-0000-4000-8000-000000000001",
          name: "目录",
          path: "/目录",
          additionalDirectories: [],
        },
      }),
    );
    await waitFor(() => expect(opened).toHaveBeenCalledWith("/目录"));
    expect(
      calls
        .filter((call) => call.service === "file")
        .every((call) =>
          JSON.stringify(call.args).includes("directory-picker"),
        ),
    ).toBe(true);
    expect(
      calls
        .filter((call) => call.service === "workspace")
        .map((call) => call.args),
    ).toEqual([
      [{ path: "/目录", preset: "code" }],
      [{ path: "/目录", preset: "code" }],
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/canvasId|taskId/);
  } finally {
    client.dispose();
  }
});
