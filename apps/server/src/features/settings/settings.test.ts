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
        upsertDefaultModel: async () => {},
      },
      defaultModel: "fallback-model",
    });
    await expect(
      fallback.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toEqual({ defaultModel: "fallback-model" });

    const stored = createSettingsService({
      repository: {
        findDefaultModel: async () => "stored-model",
        upsertDefaultModel: async () => {},
      },
      defaultModel: "fallback-model",
    });
    await expect(
      stored.getWorkspaceSettings(USER, WORKSPACE_ID),
    ).resolves.toEqual({ defaultModel: "stored-model" });
  });

  it("读写失败分别映射 settings_read_failed / settings_update_failed", async () => {
    const readFailure = createSettingsService({
      repository: {
        findDefaultModel: async () => {
          throw new SqlError("connection reset");
        },
        upsertDefaultModel: async () => {},
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
        upsertDefaultModel: async () => {
          throw new SqlError("permission denied", { code: "42501" });
        },
      },
    });
    const error = await writeFailure
      .updateWorkspaceSettings(USER, WORKSPACE_ID, { defaultModel: "x" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettingsServiceError);
    expect(error).toMatchObject({
      code: "settings_update_failed",
      statusCode: 500,
    });
  });

  it("更新成功返回写入的设置", async () => {
    let written: string | undefined;
    const service = createSettingsService({
      repository: {
        findDefaultModel: async () => null,
        upsertDefaultModel: async (_workspaceId, defaultModel) => {
          written = defaultModel;
        },
      },
    });

    await expect(
      service.updateWorkspaceSettings(USER, WORKSPACE_ID, {
        defaultModel: "gemini-2.5-flash",
      }),
    ).resolves.toEqual({ defaultModel: "gemini-2.5-flash" });
    expect(written).toBe("gemini-2.5-flash");
  });
});
