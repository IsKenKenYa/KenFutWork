import { randomBytes, randomUUID } from "node:crypto";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";
import { createCodeUiRepository } from "./repository.js";

type Fixture = Awaited<ReturnType<typeof createCodeUiHttpFixture>>;
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;

async function insertBarrier(fixture: Fixture, taskId: string) {
  const controller = new Client({
    connectionString: fixture.database.connectionString,
  });
  // 仅用于本案独占PG的握手身份，48位正数属于Postgres bigint键域，不是业务限额。
  const lockKey = BigInt(`0x${randomBytes(6).toString("hex")}`).toString();
  let unlock!: () => void;
  const unlockSignal = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let commit: Promise<unknown> | undefined;
  let installed = false;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    unlock();
    await commit;
  };
  try {
    await controller.connect();
    const controllerPid = (
      await controller.query<{ pid: number }>("select pg_backend_pid() as pid")
    ).rows[0]?.pid;
    if (!controllerPid) throw new Error("测试握手连接未取得真实backend pid");
    await controller.query("begin");
    await controller.query("select pg_advisory_xact_lock($1::bigint)", [
      lockKey,
    ]);
    commit = unlockSignal.then(() => controller.query("commit"));
    // taskId来自真实宿主生成的UUID；函数只拦该Task的真实createAcceptedRun INSERT。
    await fixture.database.persistence.execute(
      `create function public.wait_test_input_dispatch() returns trigger language plpgsql as $$ begin if new.session_id = '${taskId}'::uuid then perform pg_advisory_xact_lock(${lockKey}::bigint); end if; return new; end $$`,
    );
    await fixture.database.persistence.execute(
      "create trigger wait_test_input_dispatch before insert on public.agent_runs for each row execute function public.wait_test_input_dispatch()",
    );
    installed = true;
    return {
      release,
      waitBlocked: async () => {
        // 仅测试同步期限：观察数据库等待事实，绝不以固定延时猜INSERT时序。
        await vi.waitFor(
          async () => {
            const pending = await fixture.database.persistence.queryOne<{
              pid: number;
            }>(
              `select pid from pg_stat_activity
              where datname=current_database() and pid<>pg_backend_pid()
                and state='active' and wait_event_type='Lock' and wait_event='advisory'
                and $1=any(pg_blocking_pids(pid))
                and strpos(lower(query), 'insert into public.agent_runs') > 0`,
              [controllerPid],
            );
            expect(pending?.pid).toEqual(expect.any(Number));
          },
          { timeout: 30_000 },
        );
      },
      close: async () => {
        try {
          await release();
        } finally {
          try {
            if (installed) {
              await fixture.database.persistence.execute(
                "drop trigger wait_test_input_dispatch on public.agent_runs",
              );
              await fixture.database.persistence.execute(
                "drop function public.wait_test_input_dispatch()",
              );
              installed = false;
            }
          } finally {
            await controller.end();
          }
        }
      },
    };
  } catch (error) {
    await release().catch(() => {});
    await controller.end();
    throw error;
  }
}

async function snapshot(host: Host) {
  return protocol.conversationSnapshotSchema.parse(await host.snapshot());
}

