import type { WorkspaceSettings } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../auth/types.js";
import { SqlError } from "../persistence/errors.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import type { SettingsRepository } from "./repository.js";
import { createSettingsRepository } from "./repository.js";
import {
  createSettingsService,
  SettingsServiceError,
} from "./settings-service.js";

const USER_ID = "user-1";
const WORKSPACE_ID = "ws-1";

const USER: AuthenticatedUser = {
  accessToken: "token",
  email: "user@example.com",
  id: USER_ID,
  userMetadata: {},
};

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRunner(
  respond: (text: string) => FakeResult = () => ({ rowCount: 0, rows: [] }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  const runner: PostgresQueryRunner = {
    async query(text, values) {
      return run(text, values);
    },
    async acquire() {
      return {
        query: async (text, values) => run(text, values),
        release: () => {},
      };
    },
    async end() {},
  };

  return {
    calls,
    sqls: () => calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
    runner,
  };
}

/** 全 null 读 + 空 upsert 的仓储假体；只覆写关注的列，避免每个用例抄一遍 20 个方法。 */
function createRepositoryFake(
  overrides: Partial<SettingsRepository> = {},
): SettingsRepository {
  return {
    findDefaultModel: async () => null,
    findAgentMaxRetries: async () => null,
    findTerminalShell: async () => null,
    findCodeIndexEnabled: async () => null,
    findCodeIndexAutoNewFolder: async () => null,
    findAutoCompactEnabled: async () => null,
    findCommands: async () => null,
    findHooks: async () => null,
    findUserRules: async () => null,
    findSubagentMaxDepth: async () => null,
    findSubagentMaxConcurrency: async () => null,
    findLlmRequestMaxRetries: async () => null,
    findLlmInfiniteRetry: async () => null,
    findExecuteTimeoutMs: async () => null,
    findSubagentMaxContinuations: async () => null,
    upsertDefaultModel: async () => {},
    upsertAgentMaxRetries: async () => {},
    upsertTerminalShell: async () => {},
    upsertCodeIndexEnabled: async () => {},
    upsertCodeIndexAutoNewFolder: async () => {},
    upsertAutoCompactEnabled: async () => {},
    upsertCommands: async () => {},
    upsertHooks: async () => {},
    upsertUserRules: async () => {},
    upsertRuleEntries: async () => {},
    upsertSubagentMaxDepth: async () => {},
    upsertSubagentMaxConcurrency: async () => {},
    upsertLlmRequestMaxRetries: async () => {},
    upsertLlmInfiniteRetry: async () => {},
    upsertExecuteTimeoutMs: async () => {},
    upsertSubagentMaxContinuations: async () => {},
    ...overrides,
  };
}

describe("settings repository", () => {
  it("读默认模型限定工作区，无行返回 null", async () => {
    const empty = createRunner();
    await expect(
      createSettingsRepository(
        createPersistenceFromRunner(empty.runner),
      ).findDefaultModel(WORKSPACE_ID),
    ).resolves.toBeNull();
    expect(empty.sqls()[0]).toBe(
      "select default_model from public.workspace_settings where workspace_id = $1",
    );
    expect(empty.calls[0]?.values).toEqual([WORKSPACE_ID]);

    const hit = createRunner(() => ({
      rowCount: 1,
      rows: [{ default_model: "gpt-5.4" }],
    }));
    await expect(
      createSettingsRepository(
        createPersistenceFromRunner(hit.runner),
      ).findDefaultModel(WORKSPACE_ID),
    ).resolves.toBe("gpt-5.4");
  });

  it("upsert 以工作区为主键冲突即更新，工作区值经 :workspace 绑定", async () => {
    const { calls, runner } = createRunner();
    await createSettingsRepository(
      createPersistenceFromRunner(runner),
    ).upsertDefaultModel(WORKSPACE_ID, "gemini-2.5-flash");

    expect(calls[0]?.text.replace(/\s+/g, " ").trim()).toBe(
      "insert into public.workspace_settings (workspace_id, default_model) values ($2, $1) on conflict (workspace_id) do update set default_model = excluded.default_model",
    );
    expect(calls[0]?.values).toEqual(["gemini-2.5-flash", WORKSPACE_ID]);
  });
});

describe("settings service", () => {
  it("无行时落回退默认值，有行时用库值", async () => {
    const fallback = createSettingsService({
      repository: createRepositoryFake(),
      defaultModel: "fallback-model",
    });
    await expect(
      fallback.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toEqual({
      agentMaxRetries: 10,
      defaultModel: "fallback-model",
      terminalShell: "auto",
      codeIndexEnabled: false,
      codeIndexAutoNewFolder: true,
      autoCompactEnabled: true,
      commands: [],
      hooks: [],
      ruleEntries: [],
      userRules: "",
      subagentMaxDepth: 1,
      subagentMaxConcurrency: 4,
      llmRequestMaxRetries: 10,
      llmInfiniteRetry: false,
      executeTimeoutMs: 120000,
      subagentMaxContinuations: 50,
      computerUseActionTimeoutMs: 10000,
      computerUseObserveMaxBytes: 32768,
      computerUseScreenshotMaxBytes: 262144,
      computerUseMaxActionsPerRun: 200,
      computerUseSessionMaxMs: 1800000,
    });

    const stored = createSettingsService({
      repository: createRepositoryFake({
        findDefaultModel: async () => "stored-model",
      }),
      defaultModel: "fallback-model",
    });
    await expect(
      stored.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toEqual({
      agentMaxRetries: 10,
      defaultModel: "stored-model",
      terminalShell: "auto",
      codeIndexEnabled: false,
      codeIndexAutoNewFolder: true,
      autoCompactEnabled: true,
      commands: [],
      hooks: [],
      ruleEntries: [],
      userRules: "",
      subagentMaxDepth: 1,
      subagentMaxConcurrency: 4,
      llmRequestMaxRetries: 10,
      llmInfiniteRetry: false,
      executeTimeoutMs: 120000,
      subagentMaxContinuations: 50,
      computerUseActionTimeoutMs: 10000,
      computerUseObserveMaxBytes: 32768,
      computerUseScreenshotMaxBytes: 262144,
      computerUseMaxActionsPerRun: 200,
      computerUseSessionMaxMs: 1800000,
    });
  });

  /**
   * 回归（GUI 实测）：无工作区设置时，静态兜底是 env 里的内置目录名（如 `gpt-4.1`），
   * 而实际可用模型由供应商实例决定。画布助手这类**不显式传 model** 的客户端会拿到该
   * 不存在的模型，上游直接拒绝 → 客户端只看到「处理过程中遇到问题」并重试 10 次。
   * 故无库值时必须优先用目录解析出的真实模型，只有目录为空才退回静态名。
   */
  it("无库值时用目录兜底（而非不存在的静态名），有库值时不再问目录", async () => {
    const noStore = createRepositoryFake();

    const withCatalog = createSettingsService({
      repository: noStore,
      defaultModel: "gpt-4.1",
      resolveFallbackModel: async () => "inst-1:glm-5.3-flash",
    });
    await expect(
      withCatalog.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toEqual({
      agentMaxRetries: 10,
      defaultModel: "inst-1:glm-5.3-flash",
      terminalShell: "auto",
      codeIndexEnabled: false,
      codeIndexAutoNewFolder: true,
      autoCompactEnabled: true,
      commands: [],
      hooks: [],
      ruleEntries: [],
      userRules: "",
      subagentMaxDepth: 1,
      subagentMaxConcurrency: 4,
      llmRequestMaxRetries: 10,
      llmInfiniteRetry: false,
      executeTimeoutMs: 120000,
      subagentMaxContinuations: 50,
      computerUseActionTimeoutMs: 10000,
      computerUseObserveMaxBytes: 32768,
      computerUseScreenshotMaxBytes: 262144,
      computerUseMaxActionsPerRun: 200,
      computerUseSessionMaxMs: 1800000,
    });

    const emptyCatalog = createSettingsService({
      repository: noStore,
      defaultModel: "gpt-4.1",
      resolveFallbackModel: async () => undefined,
    });
    await expect(
      emptyCatalog.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toEqual({
      agentMaxRetries: 10,
      defaultModel: "gpt-4.1",
      terminalShell: "auto",
      codeIndexEnabled: false,
      codeIndexAutoNewFolder: true,
      autoCompactEnabled: true,
      commands: [],
      hooks: [],
      ruleEntries: [],
      userRules: "",
      subagentMaxDepth: 1,
      subagentMaxConcurrency: 4,
      llmRequestMaxRetries: 10,
      llmInfiniteRetry: false,
      executeTimeoutMs: 120000,
      subagentMaxContinuations: 50,
      computerUseActionTimeoutMs: 10000,
      computerUseObserveMaxBytes: 32768,
      computerUseScreenshotMaxBytes: 262144,
      computerUseMaxActionsPerRun: 200,
      computerUseSessionMaxMs: 1800000,
    });

    let catalogCalls = 0;
    const stored = createSettingsService({
      repository: { ...noStore, findDefaultModel: async () => "stored-model" },
      defaultModel: "gpt-4.1",
      resolveFallbackModel: async () => {
        catalogCalls += 1;
        return "inst-1:glm-5.3-flash";
      },
    });
    await expect(
      stored.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toEqual({
      agentMaxRetries: 10,
      defaultModel: "stored-model",
      terminalShell: "auto",
      codeIndexEnabled: false,
      codeIndexAutoNewFolder: true,
      autoCompactEnabled: true,
      commands: [],
      hooks: [],
      ruleEntries: [],
      userRules: "",
      subagentMaxDepth: 1,
      subagentMaxConcurrency: 4,
      llmRequestMaxRetries: 10,
      llmInfiniteRetry: false,
      executeTimeoutMs: 120000,
      subagentMaxContinuations: 50,
      computerUseActionTimeoutMs: 10000,
      computerUseObserveMaxBytes: 32768,
      computerUseScreenshotMaxBytes: 262144,
      computerUseMaxActionsPerRun: 200,
      computerUseSessionMaxMs: 1800000,
    });
    expect(catalogCalls).toBe(0);
  });

  it("读写失败分别映射 settings_read_failed / settings_update_failed", async () => {
    const readFailure = createSettingsService({
      repository: createRepositoryFake({
        findDefaultModel: async () => {
          throw new SqlError("connection reset");
        },
      }),
    });
    await expect(
      readFailure.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).rejects.toMatchObject({
      code: "settings_read_failed",
      statusCode: 500,
    });

    const writeFailure = createSettingsService({
      repository: createRepositoryFake({
        upsertDefaultModel: async () => {
          throw new SqlError("permission denied", { code: "42501" });
        },
      }),
    });
    const error = await writeFailure
      .updateWorkspaceSettings(USER, WORKSPACE_ID, {
        agentMaxRetries: 10,
        defaultModel: "x",
        terminalShell: "auto",
        codeIndexEnabled: false,
        codeIndexAutoNewFolder: true,
        autoCompactEnabled: true,
        commands: [],
        hooks: [],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettingsServiceError);
    expect(error).toMatchObject({
      code: "settings_update_failed",
      statusCode: 500,
    });
  });

  /**
   * 更新是**部分更新**：只写送来的字段，返回的也是回读真值（不是「我以为写成了什么」）。
   * 这里用一个小内存仓储当真相，锁住三件事：写入的字段生效、没送的字段一个字不动、
   * 返回的是库里的完整设置。
   */
  it("部分更新：只写送来的字段，返回回读真值", async () => {
    let stored = {
      defaultModel: "inst-1:glm-5.3-flash" as string | null,
      agentMaxRetries: 3 as number | null,
      terminalShell: "git-bash" as WorkspaceSettings["terminalShell"] | null,
      codeIndexEnabled: null as boolean | null,
      codeIndexAutoNewFolder: null as boolean | null,
      autoCompactEnabled: null as boolean | null,
      commands: null as unknown,
      hooks: null as unknown,
      userRules: null as string | null,
      ruleEntries: null as string[] | null,
    };
    const service = createSettingsService({
      repository: {
        ...createRepositoryFake(),
        findDefaultModel: async () => stored.defaultModel,
        findAgentMaxRetries: async () => stored.agentMaxRetries,
        findTerminalShell: async () => stored.terminalShell,
        findCodeIndexEnabled: async () => null,
        findCodeIndexAutoNewFolder: async () => null,
        findAutoCompactEnabled: async () => null,
        findCommands: async () => null,
        findHooks: async () => null,
        findUserRules: async () => null,
        upsertDefaultModel: async (_workspaceId, defaultModel) => {
          stored = { ...stored, defaultModel };
        },
        upsertAgentMaxRetries: async (_workspaceId, agentMaxRetries) => {
          stored = { ...stored, agentMaxRetries };
        },
        upsertTerminalShell: async (_workspaceId, terminalShell) => {
          stored = { ...stored, terminalShell };
        },
        upsertCodeIndexEnabled: async (_workspaceId, codeIndexEnabled) => {
          stored = { ...stored, codeIndexEnabled };
        },
        upsertCodeIndexAutoNewFolder: async (
          _workspaceId,
          codeIndexAutoNewFolder,
        ) => {
          stored = { ...stored, codeIndexAutoNewFolder };
        },
        upsertAutoCompactEnabled: async (_workspaceId, autoCompactEnabled) => {
          stored = { ...stored, autoCompactEnabled };
        },
        upsertCommands: async (_workspaceId, commands) => {
          stored = { ...stored, commands: commands as never };
        },
        upsertHooks: async (_workspaceId, hooks) => {
          stored = { ...stored, hooks: hooks as never };
        },
        upsertUserRules: async (_workspaceId, userRules) => {
          stored = { ...stored, userRules };
        },
        upsertRuleEntries: async (_workspaceId, ruleEntries) => {
          stored = { ...stored, ruleEntries };
        },
      },
    });

    // 只改模型：重试上限与终端 shell 必须原样保留（整对象写入会把它俩重置成默认）
    await expect(
      service.updateWorkspaceSettings(USER, WORKSPACE_ID, {
        defaultModel: "gemini-2.5-flash",
      }),
    ).resolves.toEqual({
      agentMaxRetries: 3,
      defaultModel: "gemini-2.5-flash",
      terminalShell: "git-bash",
      codeIndexEnabled: false,
      codeIndexAutoNewFolder: true,
      autoCompactEnabled: true,
      commands: [],
      hooks: [],
      ruleEntries: [],
      userRules: "",
      subagentMaxDepth: 1,
      subagentMaxConcurrency: 4,
      llmRequestMaxRetries: 10,
      llmInfiniteRetry: false,
      executeTimeoutMs: 120000,
      subagentMaxContinuations: 50,
      computerUseActionTimeoutMs: 10000,
      computerUseObserveMaxBytes: 32768,
      computerUseScreenshotMaxBytes: 262144,
      computerUseMaxActionsPerRun: 200,
      computerUseSessionMaxMs: 1800000,
    });

    // 只改终端 shell：模型与重试上限不动
    await expect(
      service.updateWorkspaceSettings(USER, WORKSPACE_ID, {
        terminalShell: "powershell",
      }),
    ).resolves.toEqual({
      agentMaxRetries: 3,
      codeIndexEnabled: false,
      codeIndexAutoNewFolder: true,
      autoCompactEnabled: true,
      commands: [],
      hooks: [],
      ruleEntries: [],
      userRules: "",
      subagentMaxDepth: 1,
      subagentMaxConcurrency: 4,
      subagentMaxContinuations: 50,
      computerUseActionTimeoutMs: 10000,
      computerUseObserveMaxBytes: 32768,
      computerUseScreenshotMaxBytes: 262144,
      computerUseMaxActionsPerRun: 200,
      computerUseSessionMaxMs: 1800000,
      llmRequestMaxRetries: 10,
      llmInfiniteRetry: false,
      executeTimeoutMs: 120000,
      defaultModel: "gemini-2.5-flash",
      terminalShell: "powershell",
    });
  });
});

describe("agent 治理设置（DEC-17/DEC-18：禁止硬编码，全部走 workspace_settings）", () => {
  it("repository：治理列逐列读写，SQL 形状与绑定正确", async () => {
    const empty = createRunner();
    await expect(
      createSettingsRepository(
        createPersistenceFromRunner(empty.runner),
      ).findSubagentMaxDepth(WORKSPACE_ID),
    ).resolves.toBeNull();
    expect(empty.sqls()[0]).toBe(
      "select subagent_max_depth from public.workspace_settings where workspace_id = $1",
    );

    const { calls, runner } = createRunner();
    await createSettingsRepository(
      createPersistenceFromRunner(runner),
    ).upsertSubagentMaxDepth(WORKSPACE_ID, 2);
    expect(calls[0]?.text.replace(/\s+/g, " ").trim()).toBe(
      "insert into public.workspace_settings (workspace_id, subagent_max_depth) values ($2, $1) on conflict (workspace_id) do update set subagent_max_depth = excluded.subagent_max_depth",
    );
    expect(calls[0]?.values).toEqual([2, WORKSPACE_ID]);

    const hit = createRunner(() => ({
      rowCount: 1,
      rows: [{ subagent_max_depth: 2 }],
    }));
    await expect(
      createSettingsRepository(
        createPersistenceFromRunner(hit.runner),
      ).findSubagentMaxDepth(WORKSPACE_ID),
    ).resolves.toBe(2);
  });

  it("无库值时治理项落 DEFAULTS，有库值时用库值且越界值被钳回护栏", async () => {
    const defaults = createSettingsService({
      repository: createRepositoryFake(),
      defaultModel: "fallback-model",
    });
    await expect(
      defaults.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toMatchObject({
      subagentMaxDepth: 1,
      subagentMaxConcurrency: 4,
      llmRequestMaxRetries: 10,
      llmInfiniteRetry: false,
      executeTimeoutMs: 120000,
      subagentMaxContinuations: 50,
      computerUseActionTimeoutMs: 10000,
      computerUseObserveMaxBytes: 32768,
      computerUseScreenshotMaxBytes: 262144,
      computerUseMaxActionsPerRun: 200,
      computerUseSessionMaxMs: 1800000,
    });

    const stored = createSettingsService({
      repository: createRepositoryFake({
        findSubagentMaxDepth: async () => 2,
        findSubagentMaxConcurrency: async () => 8,
        findLlmRequestMaxRetries: async () => 0,
        findLlmInfiniteRetry: async () => true,
        findExecuteTimeoutMs: async () => 600000,
      }),
      defaultModel: "fallback-model",
    });
    await expect(
      stored.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toMatchObject({
      subagentMaxDepth: 2,
      subagentMaxConcurrency: 8,
      llmRequestMaxRetries: 0,
      llmInfiniteRetry: true,
      executeTimeoutMs: 600000,
    });

    // 手改过的行（越界）不该让读取失败：读侧钳回护栏（对齐 clampMaxRunRetries 先例）
    const clamped = createSettingsService({
      repository: createRepositoryFake({
        findSubagentMaxDepth: async () => 99,
        findSubagentMaxConcurrency: async () => 0,
        findExecuteTimeoutMs: async () => 1,
      }),
      defaultModel: "fallback-model",
    });
    await expect(
      clamped.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toMatchObject({
      subagentMaxDepth: 4,
      subagentMaxConcurrency: 1,
      executeTimeoutMs: 5000,
    });
  });

  it("部分更新治理项：只写送来的列，其余治理项一个字不动", async () => {
    const writes: Array<[string, unknown]> = [];
    const stored = {
      subagentMaxDepth: 2 as number | null,
      subagentMaxConcurrency: 8 as number | null,
      llmRequestMaxRetries: 3 as number | null,
      llmInfiniteRetry: true as boolean | null,
      executeTimeoutMs: 600000 as number | null,
    };
    const service = createSettingsService({
      repository: {
        ...createRepositoryFake(),
        findSubagentMaxDepth: async () => stored.subagentMaxDepth,
        findSubagentMaxConcurrency: async () => stored.subagentMaxConcurrency,
        findLlmRequestMaxRetries: async () => stored.llmRequestMaxRetries,
        findLlmInfiniteRetry: async () => stored.llmInfiniteRetry,
        findExecuteTimeoutMs: async () => stored.executeTimeoutMs,
        upsertSubagentMaxDepth: async (_workspaceId, value) => {
          writes.push(["subagentMaxDepth", value]);
          stored.subagentMaxDepth = value;
        },
        upsertSubagentMaxConcurrency: async (_workspaceId, value) => {
          writes.push(["subagentMaxConcurrency", value]);
          stored.subagentMaxConcurrency = value;
        },
        upsertLlmRequestMaxRetries: async (_workspaceId, value) => {
          writes.push(["llmRequestMaxRetries", value]);
          stored.llmRequestMaxRetries = value;
        },
        upsertLlmInfiniteRetry: async (_workspaceId, value) => {
          writes.push(["llmInfiniteRetry", value]);
          stored.llmInfiniteRetry = value;
        },
        upsertExecuteTimeoutMs: async (_workspaceId, value) => {
          writes.push(["executeTimeoutMs", value]);
          stored.executeTimeoutMs = value;
        },
      },
      defaultModel: "fallback-model",
    });

    const updated = await service.updateWorkspaceSettings(USER, WORKSPACE_ID, {
      subagentMaxConcurrency: 2,
    });
    expect(writes).toEqual([["subagentMaxConcurrency", 2]]);
    expect(updated).toMatchObject({
      subagentMaxDepth: 2,
      subagentMaxConcurrency: 2,
      llmRequestMaxRetries: 3,
      llmInfiniteRetry: true,
      executeTimeoutMs: 600000,
    });
  });
});

describe("agent 治理设置的 env 兜底（DEC-18：库值 ?? env ?? DEFAULTS）", () => {
  it("无库值时用 env 兜底，有库值时 env 不生效，越界 env 值被钳回", async () => {
    const envOnly = createSettingsService({
      repository: createRepositoryFake(),
      governanceEnv: {
        subagentMaxDepth: 2,
        subagentMaxConcurrency: 8,
        llmRequestMaxRetries: 0,
        llmInfiniteRetry: true,
        executeTimeoutMs: 600000,
      },
      defaultModel: "fallback-model",
    });
    await expect(
      envOnly.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toMatchObject({
      subagentMaxDepth: 2,
      subagentMaxConcurrency: 8,
      llmRequestMaxRetries: 0,
      llmInfiniteRetry: true,
      executeTimeoutMs: 600000,
    });

    const storedWins = createSettingsService({
      repository: createRepositoryFake({
        findSubagentMaxDepth: async () => 3,
      }),
      governanceEnv: { subagentMaxDepth: 2 },
      defaultModel: "fallback-model",
    });
    await expect(
      storedWins.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toMatchObject({ subagentMaxDepth: 3 });

    const clamped = createSettingsService({
      repository: createRepositoryFake(),
      governanceEnv: { subagentMaxDepth: 999, subagentMaxConcurrency: 0 },
      defaultModel: "fallback-model",
    });
    await expect(
      clamped.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toMatchObject({
      subagentMaxDepth: 4,
      subagentMaxConcurrency: 1,
    });
  });

  it("部分更新仍只写送来的列：env 兜底不参与写入", async () => {
    const upserts: string[] = [];
    const service = createSettingsService({
      repository: {
        ...createRepositoryFake(),
        upsertSubagentMaxConcurrency: async (_workspaceId, value) => {
          upserts.push(`subagentMaxConcurrency=${value}`);
        },
      },
      governanceEnv: { subagentMaxDepth: 2, subagentMaxConcurrency: 8 },
      defaultModel: "fallback-model",
    });
    await service.updateWorkspaceSettings(USER, WORKSPACE_ID, {
      subagentMaxConcurrency: 2,
    });
    expect(upserts).toEqual(["subagentMaxConcurrency=2"]);
  });
});
