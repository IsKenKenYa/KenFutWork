import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { z } from "zod";
import { resolveDesktopPaths } from "../../desktop/paths.js";
import { parameterFingerprint } from "../execution/parameter-fingerprint.js";
import type { ApprovalIdentity } from "../permissions/approval-types.js";
import type { CodePlanRef } from "./planning-types.js";
import { codePlanApprovalIdentity } from "./planning-types.js";

export interface CodeApprovedPlanStore {
  save(
    dataDir: string,
    identity: ApprovalIdentity,
    plan: string,
  ): Promise<CodePlanRef>;
  read(
    dataDir: string,
    identity: ApprovalIdentity,
    ref: CodePlanRef,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<string>;
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
      const planId = parameterFingerprint(codePlanApprovalIdentity(identity));
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
          stat.size !== bytes.length ||
          !(await readFile(target)).equals(bytes)
        )
          throw new Error("批准计划文件已改变或保存不完整，未退出规划。");
        return { planId, relativePath: relative(root, target), sha256 };
      } finally {
        await unlink(temporary);
      }
    },
    async read(dataDir, identity, ref, options) {
      options.signal.throwIfAborted();
      const planId = parameterFingerprint(codePlanApprovalIdentity(identity));
      if (
        ref.planId !== planId ||
        typeof ref.relativePath !== "string" ||
        isAbsolute(ref.relativePath) ||
        win32.isAbsolute(ref.relativePath) ||
        ref.relativePath.split(/[\\/]/u).includes("..") ||
        !/^[a-f0-9]{64}$/u.test(ref.sha256)
      )
        throw new Error("批准计划引用不可读，未注入模型上下文。");
      const root = await realpath(dataDir);
      const managed = await realpath(resolveDesktopPaths(root).agentFilesDir);
      requireWithin(root, managed);
      const target = resolve(root, ref.relativePath.replaceAll("\\", "/"));
      const canonical = await realpath(target);
      requireWithin(managed, canonical);
      if (
        canonical !== target ||
        basename(target) !== `${planId}.md` ||
        basename(dirname(target)) !== identity.taskId
      )
        throw new Error("批准计划管理路径已改变，未注入模型上下文。");
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > options.maxBytes)
          throw new Error(
            "批准计划超过Code读取预算或不是常规文件，请检查计划文件与设置。",
          );
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of handle.createReadStream({
          autoClose: false,
          signal: options.signal,
        })) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > options.maxBytes)
            throw new Error("批准计划超过Code读取预算，未截断注入。");
          chunks.push(bytes);
        }
        const after = await lstat(target);
        options.signal.throwIfAborted();
        const bytes = Buffer.concat(chunks);
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          createHash("sha256").update(bytes).digest("hex") !== ref.sha256
        )
          throw new Error("批准计划文件或哈希已改变，未注入模型上下文。");
        const current = await realpath(target);
        const currentManaged = await realpath(
          resolveDesktopPaths(root).agentFilesDir,
        );
        requireWithin(managed, current);
        if (currentManaged !== managed || current !== target)
          throw new Error(
            "批准计划管理路径在读取期间已改变，未注入模型上下文。",
          );
        options.signal.throwIfAborted();
        return bytes.toString("utf8");
      } finally {
        await handle.close();
      }
    },
  };
}
