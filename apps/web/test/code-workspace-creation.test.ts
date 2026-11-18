import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { codeHostNotificationResponse } from "./setup/code-host-http";

afterEach(() => vi.unstubAllGlobals());

const oldProject = "71000000-0000-4000-8000-000000000001";
const createdProject = "72000000-0000-4000-8000-000000000002";
const taskId = "73000000-0000-4000-8000-000000000003";
const created = {
  projectId: createdProject,
  name: "规范目录",
  path: "/canonical-created",
  additionalDirectories: [],
};

function clientWithCreation(result: unknown) {
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    if (url.endsWith("/events"))
      return codeHostNotificationResponse(options.signal ?? undefined);
    calls.push(JSON.parse(String(options.body)));
    return Response.json({ result });
  });
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  client.registerWorkspaces([
    {
      projectId: oldProject,
      name: "原项目",
      path: "/A",
      additionalDirectories: [],
    },
  ]);
  client.workspaces.registerTask({
    taskId,
    projectId: oldProject,
    workspacePath: "/A",
  });
  return { client, calls };
}

it.each([
  "ensureConversationWorkspace",
  "createDefaultWorkspace",
  "createScratchWorkspace",
] as const)(
  "公开原IFile %s消费真实canonical DTO并只登记Project identity，不初始化Task/Scope",
  async (method) => {
    const { client, calls } = clientWithCreation({
      ...created,
      created: true,
      workspacePurpose: "conversation",
    });
    try {
      await client.connect();
      const result =
        method === "createScratchWorkspace"
          ? await client.services.fileService.createScratchWorkspace({
              name: "新项目",
            })
          : await client.services.fileService[method]();
      expect(result).toHaveProperty(
        "workspaceIdentity",
        JSON.stringify([createdProject, created.path]),
      );
      expect(client.projectForPath(created.path)).toEqual(created);
      expect(client.workspaces.task(taskId)).toEqual({
        taskId,
        projectId: oldProject,
        rootDirectory: "/A",
      });
      expect(calls).toEqual([
        {
          service: "file",
          method,
          connectionId: "test-host",
          args: method === "createScratchWorkspace" ? [{ name: "新项目" }] : [],
        },
      ]);
    } finally {
      client.dispose();
    }
  },
);

it.each([
  "ensureConversationWorkspace",
  "createDefaultWorkspace",
  "createScratchWorkspace",
] as const)(
  "公开原IFile %s拒绝无真实UUID的DTO，不以path或qualified调用方字符串伪造Project",
  async (method) => {
    const { client } = clientWithCreation({
      ...created,
      projectId: JSON.stringify([createdProject, created.path]),
      created: true,
      workspacePurpose: "conversation",
    });
    try {
      await client.connect();
      const read =
        method === "createScratchWorkspace"
          ? client.services.fileService.createScratchWorkspace({
              name: "新项目",
            })
          : client.services.fileService[method]();
      await expect(read).rejects.toThrow("Invalid UUID");
      expect(client.projectForPath(created.path)).toBeNull();
      expect(client.workspaces.task(taskId)).toEqual({
        taskId,
        projectId: oldProject,
        rootDirectory: "/A",
      });
    } finally {
      client.dispose();
    }
  },
);
