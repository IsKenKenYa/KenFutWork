import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsumerLocalAccessService } from "../features/local-access/test-consumer-service.js";
import { LocalInstanceError } from "../features/local-instance/service.js";
import {
  type ProjectService,
  ProjectServiceError,
} from "../features/projects/project-service.js";
import type { ProjectDetailRow } from "../features/projects/repository.js";
import { registerProjectRoutes } from "./projects.js";

const actor = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  accessClientId: "directory-candidate-client",
};
const directory = "/项目资源/有 空格";
const project: ProjectDetailRow = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "design",
  enabled_modes: ["design", "code"],
  name: "共享项目",
  slug: "shared-project",
  description: null,
  instance_id: actor.instanceId,
  brand_kit_id: null,
  created_at: "2026-10-15T00:00:00.000Z",
  updated_at: "2026-10-15T00:00:00.000Z",
  work_dir: directory,
  additional_directories: [],
};
const independent: ProjectDetailRow = {
  ...project,
  id: "33333333-3333-4333-8333-333333333333",
  kind: "code",
  enabled_modes: ["code"],
  name: "独立项目",
  slug: "independent-project",
};
const url = "/api/projects/directory-candidates";
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(
  options: {
    authenticated?: boolean;
    projects?: ProjectDetailRow[];
    error?: Error;
  } = {},
) {
  const directoryProjects = vi.fn<ProjectService["directoryProjects"]>(
    async () => {
      if (options.error) throw options.error;
      return options.projects ?? [project, independent];
    },
  );
  const unused = async (): Promise<never> => {
    throw new Error("目录候选查询不应修改项目或创建资源");
  };
  const createProject = vi.fn(unused);
  const updateProject = vi.fn(unused);
  const projectService = {
    directoryProjects,
    createProject,
    updateProject,
    openCodeDirectory: unused,
    archiveProject: unused,
    getProject: unused,
    listProjects: unused,
    saveThumbnail: unused,
  };
  const app = Fastify();
  apps.push(app);
  await registerProjectRoutes(app, {
    localAccess: createConsumerLocalAccessService(async () =>
      options.authenticated === false ? null : actor,
    ),
    projectService,
  });
  return { app, directoryProjects, createProject, updateProject };
}

describe("同目录项目候选的HTTP边界", () => {
  it("静态查询路由保留同目录不同项目与启用方式，只投影公开选择信息", async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: "GET",
      url: `${url}?path=${encodeURIComponent(`  ${directory}  `)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      projects: [
        {
          id: project.id,
          name: "共享项目",
          kind: "design",
          enabledModes: ["design", "code"],
          workDir: directory,
        },
        {
          id: independent.id,
          name: "独立项目",
          kind: "code",
          enabledModes: ["code"],
          workDir: directory,
        },
      ],
    });
    expect(f.directoryProjects).toHaveBeenCalledExactlyOnceWith(
      actor,
      directory,
    );
    expect(f.createProject).not.toHaveBeenCalled();
    expect(f.updateProject).not.toHaveBeenCalled();
  });

  it("没有候选返回空列表，不自动创建项目或启用工作方式", async () => {
    const f = await fixture({ projects: [] });
    const response = await f.app.inject({
      method: "GET",
      url: `${url}?path=${encodeURIComponent(directory)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ projects: [] });
    expect(f.createProject).not.toHaveBeenCalled();
    expect(f.updateProject).not.toHaveBeenCalled();
  });

  it("未鉴权时拒绝查询，不读取目录归属", async () => {
    const f = await fixture({ authenticated: false });
    const response = await f.app.inject({
      method: "GET",
      url: `${url}?path=${encodeURIComponent(directory)}`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "缺少或无效的本机接入凭据。",
      },
    });
    expect(f.directoryProjects).not.toHaveBeenCalled();
  });

  it.each(["", "?path=", "?path=%20%20", "?path=/one&path=/two"])(
    "无效查询 %s 返回可读400，不读取目录归属",
    async (query) => {
      const f = await fixture();
      const response = await f.app.inject({
        method: "GET",
        url: `${url}${query}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        message: "目录参数无效，请重新选择文件夹。",
      });
      expect(f.directoryProjects).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      status: 400,
      code: "invalid_work_dir",
      error: new ProjectServiceError(
        "invalid_work_dir",
        "目录不可用，请重新选择。",
        400,
      ),
    },
    {
      status: 503,
      code: "project_query_failed",
      error: new ProjectServiceError(
        "project_query_failed",
        "项目暂不可读，请稍后重试。",
        503,
      ),
    },
    {
      status: 403,
      code: "instance_forbidden",
      error: new LocalInstanceError(),
    },
  ])(
    "服务拒绝$status保留状态、错误码与原因",
    async ({ status, code, error }) => {
      const f = await fixture({ error });
      const response = await f.app.inject({
        method: "GET",
        url: `${url}?path=${encodeURIComponent(directory)}`,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        error: { code, message: error.message },
      });
      expect(f.createProject).not.toHaveBeenCalled();
      expect(f.updateProject).not.toHaveBeenCalled();
    },
  );

  it("未知服务异常返回查询失败，不暴露内部异常文字或伪造空列表", async () => {
    const f = await fixture({ error: new Error("private database failure") });
    const response = await f.app.inject({
      method: "GET",
      url: `${url}?path=${encodeURIComponent(directory)}`,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "project_query_failed",
        message: "Unable to load projects.",
      },
    });
  });
});
