import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { resolveDesktopPaths } from "../../desktop/paths.js";
import { parameterFingerprint } from "../execution/parameter-fingerprint.js";
import type { ApprovalIdentity } from "../permissions/approval-types.js";
import type { CodePlanRef } from "./planning-types.js";

export interface CodeApprovedPlanStore {
  save(
    dataDir: string,
    identity: ApprovalIdentity,
    plan: string,
  ): Promise<CodePlanRef>;
}

function requireWithin(root: string, path: string) {
  const suffix = relative(root, path);
  if (!suffix || isAbsolute(suffix) || suffix.split(sep).includes(".."))
    throw new Error("批准计划文件不属于实例管理目录。");
}

async function managedDirectory(parent: string, name: string) {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  const canonical = await realpath(path);
  requireWithin(parent, canonical);
  return canonical;
}

/** 不可覆盖的稳定目标；先flush并读回，再允许Task提交批准事实。 */
export function createCodeApprovedPlanStore(): CodeApprovedPlanStore {
  return {
    async save(dataDir, identity, plan) {
      z.uuid().parse(identity.taskId);
      const planId = parameterFingerprint(identity);
      const bytes = Buffer.from(plan, "utf8");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const root = await realpath(dataDir);
      const filesRoot = resolveDesktopPaths(root).agentFilesDir;
      const sandbox = await managedDirectory(root, "sandbox");
      const managed = await managedDirectory(sandbox, "agent-files");
      if (managed !== filesRoot)
        throw new Error("计划管理根发生了非规范路径重定向。");
      const directory = await managedDirectory(managed, "plans");
      const parent = await managedDirectory(directory, identity.taskId);
      const target = join(parent, `${planId}.md`);
      const temporary = join(parent, `.${planId}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporary, target);
        } catch (error) {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "EEXIST"
          )
            throw error;
        }
        const stat = await lstat(target);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          !(await readFile(target)).equals(bytes)
        )
          throw new Error("批准计划文件已改变或保存不完整，未退出规划。");
        return { planId, relativePath: relative(root, target), sha256 };
      } finally {
        await unlink(temporary);
      }
    },
  };
}
