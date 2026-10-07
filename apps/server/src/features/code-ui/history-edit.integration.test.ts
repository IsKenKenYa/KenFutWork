import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { describe, expect, it, vi } from "vitest";
import { createCodeUiHttpFixture } from "./code-ui-http.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

const enabled = process.env.RUN_CODE_UI_INTEGRATION === "1";
type Host = Awaited<ReturnType<typeof createCodeSessionFixture>>;
async function waitRunning(host: Host, text: string) {
  // 仅测试同步期限：等待真实模型与公开投影，不是运行时限额。
  await vi.waitFor(
    async () => {
      const snapshot = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(snapshot.control.phase).toBe("running");
      expect(
        snapshot.rows.window.filter((row) => row.kind === "assistantText"),
      ).toContainEqual(expect.objectContaining({ text }));
    },
    { timeout: 30_000 },
  );
  return protocol.conversationSnapshotSchema.parse(await host.snapshot());
}

describe.skipIf(!enabled)("原历史编辑真实宿主 integration", () => {
  it("原editUserQuery preserve替换最新输入并以新原生分支重跑，保留文件且旧命令重放不再执行", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel();
    let host: Host | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      await host.command("sendText", { text: "原输入不可再进入模型" });
      let snapshot = await waitRunning(host, "正在运行 1");
      const busyRow = snapshot.rows.window.find(
        (entry) => entry.kind === "userInput",
      );
      if (!busyRow) throw new Error("忙时原用户输入缺失");
      const busyEdit = await host.command(
        "editUserQuery",
        {
          target: { rowId: busyRow.rowId, entityId: busyRow.entityId },
          newText: "不能抢占编辑",
        },
        randomUUID(),
        { baseRevision: snapshot.revision, baseLogEpoch: snapshot.logEpoch },
      );
      expect(busyEdit.body.result).toMatchObject({
        status: "rejected",
        reasonCode: "guard.editTargetUnavailable",
      });
      expect(model.requests).toHaveLength(1);
      const active = snapshot.control.activeWorks.find(
        (work) => work.kind === "primaryTurn",
      )?.foregroundExecutionId;
      if (!active) throw new Error("缺少真实前台身份");
      expect(
        (await host.command("stop", { expectedForegroundExecutionId: active }))
          .body.result.status,
      ).toBe("accepted");
      snapshot = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      const row = snapshot.rows.window.find(
        (entry) => entry.kind === "userInput" && entry.origin === "realUser",
      );
      if (!row || row.kind !== "userInput") throw new Error("缺少原用户输入");
      const marker = join(host.workspacePath, "preserve-external.txt");
      await writeFile(marker, "不应被聊天编辑恢复或删除");
      const payload = {
        target: { rowId: row.rowId, entityId: row.entityId },
        newText: "编辑后真正重跑的输入",
        workspaceMode: "preserve",
      };
      const guard = {
        baseRevision: snapshot.revision,
        baseLogEpoch: snapshot.logEpoch,
      };
      const editId = randomUUID();
      const edited = await host.command(
        "editUserQuery",
        payload,
        editId,
        guard,
      );
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body.result).toMatchObject({
        status: "accepted",
        result: {
          type: "editUserQuery",
          disposition: "rewind",
          sessionId: host.sessionId,
        },
      });
      const running = await waitRunning(host, "正在运行 2");
      expect(running.logEpoch).not.toBe(snapshot.logEpoch);
      expect(
        running.rows.window.filter((entry) => entry.kind === "turnHeader"),
      ).toMatchObject([{ origin: "editRerun", sourceCommandId: editId }]);
      expect(
        running.rows.window.filter((entry) => entry.kind === "userInput"),
      ).toMatchObject([
        {
          sourceCommandId: editId,
          rootSourceCommandId: row.rootSourceCommandId ?? row.sourceCommandId,
        },
      ]);
      expect(
        running.rows.window
          .filter((entry) => entry.kind === "userInput")
          .map((entry) => entry.text),
      ).toEqual(["编辑后真正重跑的输入"]);
      expect(JSON.stringify(model.requests[1]?.body.messages)).toContain(
        "编辑后真正重跑的输入",
      );
      expect(JSON.stringify(model.requests[1]?.body.messages)).not.toContain(
        "原输入不可再进入模型",
      );
      expect(await readFile(marker, "utf8")).toBe("不应被聊天编辑恢复或删除");
      const repeated = await host.command(
        "editUserQuery",
        payload,
        editId,
        guard,
      );
      expect(repeated.body.result).toMatchObject({
        status: "duplicate",
        result: {
          type: "editUserQuery",
          disposition: "rewind",
          sessionId: host.sessionId,
        },
      });
      expect(model.requests).toHaveLength(2);
      const next = running.control.activeWorks.find(
        (work) => work.kind === "primaryTurn",
      )?.foregroundExecutionId;
      if (!next) throw new Error("编辑后的运行未取得真实身份");
      await host.command("stop", { expectedForegroundExecutionId: next });
      const currentHost = host;
      await vi.waitFor(async () => {
        const ended = protocol.conversationSnapshotSchema.parse(
          await currentHost.snapshot(),
        );
        expect(
          ended.rows.window.filter((entry) => entry.kind === "userInput"),
        ).toMatchObject([{ actions: { canEdit: true } }]);
      });
    } finally {
      if (host) {
        const snapshot = protocol.conversationSnapshotSchema.parse(
          await host.snapshot(),
        );
        if (snapshot.control.canStop) await host.command("stop", {});
        await host.dispose();
      }
      await model.close();
      await fixture.close();
    }
  }, 90_000);
  it("线程绑定事务真实失败时旧聊天与文件保持，未发布native分支清理且不执行新模型", async () => {
    const fixture = await createCodeUiHttpFixture();
    const model = await heldModel();
    let host: Host | undefined;
    try {
      host = await createCodeSessionFixture(model.baseUrl, {
        client: fixture.client,
      });
      await host.command("sendText", { text: "数据库失败也保留原输入" });
      const running = await waitRunning(host, "正在运行 1");
      const active = running.control.activeWorks.find(
        (work) => work.kind === "primaryTurn",
      )?.foregroundExecutionId;
      if (!active) throw new Error("真实前台身份缺失");
      await host.command("stop", { expectedForegroundExecutionId: active });
      const original = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      const row = original.rows.window.find(
        (entry) => entry.kind === "userInput",
      );
      if (!row) throw new Error("原输入缺失");
      const marker = join(host.workspacePath, "failure-preserve.txt");
      await writeFile(marker, "事务失败仍保留文件");
      const contexts = await fixture.database.persistence.query(
        "select distinct thread_id from langgraph.checkpoints order by thread_id",
      );
      // 仅独占临时PG的外部写入故障；不修改迁移、不连接任何现存数据库。
      await fixture.database.persistence.execute(
        `create function public.reject_test_history_binding() returns trigger language plpgsql as $$ begin if new.thread_id is distinct from old.thread_id then raise exception '测试线程绑定写失败'; end if; return new; end $$`,
      );
      await fixture.database.persistence.execute(
        "create trigger reject_test_history_binding before update on public.chat_sessions for each row execute function public.reject_test_history_binding()",
      );
      const failed = await host.command(
        "editUserQuery",
        {
          target: { rowId: row.rowId, entityId: row.entityId },
          newText: "不可发表的编辑",
        },
        randomUUID(),
        { baseRevision: original.revision, baseLogEpoch: original.logEpoch },
      );
      expect(failed.status, JSON.stringify(failed.body)).toBe(200);
      expect(failed.body.result).toMatchObject({
        status: "failed",
        message: "测试线程绑定写失败",
      });
      const current = protocol.conversationSnapshotSchema.parse(
        await host.snapshot(),
      );
      expect(current.logEpoch).toBe(original.logEpoch);
      expect(
        current.rows.window
          .filter((entry) => entry.kind === "userInput")
          .map((entry) => entry.text),
      ).toEqual(["数据库失败也保留原输入"]);
      expect(await readFile(marker, "utf8")).toBe("事务失败仍保留文件");
      expect(model.requests).toHaveLength(1);
      expect(
        await fixture.database.persistence.query(
          "select distinct thread_id from langgraph.checkpoints order by thread_id",
        ),
      ).toEqual(contexts);
    } finally {
      if (host) await host.dispose();
      await model.close();
      await fixture.close();
    }
  }, 90_000);
});
