import {
  applicationErrorCodeSchema,
  runTimelineResponseSchema,
  taskRunsResponseSchema,
} from "@kenfutwork/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { RUNTIME_TEST_ACTOR } from "../agent/runtime-test-fixtures.js";
import { createRunTimelineService } from "../features/run-timeline/service.js";
import type { RunTimelineRepository } from "../features/run-timeline/types.js";
import { registerRunTimelineRoutes } from "./run-timeline.js";

const RUN_ID = "run-1";
const ROOT_SESSION_ID = "session-1";
const AT = "2026-11-04T00:00:00.000Z";

const RUN_ROW = {
  runId: RUN_ID,
  rootSessionId: ROOT_SESSION_ID,
  model: "model-x",
  status: "completed" as const,
  stopReason: "completed",
  errorCode: null,
  errorMessage: null,
  startedAt: AT,
  completedAt: AT,
};

function repository(
  overrides: Partial<RunTimelineRepository> = {},
): RunTimelineRepository {
  return {
    loadRun: async () => RUN_ROW,
    loadEvents: async () => [
      {
        seq: 1,
        createdAt: AT,
        event: {
          type: "tool.started",
          runId: RUN_ID,
          toolCallId: "read-1",
          toolName: "Read",
          input: { file_path: "src/a.ts" },
          timestamp: AT,
        },
      },
    ],
    loadChildSessions: async () => [],
    loadChildEvents: async () => [],
    loadUsage: async () => ({
      inputTokens: 120,
      outputTokens: 60,
      costUsd: null,
    }),
    listRunsForTask: async () => [],
    ...overrides,
  };
}

function buildApp(
  authenticated: boolean,
  timelineRepository: RunTimelineRepository = repository(),
) {
  const app = Fastify();
  void registerRunTimelineRoutes(app, {
    localAccess: {
      authenticate: async () => (authenticated ? RUNTIME_TEST_ACTOR : null),
    },
    timeline: createRunTimelineService({ repository: timelineRepository }),
  });
  return app;
}

describe("GET /api/agent/runs/:runId/timeline", () => {
  it("本机授权后返回过契约的时间线，并按本机实例查询", async () => {
    const seen: string[] = [];
    const app = buildApp(
      true,
      repository({
        loadRun: async (instanceId) => {
          seen.push(instanceId);
          return RUN_ROW;
        },
      }),
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/agent/runs/${RUN_ID}/timeline`,
      });

      expect(response.statusCode).toBe(200);
      const body = runTimelineResponseSchema.parse(response.json());
      expect(seen).toEqual([RUNTIME_TEST_ACTOR.instanceId]);
      expect(body.run).toMatchObject({ runId: RUN_ID, status: "completed" });
      expect(body.run.usage).toEqual({
        inputTokens: 120,
        outputTokens: 60,
        costUsd: null,
      });
      expect(body.entries).toEqual([
        {
          kind: "tool",
          seq: 1,
          at: AT,
          title: "Read",
          status: "running",
          name: "Read",
          detail: "src/a.ts",
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("运行不存在或属于别的实例：404 且错误码在共享枚举内", async () => {
    const app = buildApp(true, repository({ loadRun: async () => null }));
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/agent/runs/${RUN_ID}/timeline`,
      });

      expect(response.statusCode).toBe(404);
      const error = response.json() as { error: { code: string } };
      expect(error.error.code).toBe("run_not_found");
      expect(applicationErrorCodeSchema.safeParse(error.error.code).success).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  it("未获本机授权：401（不外泄运行数据）", async () => {
    const app = buildApp(false);
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/agent/runs/${RUN_ID}/timeline`,
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/agent/tasks/:taskId/runs", () => {
  it("按本机实例、项目与 Task 查询轮次，并过契约返回", async () => {
    const seen: unknown[] = [];
    const app = buildApp(
      true,
      repository({
        listRunsForTask: async (input) => {
          seen.push(input);
          return [
            {
              runId: RUN_ID,
              status: "completed",
              stopReason: "completed",
              errorCode: null,
              errorMessage: null,
              startedAt: AT,
              completedAt: AT,
            },
          ];
        },
      }),
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/tasks/task-1/runs?projectId=project-1&limit=3",
      });

      expect(response.statusCode).toBe(200);
      const body = taskRunsResponseSchema.parse(response.json());
      expect(seen).toEqual([
        {
          instanceId: RUNTIME_TEST_ACTOR.instanceId,
          projectId: "project-1",
          taskId: "task-1",
          limit: 3,
        },
      ]);
      expect(body).toEqual({
        taskId: "task-1",
        runs: [
          {
            runId: RUN_ID,
            status: "completed",
            stopReason: "completed",
            errorCode: null,
            errorMessage: null,
            startedAt: AT,
            completedAt: AT,
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it("未传 limit 时按默认上限查询", async () => {
    const seen: unknown[] = [];
    const app = buildApp(
      true,
      repository({
        listRunsForTask: async (input) => {
          seen.push(input);
          return [];
        },
      }),
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/tasks/task-1/runs?projectId=project-1",
      });

      expect(response.statusCode).toBe(200);
      expect(seen).toEqual([
        {
          instanceId: RUNTIME_TEST_ACTOR.instanceId,
          projectId: "project-1",
          taskId: "task-1",
          limit: 20,
        },
      ]);
      expect(taskRunsResponseSchema.parse(response.json())).toEqual({
        taskId: "task-1",
        runs: [],
      });
    } finally {
      await app.close();
    }
  });

  it("缺少或非法 projectId：400", async () => {
    const app = buildApp(true);
    try {
      const missing = await app.inject({
        method: "GET",
        url: "/api/agent/tasks/task-1/runs",
      });
      expect(missing.statusCode).toBe(400);
      expect((missing.json() as { error: { code: string } }).error.code).toBe(
        "invalid_input",
      );

      const empty = await app.inject({
        method: "GET",
        url: "/api/agent/tasks/task-1/runs?projectId=",
      });
      expect(empty.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("limit 越界或非整数：400", async () => {
    const app = buildApp(true);
    try {
      for (const limit of ["0", "51", "1.5", "abc"]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/agent/tasks/task-1/runs?projectId=project-1&limit=${limit}`,
        });
        expect(response.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it("未获本机授权：401", async () => {
    const app = buildApp(false);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/tasks/task-1/runs?projectId=project-1",
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/agent/runs/:runId/timeline/export", () => {
  it("返回 Markdown 附件，文件名带运行 id", async () => {
    const app = buildApp(true);
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/agent/runs/${RUN_ID}/timeline/export`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/markdown");
      expect(response.headers["content-disposition"]).toContain(
        `filename="run-${RUN_ID}-timeline.md"`,
      );
      expect(response.body).toContain(`# 运行时间线 · ${RUN_ID}`);
      expect(response.body).toContain("Read");
    } finally {
      await app.close();
    }
  });

  it("运行不存在：404 且错误码在共享枚举内", async () => {
    const app = buildApp(true, repository({ loadRun: async () => null }));
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/agent/runs/${RUN_ID}/timeline/export`,
      });

      expect(response.statusCode).toBe(404);
      const error = response.json() as { error: { code: string } };
      expect(error.error.code).toBe("run_not_found");
      expect(
        applicationErrorCodeSchema.safeParse(error.error.code).success,
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("未获本机授权：401", async () => {
    const app = buildApp(false);
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/agent/runs/${RUN_ID}/timeline/export`,
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
