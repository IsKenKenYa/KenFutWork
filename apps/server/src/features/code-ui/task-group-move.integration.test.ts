import { randomUUID } from "node:crypto";
import {
  applicationErrorResponseSchema,
  codeTaskGroupSchema,
  codeTaskGroupStructureSchema,
  codeUiRpcResponseSchema,
} from "@kenfutwork/shared";
import { describe, expect, it } from "vitest";
import { useCodeUiHttpFixture } from "./code-ui-http.fixture.js";

const http = useCodeUiHttpFixture();

function rpc(method: string, args: unknown[] = []) {
  return http.request("/api/code-ui/rpc", {
    service: "task-groups",
    method,
    args,
  });
}

async function read() {
  const response = await rpc("read");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupStructureSchema.parse(response.body.result);
}

async function createGroup(title: string) {
  const response = await rpc("save", [
    {
      creationId: randomUUID(),
      expectedRevision: (await read()).revision,
      title,
    },
  ]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return codeTaskGroupSchema.parse(response.body.result);
}

describe.skipIf(process.env.RUN_CODE_UI_INTEGRATION !== "1")(
  "原分组手动移动的真实HTTP与PostgreSQL integration",
  () => {
    it("移动原组节点并保持持久顺序，同意图重放不覆盖后续整理且同键异参返回409", async () => {
      const projects = await http.request("/api/projects");
      expect(projects.status, JSON.stringify(projects.body)).toBe(200);
      const first = await createGroup("较早创建的分组");
      const second = await createGroup("较新创建的分组");
      expect(await read()).toEqual({
        revision: 2,
        groups: [first, second],
        members: [],
        order: [
          { type: "group", key: second.id, sortOrder: 0 },
          { type: "group", key: first.id, sortOrder: 1 },
        ],
      });
      const intent = {
        node: { type: "group", groupId: second.id },
        sourceGroupId: null,
        groupId: null,
        expectedRevision: 2,
        anchor: { node: { type: "group", groupId: first.id }, side: "after" },
      };
      const moved = await rpc("move", [intent]);
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(codeUiRpcResponseSchema.parse(moved.body)).toEqual({
        result: null,
      });
      const after = await read();
      expect(after).toEqual({
        revision: 3,
        groups: [first, second],
        members: [],
        order: [
          { type: "group", key: first.id, sortOrder: 0 },
          { type: "group", key: second.id, sortOrder: 1 },
        ],
      });
      const repeated = await rpc("move", [intent]);
      expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
      expect(await read()).toEqual(after);
      const third = await createGroup("后续整理保留的分组");
      const current = await read();
      expect(current.order.map((node) => node.key)).toEqual([
        third.id,
        first.id,
        second.id,
      ]);
      expect(current.revision).toBe(4);
      const replay = await rpc("move", [intent]);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      const conflict = await rpc("move", [{ ...intent, anchor: undefined }]);
      expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
      expect(
        applicationErrorResponseSchema.parse(conflict.body).error.code,
      ).toBe("task_group_revision_conflict");
      expect(await read()).toEqual(current);
      expect(await http.request("/api/projects")).toEqual(projects);
    }, 90_000); // 独占HTTP、SSE与临时PG的移动、重放和资源关闭期限。
  },
);
