import {
  type InstanceSettings,
  instanceSettingsSchema,
} from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createLocalInstanceService } from "../local-instance/service.js";

import type { LocalActor } from "../local-instance/types.js";
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

const INSTANCE_ID = "instance-1";
const ACTOR: LocalActor = {
  instanceId: INSTANCE_ID,
  accessClientId: "desktop",
};
const localInstance = createLocalInstanceService({
  repository: { ensure: async () => INSTANCE_ID },
  dataDir: "/tmp/settings-test",
});

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
    async acquireSession() {
      throw new Error("此查询夹具不提供真实执行宿主会话。");
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
  const repository: SettingsRepository = {
    async atomicUpdate(operation) {
      await operation(this);
    },
    findModelDefaults: async () => null,
    upsertModelDefaults: async () => {},
    findRuntimeGovernance: async () => ({}),
    upsertRuntimeGovernance: async () => {},
    findDefaultModel: async () => null,
    findCodeUiReconnectDelayMs: async () => null,
    upsertCodeUiReconnectDelayMs: async () => {},
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
  return repository;
}

it("设置事实保存并回读后通知实例配置消费者，释放租约后不再推送且不暴露完整设置", async () => {
  let commands: InstanceSettings["commands"] = [];
  const service = createSettingsService({
    localInstance,
    defaultModel: "fixture",
    repository: createRepositoryFake({
      findCommands: async () => structuredClone(commands),
      upsertCommands: async (_instanceId, value) => {
        commands = instanceSettingsSchema.shape.commands.parse(value);
      },
    }),
  });
  const facts: unknown[] = [];
  const dispose = service.onUpdated(async (event) => {
    facts.push({
      event,
      commands: (await service.getInstanceSettings(ACTOR, event.instanceId))
        .commands,
    });
  });
  const value = [
    { name: "inspect", description: "检查项目", prompt: "检查{{args}}" },
  ];
  await service.updateInstanceSettings(ACTOR, INSTANCE_ID, {
    commands: value,
    defaultModel: undefined,
  });
  expect(facts).toEqual([
    {
      event: { instanceId: INSTANCE_ID, changedKeys: ["commands"] },
      commands: value,
    },
  ]);
  dispose();
  await service.updateInstanceSettings(ACTOR, INSTANCE_ID, { commands: [] });
  expect(facts).toHaveLength(1);
});

describe("settings repository", () => {
  it("读默认模型限定实例，无行返回 null", async () => {
    const empty = createRunner();
    await expect(
      createSettingsRepository(
        createPersistenceFromRunner(empty.runner),
      ).findDefaultModel(INSTANCE_ID),
    ).resolves.toBeNull();
    expect(empty.sqls()[0]).toBe(
      "select default_model from public.instance_settings where instance_id = $1",
    );
    expect(empty.calls[0]?.values).toEqual([INSTANCE_ID]);

    const hit = createRunner(() => ({
      rowCount: 1,
      rows: [{ default_model: "gpt-5.4" }],
    }));
    await expect(
      createSettingsRepository(
        createPersistenceFromRunner(hit.runner),
      ).findDefaultModel(INSTANCE_ID),
    ).resolves.toBe("gpt-5.4");
  });

  it("upsert 以实例为主键冲突即更新，实例值经 :instance 绑定", async () => {
    const { calls, runner } = createRunner();
    await createSettingsRepository(
      createPersistenceFromRunner(runner),
    ).upsertDefaultModel(INSTANCE_ID, "gemini-2.5-flash");

    expect(calls[0]?.text.replace(/\s+/g, " ").trim()).toBe(
      "insert into public.instance_settings (instance_id, default_model) values ($2, $1) on conflict (instance_id) do update set default_model = excluded.default_model",
    );
    expect(calls[0]?.values).toEqual(["gemini-2.5-flash", INSTANCE_ID]);
  });
});

describe("settings service", () => {
  it("无行时落回退默认值，有行时用库值", async () => {
    const fallback = createSettingsService({
      localInstance,
      repository: createRepositoryFake(),
      defaultModel: "fallback-model",
    });
    await expect(
      fallback.getInstanceSettings(ACTOR, INSTANCE_ID),
    ).resolves.toEqual(
      instanceSettingsSchema.parse({
        modelDefaults: {
          chat: null,
          image: { mode: "auto" },
          video: { mode: "auto" },
        },
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
      }),
    );

    const stored = createSettingsService({
      localInstance,
      repository: createRepositoryFake({
        findDefaultModel: async () => "stored-model",
      }),
      defaultModel: "fallback-model",
    });
    await expect(
      stored.getInstanceSettings(ACTOR, INSTANCE_ID),
    ).resolves.toEqual(
      instanceSettingsSchema.parse({
        modelDefaults: {
          chat: null,
          image: { mode: "auto" },
          video: { mode: "auto" },
        },
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
      }),
    );
  });

  /**
   * 回归（GUI 实测）：无实例设置时，静态兜底是 env 里的内置目录名（如 `gpt-4.1`），
   * 而实际可用模型由供应商实例决定。画布助手这类**不显式传 model** 的客户端会拿到该
   * 不存在的模型，上游直接拒绝 → 客户端只看到「处理过程中遇到问题」并重试 10 次。
   * 故无库值时必须优先用目录解析出的真实模型，只有目录为空才退回静态名。
   */
  it("无库值时用目录兜底（而非不存在的静态名），有库值时不再问目录", async () => {
    const noStore = createRepositoryFake();

    const withCatalog = createSettingsService({
      localInstance,
      repository: noStore,
      defaultModel: "gpt-4.1",
      resolveFallbackModel: async () => "inst-1:glm-5.3-flash",
    });
    await expect(
      withCatalog.getInstanceSettings(ACTOR, INSTANCE_ID),
    ).resolves.toEqual(
      instanceSettingsSchema.parse({
        modelDefaults: {
          chat: null,
          image: { mode: "auto" },
          video: { mode: "auto" },
        },
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
      }),
    );

    const emptyCatalog = createSettingsService({
      localInstance,
      repository: noStore,
      defaultModel: "gpt-4.1",
      resolveFallbackModel: async () => undefined,
    });
    await expect(
      emptyCatalog.getInstanceSettings(ACTOR, INSTANCE_ID),
    ).resolves.toEqual(
      instanceSettingsSchema.parse({
        modelDefaults: {
          chat: null,
          image: { mode: "auto" },
          video: { mode: "auto" },
        },
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
      }),
    );

    let catalogCalls = 0;
    const stored = createSettingsService({
      localInstance,
      repository: { ...noStore, findDefaultModel: async () => "stored-model" },
      defaultModel: "gpt-4.1",
      resolveFallbackModel: async () => {
        catalogCalls += 1;
        return "inst-1:glm-5.3-flash";
      },
    });
    await expect(
      stored.getInstanceSettings(ACTOR, INSTANCE_ID),
    ).resolves.toEqual(
      instanceSettingsSchema.parse({
        modelDefaults: {
          chat: null,
          image: { mode: "auto" },
          video: { mode: "auto" },
        },
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
      }),
    );
    expect(catalogCalls).toBe(0);
  });

  it("读写失败分别映射 settings_read_failed / settings_update_failed", async () => {
    const readFailure = createSettingsService({
      localInstance,
      repository: createRepositoryFake({
        findDefaultModel: async () => {
          throw new SqlError("connection reset");
        },
      }),
    });
    await expect(
      readFailure.getInstanceSettings(ACTOR, INSTANCE_ID),
    ).rejects.toMatchObject({
      code: "settings_read_failed",
      statusCode: 500,
    });

    const writeFailure = createSettingsService({
      localInstance,
      repository: createRepositoryFake({
        upsertDefaultModel: async () => {
          throw new SqlError("permission denied", { code: "42501" });
        },
      }),
    });
    const error = await writeFailure
      .updateInstanceSettings(ACTOR, INSTANCE_ID, {
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
      terminalShell: "git-bash" as InstanceSettings["terminalShell"] | null,
      codeIndexEnabled: null as boolean | null,
      codeIndexAutoNewFolder: null as boolean | null,
      autoCompactEnabled: null as boolean | null,
      commands: null as unknown,
      hooks: null as unknown,
      userRules: null as string | null,
      ruleEntries: null as string[] | null,
    };
    const service = createSettingsService({
      localInstance,
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
        upsertDefaultModel: async (_instanceId, defaultModel) => {
          stored = { ...stored, defaultModel };
        },
        upsertAgentMaxRetries: async (_instanceId, agentMaxRetries) => {
          stored = { ...stored, agentMaxRetries };
        },
        upsertTerminalShell: async (_instanceId, terminalShell) => {
          stored = { ...stored, terminalShell };
        },
        upsertCodeIndexEnabled: async (_instanceId, codeIndexEnabled) => {
          stored = { ...stored, codeIndexEnabled };
        },
        upsertCodeIndexAutoNewFolder: async (
          _instanceId,
          codeIndexAutoNewFolder,
        ) => {
          stored = { ...stored, codeIndexAutoNewFolder };
        },
        upsertAutoCompactEnabled: async (_instanceId, autoCompactEnabled) => {
          stored = { ...stored, autoCompactEnabled };
        },
        upsertCommands: async (_instanceId, commands) => {
          stored = { ...stored, commands: commands as never };
        },
        upsertHooks: async (_instanceId, hooks) => {
          stored = { ...stored, hooks: hooks as never };
        },
        upsertUserRules: async (_instanceId, userRules) => {
          stored = { ...stored, userRules };
        },
        upsertRuleEntries: async (_instanceId, ruleEntries) => {
          stored = { ...stored, ruleEntries };
        },
      },
    });

    // 只改模型：重试上限与终端 shell 必须原样保留（整对象写入会把它俩重置成默认）
    await expect(
      service.updateInstanceSettings(ACTOR, INSTANCE_ID, {
        defaultModel: "gemini-2.5-flash",
      }),
    ).resolves.toEqual(
      instanceSettingsSchema.parse({
        modelDefaults: {
          chat: null,
          image: { mode: "auto" },
          video: { mode: "auto" },
        },
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
      }),
    );

    // 只改终端 shell：模型与重试上限不动
    await expect(
      service.updateInstanceSettings(ACTOR, INSTANCE_ID, {
        terminalShell: "powershell",
      }),
    ).resolves.toEqual(
      instanceSettingsSchema.parse({
        modelDefaults: {
          chat: null,
          image: { mode: "auto" },
          video: { mode: "auto" },
        },
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
      }),
    );
  });
});

describe("agent 治理设置（DEC-17/DEC-18：禁止硬编码，全部走 instance_settings）", () => {
  it("repository：治理列逐列读写，SQL 形状与绑定正确", async () => {
    const empty = createRunner();
    await expect(
      createSettingsRepository(
        createPersistenceFromRunner(empty.runner),
      ).findSubagentMaxDepth(INSTANCE_ID),
    ).resolves.toBeNull();
    expect(empty.sqls()[0]).toBe(
      "select subagent_max_depth from public.instance_settings where instance_id = $1",
    );

    const { calls, runner } = createRunner();
    await createSettingsRepository(
      createPersistenceFromRunner(runner),
    ).upsertSubagentMaxDepth(INSTANCE_ID, 2);
    expect(calls[0]?.text.replace(/\s+/g, " ").trim()).toBe(
      "insert into public.instance_settings (instance_id, subagent_max_depth) values ($2, $1) on conflict (instance_id) do update set subagent_max_depth = excluded.subagent_max_depth",
    );
    expect(calls[0]?.values).toEqual([2, INSTANCE_ID]);

    const hit = createRunner(() => ({
      rowCount: 1,
      rows: [{ subagent_max_depth: 2 }],
    }));
    await expect(
      createSettingsRepository(
        createPersistenceFromRunner(hit.runner),
      ).findSubagentMaxDepth(INSTANCE_ID),
    ).resolves.toBe(2);
  });

  it("无库值时治理项落 DEFAULTS，有库值时用库值且越界值被钳回护栏", async () => {
    const defaults = createSettingsService({
      localInstance,
      repository: createRepositoryFake(),
      defaultModel: "fallback-model",
    });
    await expect(
      defaults.getInstanceSettings(ACTOR, INSTANCE_ID),
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
      localInstance,
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
      stored.getInstanceSettings(ACTOR, INSTANCE_ID),
    ).resolves.toMatchObject({
      subagentMaxDepth: 2,
      subagentMaxConcurrency: 8,
      llmRequestMaxRetries: 0,
      llmInfiniteRetry: true,
      executeTimeoutMs: 600000,
    });

    // 手改过的行（越界）不该让读取失败：读侧钳回护栏（对齐 clampMaxRunRetries 先例）
    const clamped = createSettingsService({
      localInstance,
      repository: createRepositoryFake({
        findSubagentMaxDepth: async () => 99,
        findSubagentMaxConcurrency: async () => 0,
        findExecuteTimeoutMs: async () => 1,
      }),
      defaultModel: "fallback-model",
    });
    await expect(
      clamped.getInstanceSettings(ACTOR, INSTANCE_ID),
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
      localInstance,
      repository: {
        ...createRepositoryFake(),
        findSubagentMaxDepth: async () => stored.subagentMaxDepth,
        findSubagentMaxConcurrency: async () => stored.subagentMaxConcurrency,
        findLlmRequestMaxRetries: async () => stored.llmRequestMaxRetries,
        findLlmInfiniteRetry: async () => stored.llmInfiniteRetry,
        findExecuteTimeoutMs: async () => stored.executeTimeoutMs,
        upsertSubagentMaxDepth: async (_instanceId, value) => {
          writes.push(["subagentMaxDepth", value]);
          stored.subagentMaxDepth = value;
        },
        upsertSubagentMaxConcurrency: async (_instanceId, value) => {
          writes.push(["subagentMaxConcurrency", value]);
          stored.subagentMaxConcurrency = value;
        },
        upsertLlmRequestMaxRetries: async (_instanceId, value) => {
          writes.push(["llmRequestMaxRetries", value]);
          stored.llmRequestMaxRetries = value;
        },
        upsertLlmInfiniteRetry: async (_instanceId, value) => {
          writes.push(["llmInfiniteRetry", value]);
          stored.llmInfiniteRetry = value;
        },
        upsertExecuteTimeoutMs: async (_instanceId, value) => {
          writes.push(["executeTimeoutMs", value]);
          stored.executeTimeoutMs = value;
        },
      },
      defaultModel: "fallback-model",
    });

    const updated = await service.updateInstanceSettings(ACTOR, INSTANCE_ID, {
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
      localInstance,
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
      envOnly.getInstanceSettings(ACTOR, INSTANCE_ID),
    ).resolves.toMatchObject({
      subagentMaxDepth: 2,
      subagentMaxConcurrency: 8,
      llmRequestMaxRetries: 0,
      llmInfiniteRetry: true,
      executeTimeoutMs: 600000,
    });

    const storedWins = createSettingsService({
      localInstance,
      repository: createRepositoryFake({
        findSubagentMaxDepth: async () => 3,
      }),
      governanceEnv: { subagentMaxDepth: 2 },
      defaultModel: "fallback-model",
    });
    await expect(
      storedWins.getInstanceSettings(ACTOR, INSTANCE_ID),
    ).resolves.toMatchObject({ subagentMaxDepth: 3 });

    const clamped = createSettingsService({
      localInstance,
      repository: createRepositoryFake(),
      governanceEnv: { subagentMaxDepth: 999, subagentMaxConcurrency: 0 },
      defaultModel: "fallback-model",
    });
    await expect(
      clamped.getInstanceSettings(ACTOR, INSTANCE_ID),
    ).resolves.toMatchObject({
      subagentMaxDepth: 4,
      subagentMaxConcurrency: 1,
    });
  });

  it("部分更新仍只写送来的列：env 兜底不参与写入", async () => {
    const upserts: string[] = [];
    const service = createSettingsService({
      localInstance,
      repository: {
        ...createRepositoryFake(),
        upsertSubagentMaxConcurrency: async (_instanceId, value) => {
          upserts.push(`subagentMaxConcurrency=${value}`);
        },
      },
      governanceEnv: { subagentMaxDepth: 2, subagentMaxConcurrency: 8 },
      defaultModel: "fallback-model",
    });
    await service.updateInstanceSettings(ACTOR, INSTANCE_ID, {
      subagentMaxConcurrency: 2,
    });
    expect(upserts).toEqual(["subagentMaxConcurrency=2"]);
  });
});

describe("实例归属与本机访问治理", () => {
  it("目标实例必须匹配 Actor，伪造 Actor 也不能访问当前数据库", async () => {
    const findDefaultModel = vi.fn(async () => null);
    const upsertDefaultModel = vi.fn(async () => {});
    const findCodeUiReconnectDelayMs = vi.fn(async () => null);
    const service = createSettingsService({
      localInstance,
      repository: createRepositoryFake({
        findDefaultModel,
        upsertDefaultModel,
        findCodeUiReconnectDelayMs,
      }),
    });
    await expect(
      service.getInstanceSettings(ACTOR, "foreign"),
    ).rejects.toMatchObject({ code: "settings_forbidden", statusCode: 403 });
    await expect(
      service.updateInstanceSettings(ACTOR, "foreign", {
        defaultModel: "foreign-model",
      }),
    ).rejects.toMatchObject({ code: "settings_forbidden", statusCode: 403 });
    await expect(
      service.getCodeUiTransportSettings(ACTOR, "foreign"),
    ).rejects.toMatchObject({ code: "settings_forbidden" });
    await expect(
      service.getInstanceSettings(
        { instanceId: "foreign", accessClientId: "desktop" },
        "foreign",
      ),
    ).rejects.toMatchObject({ code: "instance_forbidden", statusCode: 403 });
    expect(findDefaultModel).not.toHaveBeenCalled();
    expect(upsertDefaultModel).not.toHaveBeenCalled();
    expect(findCodeUiReconnectDelayMs).not.toHaveBeenCalled();
  });

  it("ticket/session 治理从 env 兜底并可保存，库值优先且部分 JSON 更新不覆盖其他键", async () => {
    const stored: Record<string, number> = { codeReadMaxBytes: 8192 };
    const writes: Array<{ instanceId: string; patch: Record<string, number> }> =
      [];
    const service = createSettingsService({
      localInstance,
      repository: createRepositoryFake({
        findRuntimeGovernance: async () => ({ ...stored }),
        upsertRuntimeGovernance: async (instanceId, patch) => {
          writes.push({ instanceId, patch });
          Object.assign(stored, patch);
        },
      }),
      governanceEnv: {
        localAccessTicketTtlMs: 90_000,
        localAccessSessionMaxAgeMs: 180_000,
      },
    });
    const initial = await service.getInstanceSettings(ACTOR, INSTANCE_ID);
    expect(initial).toMatchObject({
      localAccessTicketTtlMs: 90_000,
      localAccessSessionMaxAgeMs: 180_000,
      codeReadMaxBytes: 8192,
    });
    const updated = await service.updateInstanceSettings(ACTOR, INSTANCE_ID, {
      localAccessTicketTtlMs: 45_000,
    });
    expect(writes).toEqual([
      { instanceId: INSTANCE_ID, patch: { localAccessTicketTtlMs: 45_000 } },
    ]);
    expect(updated).toMatchObject({
      localAccessTicketTtlMs: 45_000,
      localAccessSessionMaxAgeMs: 180_000,
      codeReadMaxBytes: 8192,
    });
    expect(
      await service.getInstanceSettings(
        { instanceId: INSTANCE_ID, accessClientId: "browser" },
        INSTANCE_ID,
      ),
    ).toEqual(updated);
  });

  it("消费者刷新失败不撤销已保存事实，通知只含实例与变化键，空更新不通知", async () => {
    let defaultModel = "before";
    const service = createSettingsService({
      localInstance,
      repository: createRepositoryFake({
        findDefaultModel: async () => defaultModel,
        upsertDefaultModel: async (_instanceId, value) => {
          defaultModel = value;
        },
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const callback = vi.fn(async () => {
      throw new Error("消费者离线");
    });
    const dispose = service.onUpdated(callback);
    try {
      expect(
        (
          await service.updateInstanceSettings(ACTOR, INSTANCE_ID, {
            defaultModel: "after",
          })
        ).defaultModel,
      ).toBe("after");
      expect(callback).toHaveBeenCalledWith({
        instanceId: INSTANCE_ID,
        changedKeys: ["defaultModel"],
      });
      expect(
        (await service.getInstanceSettings(ACTOR, INSTANCE_ID)).defaultModel,
      ).toBe("after");
      await service.updateInstanceSettings(ACTOR, INSTANCE_ID, {});
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
      warn.mockRestore();
    }
  });
});
