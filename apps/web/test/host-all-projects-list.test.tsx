import type { ProjectSummary } from "@kenfutwork/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  AllProjectsList,
  resolveProjectTarget,
} from "@/components/workbench/zcode/host/AllProjectsList";
import "@testing-library/jest-dom/vitest";

const projects: ProjectSummary[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "code",
    name: "代码项目",
    slug: "code",
    description: null,
    workDir: "/code",
    additionalDirectories: [],
    instanceId: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-11-01T00:00:00+00:00",
    updatedAt: "2026-11-01T00:00:00+00:00",
    enabledModes: ["code"],
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    kind: "design",
    name: "画布项目",
    slug: "design",
    description: null,
    additionalDirectories: [],
    instanceId: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-11-01T00:00:00+00:00",
    updatedAt: "2026-11-01T00:00:00+00:00",
    enabledModes: ["design"],
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    kind: "work",
    name: "工作项目",
    slug: "work",
    description: null,
    workDir: "/work",
    additionalDirectories: [],
    instanceId: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-11-01T00:00:00+00:00",
    updatedAt: "2026-11-01T00:00:00+00:00",
    enabledModes: ["work"],
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    kind: "flow",
    name: "流程项目",
    slug: "flow",
    description: null,
    additionalDirectories: [],
    instanceId: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-11-01T00:00:00+00:00",
    updatedAt: "2026-11-01T00:00:00+00:00",
    enabledModes: ["flow"],
    primaryCanvas: {
      id: "00000000-0000-4000-8000-000000000010",
      name: "主画布",
      isPrimary: true,
    },
  },
];

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  selectFlowProject: vi.fn(),
}));
vi.mock("@/components/workbench/zcode/host/flowProjects.js", () => api);
vi.mock("@zui/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({
    workbenchNavigation: {
      open: vi.fn(),
      subscribe: () => () => {},
      getSnapshot: () => ({ mode: "code", availableModes: [] }),
    },
  }),
}));
vi.mock("@/components/workbench/zcode/host/SharedProjectNavigation.js", () => ({
  useSharedProjectNavigation: () => null,
}));

afterEach(cleanup);

it("把四类项目落到各自的工作方式", () => {
  expect(resolveProjectTarget(projects[0]!)).toEqual({
    mode: "code",
    preset: "code",
  });
  expect(resolveProjectTarget(projects[1]!)).toEqual({
    mode: "design",
    preset: "design",
  });
  expect(resolveProjectTarget(projects[2]!)).toEqual({
    mode: "code",
    preset: "code",
  });
  expect(resolveProjectTarget(projects[3]!)).toEqual({ mode: "flow" });
});

it("Code 侧栏直接列出全部项目，不再走弹层", async () => {
  api.listProjects.mockResolvedValue(projects);
  render(<AllProjectsList />);
  expect(screen.queryByRole("button", { name: "全部项目" })).toBeNull();
  expect(screen.getByText("全部项目")).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByText("代码项目")).toBeInTheDocument();
    expect(screen.getByText("工作项目")).toBeInTheDocument();
    expect(screen.getByText("流程项目")).toBeInTheDocument();
  });
});
