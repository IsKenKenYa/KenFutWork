import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createProjectService } from "../features/projects/project-service.js";
import { createMemoryTaskWorkManager } from "../features/task-work/test-store.js";
import { createStartupPersistenceFixture } from "../test-startup-persistence.js";

/**
 * 工作目录（`projects.work_dir`，web 形态「填本机路径」）的 **HTTP 边界**回归。
 *
 * 为什么必须有这一层：真机验收时 `POST /api/projects` 带相对路径返回的**不是**
 * `{error:{code:"invalid_work_dir",message:…}}`，而是 Fastify 的 ZodError 转储——
 * 因为 `invalid_work_dir` 不在 `applicationErrorCodeSchema` 里，路由的
 * `applicationErrorResponseSchema.parse()` 自己炸了，**服务端给出的可读原因整段丢失**，
 * 客户端只看到乱码 JSON。服务层单测抓不到（它只看抛出的错误对象），契约枚举单测也抓不到
 * （它不知道谁在用哪个码）——只有真发一次请求才看得到。
 */

const USER = {
  accessToken: "tok",
  email: "u@example.com",
  id: "user-1",
  userMetadata: {},
};

const WORKSPACE = {
  id: "ws-1",
  name: "Personal Workspace",
  ownerUserId: USER.id,
  type: "personal" as const,
};

function buildHttpApp(
  overrides: { createdWorkDir?: (v?: string) => void } = {},
) {
  const projectService = createProjectService({
    blob: {
      bucket: () => ({
        getPublicUrl: (path: string) => `https://blob.test/${path}`,
        resolveUrl: async (path: string) => `https://blob.test/${path}`,
        upload: async () => {},
      }),
    } as never,
    repository: {
      archive: async () => 1,
      createProject: async (input: never) => {
        const typed = input as unknown as {
          id: string;
          name: string;
          slug: string;
          workDir?: string;
        };
        overrides.createdWorkDir?.(typed.workDir);
        return {
          canvas: null,
          project: {
            id: typed.id,
            kind: "code" as const,
            name: typed.name,
            slug: typed.slug,
            description: null,
            created_at: "2026-09-17T00:00:00+00:00",
            updated_at: "2026-09-17T00:00:00+00:00",
            workspace_id: WORKSPACE.id,
            work_dir: typed.workDir ?? null,
            additional_directories: [],
          },
        };
      },
      findActiveById: async () => null,
      listActive: async () => [],
      listPrimaryCanvases: async () => [],
      setThumbnailPath: async () => 1,
      update: async () => 1,
      findWorkDirByCanvas: async () => null,
    } as never,
    viewerService: {
      ensureViewer: async () => undefined,
      resolveWorkspace: async () => WORKSPACE,
    } as never,
  });

  const app = buildApp({
    env: {
      databaseUrl: "postgres://localhost:5432/loenfut-test",
      blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
      credentialSecret: "test-secret",
    },
    overrides: {
      taskWork: createMemoryTaskWorkManager(),
      persistence: createStartupPersistenceFixture(),
      auth: {
        authenticate: async () => USER,
        resolveUser: async () => USER,
      } as never,
      projects: projectService as never,
    },
  });

  return { app };
}

describe("POST /api/projects 绑定本机工作目录（HTTP 边界）", () => {
  it("相对路径：400 且响应体是可读的 invalid_work_dir（不是 ZodError 转储）", async () => {
    const { app } = buildHttpApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { kind: "code", name: "test", work_dir: "Desktop\\test" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json() as {
        error?: { code?: string; message?: string };
      };
      expect(body.error?.code).toBe("invalid_work_dir");
      expect(body.error?.message).toContain("不是绝对路径");
      expect(response.body).not.toContain("invalid_value");
    } finally {
      await app.close();
    }
  });

  it("不存在的目录：400 且原因里带路径本身", async () => {
    const missing = join(tmpdir(), "kenfut-work-dir-missing");
    const { app } = buildHttpApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { kind: "code", name: "test", work_dir: missing },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json() as {
        error?: { code?: string; message?: string };
      };
      expect(body.error?.code).toBe("invalid_work_dir");
      expect(body.error?.message).toContain("目录不存在");
      expect(body.error?.message).toContain(resolve(missing));
    } finally {
      await app.close();
    }
  });

  it("真目录：201 且落库的是归一化后的路径", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kenfut-work-dir-"));
    let stored: string | undefined;
    const { app } = buildHttpApp({
      createdWorkDir: (value) => {
        stored = value;
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { kind: "code", name: "test", work_dir: `${dir}/` },
      });

      expect(response.statusCode, response.body).toBe(201);
      expect(stored).toBe(realpathSync(dir));
      expect(response.json().project.workDir).toBe(realpathSync(dir));
      expect(response.json().project).toMatchObject({
        kind: "code",
        additionalDirectories: [],
      });
      expect(response.json().project).not.toHaveProperty("primaryCanvas");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
