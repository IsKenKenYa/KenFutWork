import type { WorkspaceSettings } from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../auth/types.js";
import { SqlError } from "../persistence/errors.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
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
      repository: {
        findDefaultModel: async () => null,
        findAgentMaxRetries: async () => null,
        findTerminalShell: async () => null,
        findCodeIndexEnabled: async () => null,
        findUserRules: async () => null,
        upsertDefaultModel: async () => {},
        upsertAgentMaxRetries: async () => {},
        upsertTerminalShell: async () => {},
        upsertCodeIndexEnabled: async () => {},
        upsertUserRules: async () => {},
        upsertRuleEntries: async () => {},
      },
      defaultModel: "fallback-model",
    });
    await expect(
      fallback.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toEqual({
      agentMaxRetries: 10,
      defaultModel: "fallback-model",
      terminalShell: "auto",
      codeIndexEnabled: false,
      ruleEntries: [],
      userRules: "",
    });

    const stored = createSettingsService({
      repository: {
        findDefaultModel: async () => "stored-model",
        findAgentMaxRetries: async () => null,
        findTerminalShell: async () => null,
        findCodeIndexEnabled: async () => null,
        findUserRules: async () => null,
        upsertDefaultModel: async () => {},
        upsertAgentMaxRetries: async () => {},
        upsertTerminalShell: async () => {},
        upsertCodeIndexEnabled: async () => {},
        upsertUserRules: async () => {},
        upsertRuleEntries: async () => {},
      },
      defaultModel: "fallback-model",
    });
    await expect(
      stored.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toEqual({
      agentMaxRetries: 10,
      defaultModel: "stored-model",
      terminalShell: "auto",
      codeIndexEnabled: false,
      ruleEntries: [],
      userRules: "",
    });
  });

  /**
   * 回归（GUI 实测）：无工作区设置时，静态兜底是 env 里的内置目录名（如 `gpt-4.1`），
   * 而实际可用模型由供应商实例决定。画布助手这类**不显式传 model** 的客户端会拿到该
   * 不存在的模型，上游直接拒绝 → 客户端只看到「处理过程中遇到问题」并重试 10 次。
   * 故无库值时必须优先用目录解析出的真实模型，只有目录为空才退回静态名。
   */
  it("无库值时用目录兜底（而非不存在的静态名），有库值时不再问目录", async () => {
    const noStore = {
      findDefaultModel: async () => null,
      findAgentMaxRetries: async () => null,
      findTerminalShell: async () => null,
      findCodeIndexEnabled: async () => null,
      findUserRules: async () => null,
      upsertDefaultModel: async () => {},
      upsertAgentMaxRetries: async () => {},
      upsertTerminalShell: async () => {},
      upsertCodeIndexEnabled: async () => {},
      upsertUserRules: async () => {},
      upsertRuleEntries: async () => {},
    };

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
      ruleEntries: [],
      userRules: "",
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
      ruleEntries: [],
      userRules: "",
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
      ruleEntries: [],
      userRules: "",
    });
    expect(catalogCalls).toBe(0);
  });

  it("读写失败分别映射 settings_read_failed / settings_update_failed", async () => {
    const readFailure = createSettingsService({
      repository: {
        findDefaultModel: async () => {
          throw new SqlError("connection reset");
        },
        findAgentMaxRetries: async () => null,
        findTerminalShell: async () => null,
        findCodeIndexEnabled: async () => null,
        findUserRules: async () => null,
        upsertDefaultModel: async () => {},
        upsertAgentMaxRetries: async () => {},
        upsertTerminalShell: async () => {},
        upsertCodeIndexEnabled: async () => {},
        upsertUserRules: async () => {},
        upsertRuleEntries: async () => {},
      },
    });
    await expect(
      readFailure.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).rejects.toMatchObject({
      code: "settings_read_failed",
      statusCode: 500,
    });

    const writeFailure = createSettingsService({
      repository: {
        findDefaultModel: async () => null,
        findAgentMaxRetries: async () => null,
        findTerminalShell: async () => null,
        findCodeIndexEnabled: async () => null,
        findUserRules: async () => null,
        upsertDefaultModel: async () => {
          throw new SqlError("permission denied", { code: "42501" });
        },
        upsertAgentMaxRetries: async () => {},
        upsertTerminalShell: async () => {},
        upsertCodeIndexEnabled: async () => {},
        upsertUserRules: async () => {},
        upsertRuleEntries: async () => {},
      },
    });
    const error = await writeFailure
      .updateWorkspaceSettings(USER, WORKSPACE_ID, {
        agentMaxRetries: 10,
        defaultModel: "x",
        terminalShell: "auto",
        codeIndexEnabled: false,
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
      userRules: null as string | null,
      ruleEntries: null as string[] | null,
    };
    const service = createSettingsService({
      repository: {
        findDefaultModel: async () => stored.defaultModel,
        findAgentMaxRetries: async () => stored.agentMaxRetries,
        findTerminalShell: async () => stored.terminalShell,
        findCodeIndexEnabled: async () => null,
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
      ruleEntries: [],
      userRules: "",
    });

    // 只改终端 shell：模型与重试上限不动
    await expect(
      service.updateWorkspaceSettings(USER, WORKSPACE_ID, {
        terminalShell: "powershell",
      }),
    ).resolves.toEqual({
      agentMaxRetries: 3,
      codeIndexEnabled: false,
      ruleEntries: [],
      userRules: "",
      defaultModel: "gemini-2.5-flash",
      terminalShell: "powershell",
    });
  });
});
