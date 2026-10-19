import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  chooseDirectoryProject,
  confirmDirectoryRelink,
  ProjectDirectoryChoiceProvider,
} from "../src/components/workbench/zcode/host/ProjectDirectoryChoice";

const api = vi.hoisted(() => ({ json: vi.fn(), fetch: vi.fn() }));
vi.mock("../src/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: api.json,
  surfaceFetch: api.fetch,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const project = {
  id: "project",
  name: "现有项目",
  kind: "code",
  enabledModes: ["code"],
  workDir: "/shared",
};
it("没有候选时只允许新建，不将探测结果当独立创建授权", async () => {
  api.json.mockResolvedValue({ projects: [] });
  expect(await chooseDirectoryProject("/shared", "design")).toEqual({
    newProject: true,
  });
  expect(api.fetch).not.toHaveBeenCalled();
});
it("复用跨模式项目须明确选择，选择后才开启工作方式", async () => {
  api.json.mockResolvedValue({ projects: [project] });
  api.fetch.mockResolvedValue({ ok: true });
  render(
    <ProjectDirectoryChoiceProvider>
      <span>工作台</span>
    </ProjectDirectoryChoiceProvider>,
  );
  let answer!: ReturnType<typeof chooseDirectoryProject>;
  await act(async () => {
    answer = chooseDirectoryProject("/shared", "design");
  });
  expect(api.fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "现有项目" }));
  expect(await answer).toEqual({ projectId: "project" });
  expect(api.fetch).toHaveBeenCalledWith(
    "/api/projects/project",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ enabled_modes: ["code", "design"] }),
    }),
  );
});
it("独立创建与取消均不改变既有项目", async () => {
  api.json.mockResolvedValue({ projects: [project] });
  render(
    <ProjectDirectoryChoiceProvider>
      <span>工作台</span>
    </ProjectDirectoryChoiceProvider>,
  );
  let answer!: ReturnType<typeof chooseDirectoryProject>;
  await act(async () => {
    answer = chooseDirectoryProject("/shared", "design");
  });
  fireEvent.click(screen.getByRole("button", { name: "独立创建" }));
  expect(await answer).toEqual({ independent: true });
  await act(async () => {
    answer = chooseDirectoryProject("/shared", "code");
  });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(await answer).toBeNull();
  expect(api.fetch).not.toHaveBeenCalled();
});
it("关闭工作台会结算全部等待选择，避免挂起打开目录", async () => {
  api.json.mockResolvedValue({ projects: [project] });
  const view = render(
    <ProjectDirectoryChoiceProvider>
      <span>工作台</span>
    </ProjectDirectoryChoiceProvider>,
  );
  let first!: ReturnType<typeof chooseDirectoryProject>,
    second!: ReturnType<typeof chooseDirectoryProject>;
  await act(async () => {
    first = chooseDirectoryProject("/shared", "code");
    second = chooseDirectoryProject("/shared", "design");
  });
  view.unmount();
  expect(await Promise.all([first, second])).toEqual([null, null]);
});
it("恢复已有目录只允许明确共用或取消，不复用项目或启用其模式", async () => {
  api.json.mockResolvedValue({
    projects: [
      project,
      {
        ...project,
        id: "flow-project",
        name: "Flow 项目",
        kind: "flow",
        enabledModes: ["flow"],
      },
    ],
  });
  render(
    <ProjectDirectoryChoiceProvider>
      <span>工作台</span>
    </ProjectDirectoryChoiceProvider>,
  );
  let answer!: ReturnType<typeof confirmDirectoryRelink>;
  await act(async () => {
    answer = confirmDirectoryRelink("/shared", "recovering");
  });
  expect(screen.queryByRole("button", { name: "现有项目" })).toBeNull();
  expect(screen.getByText("Flow 项目")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(await answer).toBeNull();
  await act(async () => {
    answer = confirmDirectoryRelink("/shared", "recovering");
  });
  fireEvent.click(screen.getByRole("button", { name: "共用目录" }));
  expect(await answer).toBe("independent");
  expect(api.fetch).not.toHaveBeenCalled();
});
it("恢复候选排除当前项目，空列表不授予独立共用授权", async () => {
  api.json.mockResolvedValue({ projects: [project] });
  expect(await confirmDirectoryRelink("/shared", project.id)).toBe(
    "unassociated",
  );
  expect(api.fetch).not.toHaveBeenCalled();
});
