import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
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
      const options = {
        maxBytes: AGENT_GOVERNANCE_DEFAULTS.codeReadMaxBytes,
        signal: new AbortController().signal,
      };
      expect(await store.read(alias, identity, ref, options)).toBe(PLAN);
      await expect(
        store.read(
          root,
          { ...identity, taskId: "fc000aaa-bb11-4c22-9d33-000000000055" },
          ref,
          options,
        ),
      ).rejects.toThrow("批准计划引用不可读");
      await expect(
        store.read(
          root,
          identity,
          { ...ref, relativePath: "../outside.md" },
          options,
        ),
      ).rejects.toThrow("批准计划引用不可读");
      await expect(
        store.read(root, identity, ref, {
          ...options,
          maxBytes: Buffer.byteLength(PLAN) - 1,
        }),
      ).rejects.toThrow("读取预算");
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
      await writeFile(resolve(root, ref.relativePath), "# 篡改\n");
      await expect(store.read(root, identity, ref, options)).rejects.toThrow(
        "哈希已改变",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