async function dispatchInvalidatedInput(
  fixture: Fixture,
  host: Host,
  model: Awaited<ReturnType<typeof heldModel>>,
) {
  const barrier = await insertBarrier(fixture, host.sessionId);
  try {
    const commandId = randomUUID();
    const accepted = await host.command(
      "sendText",
      {
        text: "OLD_ACCEPTED_INPUT_MUST_NOT_DISPATCH",
      },
      commandId,
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.result.status).toBe("accepted");
    await barrier.waitBlocked();
    const before = await snapshot(host);
    const repository = createCodeUiRepository(fixture.database.persistence);
    const originalScope = await repository.find(
      fixture.actor.instanceId,
      host.sessionId,
    );
    if (!originalScope) throw new Error("已accepted输入的原Task Scope未持久化");
    expect(before.control.phase).toBe("running");
    expect(
      before.control.activeWorks.filter((work) => work.kind === "primaryTurn"),
    ).toHaveLength(1);
    expect(model.requests).toEqual([]);
    const changed = await host.command(
      "switchCollaborationMode",
      { mode: "plan" },
      randomUUID(),
      {
        baseRevision: before.revision,
        baseLogEpoch: before.logEpoch,
      },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.result.status).toBe("accepted");
    expect((await snapshot(host)).config.mode).toBe("plan");
    const advancedScope = await repository.find(
      fixture.actor.instanceId,
      host.sessionId,
    );
    if (!advancedScope) throw new Error("mode切换后Task Scope丢失");
    expect(Number(advancedScope.scope_generation)).toBeGreaterThan(
      Number(originalScope.scope_generation),
    );
    await barrier.release();
    await vi.waitFor(
      async () => {
        const canceled = await snapshot(host);
        expect(canceled.control.phase).toBe("completedInterrupted");
        expect(canceled.control.canStop).toBe(false);
        expect(canceled.control.activeWorks).toEqual([]);
      },
      { timeout: 30_000 },
    );
    expect(model.requests).toEqual([]);
    const task = await repository.find(
      fixture.actor.instanceId,
      host.sessionId,
    );
    if (!task?.state) throw new Error("真实Task canonical输入状态未持久化");
    expect(task.active_run_id).toBe(null);
    expect(
      task.state.inputs?.filter((input) => input.status === "active") ?? [],
    ).toEqual([]);
    expect(
      task.state.inputs?.find(
        (input) => input.intent.sourceCommandId === commandId,
      ),
    ).toMatchObject({
      status: "settled",
      intent: { dispatch: { state: "drained" } },
    });
  } finally {
    await barrier.close();
  }
}

/** 真实公开HTTP/SSE+临时PG；外部事务握手不mock Harness/metadata/Scope consumer。 */
describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "Code已accepted输入派发失效 integration",
  () => {
    it("createAcceptedRun INSERT等待时真实mode变更使旧派发失效，V4收口且同Task新输入可执行", async () => {
      const fixture = await createCodeUiHttpFixture();
      const model = await heldModel();
      let host: Host | undefined;
      try {
        host = await createCodeSessionFixture(model.baseUrl, {
          client: fixture.client,
        });
        await dispatchInvalidatedInput(fixture, host, model);
        const next = await host.command("sendText", {
          text: "NEW_INPUT_AFTER_INVALIDATED_DISPATCH",
        });
        expect(next.body.result.status).toBe("accepted");
        const current = host;
        await vi.waitFor(
          async () => {
            expect(model.requests).toHaveLength(1);
            const running = await snapshot(current);
            expect(running.control.phase).toBe("running");
            expect(
              running.rows.window.filter((row) => row.kind === "assistantText"),
            ).toContainEqual(expect.objectContaining({ text: "正在运行 1" }));
          },
          { timeout: 30_000 },
        );
        expect(JSON.stringify(model.requests[0]?.body.messages)).toContain(
          "NEW_INPUT_AFTER_INVALIDATED_DISPATCH",
        );
        const running = await snapshot(host);
        const active = running.control.activeWorks.find(
          (work) => work.kind === "primaryTurn",
        )?.foregroundExecutionId;
        if (!active) throw new Error("同Task新输入未获得真实前台身份");
        expect(
          (
            await host.command("stop", {
              expectedForegroundExecutionId: active,
            })
          ).body.result.status,
        ).toBe("accepted");
      } finally {
        try {
          if (host) {
            try {
              const current = await snapshot(host);
              if (current.control.canStop) await host.command("stop", {});
            } finally {
              await host.dispose();
            }
          }
        } finally {
          try {
            await model.close();
          } finally {
            await fixture.close();
          }
        }
      }
    }, 120_000);
  },
);
