import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createProjectRepository } from "../projects/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createChatRepository } from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "实例会话真实 Postgres",
  () => {
    it("会话供给并发幂等、固定线程、父链隔离与消息持久化成立", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const instanceId = await createLocalInstanceRepository(
          database.persistence,
        ).ensure();
        const { canvas } = await createProjectRepository(
          database.persistence,
        ).createProject({
          instanceId,
          createdByClientId: null,
          name: "会话",
          slug: `chat-${randomUUID()}`,
          description: null,
          canvasName: "主画布",
        });
        if (!canvas) throw new Error("主画布未创建。");
        const repository = createChatRepository(database.persistence);
        const sessionId = randomUUID();
        const [first, second] = await Promise.all(
          ["thread-a", "thread-b"].map((threadId) =>
            repository.ensureSessionWithId(instanceId, {
              sessionId,
              canvasId: canvas.id,
              threadId,
              createdByClientId: null,
            }),
          ),
        );
        expect(first?.thread_id).toBe(second?.thread_id);
        expect(first).toMatchObject({
          id: sessionId,
          mode: "design",
          canvas_id: canvas.id,
        });
        expect(
          (await repository.listSessions(instanceId, canvas.id)).filter(
            (session) => session.id === sessionId,
          ),
        ).toHaveLength(1);
        const message = await repository.insertMessage(instanceId, {
          sessionId,
          role: "user",
          content: "持久上下文",
        });
        expect(message).toMatchObject({ role: "user", content: "持久上下文" });
        expect(
          await repository.findSessionThread(randomUUID(), sessionId),
        ).toBeNull();
        expect(await repository.listMessages(randomUUID(), sessionId)).toEqual(
          [],
        );
        expect(
          (await repository.listMessages(instanceId, sessionId)).map(
            (item) => item.content,
          ),
        ).toEqual(["持久上下文"]);
        expect(await repository.deleteSession(instanceId, sessionId)).toBe(1);
        expect(await repository.deleteSession(instanceId, sessionId)).toBe(0);
      } finally {
        await database.close();
      }
    });
  },
);
