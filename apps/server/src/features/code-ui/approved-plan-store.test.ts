import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalIdentity } from "../permissions/approval-types.js";
import { createCodeApprovedPlanStore } from "./approved-plan-store.js";

const identity: ApprovalIdentity = {
  instanceId: "plan-owner",
  taskId: "fc000aaa-bb11-4c22-9d33-000000000044",
  runId: "original-run",
  toolCallId: "original-exit",
  agentId: "main",
  role: "main",
  scopeGeneration: 1,
  branchGeneration: 1,
  planningEpoch: 3,
};
const PLAN = "# 真实批准计划\n\n保留中文和末尾换行。\n";

describe("批准计划管理文件公开存储", () => {
  it("数据根别名保存的引用仍相对该根，顺序和并发重放不可覆盖正文", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kfw-plan-store-"));
    try {
      const root = join(directory, "data");
      const alias = join(directory, "alias");
      await mkdir(root);
      await symlink(
        root,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const store = createCodeApprovedPlanStore();
      const ref = await store.save(alias, identity, PLAN);
      expect(ref.relativePath.split(/[\\/]/u)).not.toContain("..");
      expect(await readFile(resolve(alias, ref.relativePath), "utf8")).toBe(
        PLAN,
      );
      expect(await store.save(root, identity, PLAN)).toEqual(ref);
      expect(
        await Promise.all([
          store.save(alias, identity, PLAN),
          store.save(root, identity, PLAN),
        ]),
      ).toEqual([ref, ref]);
      await expect(store.save(root, identity, "# 改变正文\n")).rejects.toThrow(
        "文件已改变",
      );
      expect(await readFile(resolve(alias, ref.relativePath), "utf8")).toBe(
        PLAN,
      );
      expect(
        await readdir(
          join(root, "sandbox", "agent-files", "plans", identity.taskId),
        ),
      ).toEqual([`${ref.planId}.md`]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
