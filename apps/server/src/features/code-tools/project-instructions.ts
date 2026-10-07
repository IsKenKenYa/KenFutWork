import { dirname, join, sep } from "node:path";
import type { ExecutionScopeHandle } from "../execution/scope-service.js";
import { parseSkillManifest } from "../skills/skill-import-service.js";
import type { ReadCursor } from "./file-types.js";
import type {
  CodeProjectContext,
  CodeProjectContextLimits,
  CodeProjectInstruction,
  CodeProjectInstructions,
} from "./project-instructions-types.js";

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Initial project authority is the fixed main root, never an additional root. */
export async function loadCodeProjectContext(
  scope: ExecutionScopeHandle,
  limits: CodeProjectContextLimits,
  signal?: AbortSignal,
): Promise<CodeProjectContext> {
  validateLimits(limits);
  scope = scope.derive("explore", `project-context:${scope.agentId}`);
  const root = await scope.resolvePath(scope.describe().rootDirectory, "read");
  const result: CodeProjectContext = {
    instructions: [],
    skills: [],
    truncated: false,
    issues: [],
  };
  const instruction = await readInstruction(
    scope,
    root,
    limits.maxTextBytes,
    signal,
  );
  if (instruction) {
    if (!within(root, instruction.path))
      throw new Error(
        "主项目 AGENTS 的真实来源必须位于主目录，不能提升附加目录规则。",
      );
    result.instructions.push(instruction);
    result.truncated = instruction.truncated;
  }
  const remainingBytes =
    limits.maxTextBytes -
    (instruction ? Buffer.byteLength(instruction.content) : 0);
  await loadLocalSkills(scope, root, limits, remainingBytes, result, signal);
  return result;
}

async function readInstruction(
  scope: ExecutionScopeHandle,
  root: string,
  maxTextBytes: number,
  signal?: AbortSignal,
): Promise<CodeProjectInstruction | null> {
  try {
    const page = await scope.backend.readPage({
      path: join(root, "AGENTS.md"),
      signal,
    });
    let text = page.content;
    let incomplete = page.truncated;
    if (
      page.truncated &&
      page.sizeBytes <=
        Math.min(maxTextBytes, scope.backend.limits.codeReadMaxBytes)
    ) {
      const raw = await scope.backend.readRaw(page.filePath, signal);
      if (raw.error) throw new Error(raw.error);
      const full =
        raw.data && "mimeType" in raw.data ? raw.data.content : undefined;
      if (typeof full !== "string") throw new Error("项目规则必须是文本文件。");
      text = full;
      incomplete = false;
    }
    const content = clipUtf8(text, maxTextBytes);
    const truncated = incomplete || content.length !== text.length;
    const lines = content.split("\n");
    return {
      path: page.filePath,
      scopeDirectory: root,
      content,
      truncated,
      ...(truncated
        ? {
            continuation: {
              line: lines.length,
              column: lines.at(-1)?.length ?? 0,
              version: page.version,
            },
          }
        : {}),
    };
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return null;
}

function within(root: string, path: string): boolean {
  return (
    path === root ||
    path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  );
}

function clipUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}

function validateLimits(limits: CodeProjectContextLimits): void {
  if (
    ![limits.maxTextBytes, limits.maxEntries].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error("项目上下文字节与条目预算必须为正整数。");
}

async function readMetadata(
  scope: ExecutionScopeHandle,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
) {
  let content = "";
  let continuation: ReadCursor | undefined;
  for (;;) {
    const page = await scope.backend.readPage({
      path,
      signal,
      ...(continuation ? { continuation } : {}),
    });
    content += page.content;
    const trimmed = content.trimStart();
    const end = trimmed.indexOf("\n---", 3);
    const metadata = end >= 0 ? trimmed.slice(0, end + 4) : trimmed;
    const bounded = clipUtf8(metadata, maxBytes);
    if (bounded.length !== metadata.length)
      return { text: bounded, truncated: true };
    if (
      end >= 0 ||
      !page.continuation ||
      (trimmed && !trimmed.startsWith("---"))
    )
      return { text: bounded, truncated: false };
    if (Buffer.byteLength(content) >= maxBytes)
      return { text: bounded, truncated: true };
    continuation = page.continuation;
  }
}

/** Rules apply only beneath their source directory, including explicitly read extra roots. */
export async function loadCodeDirectoryInstructions(
  scope: ExecutionScopeHandle,
  directory: string,
  limits: CodeProjectContextLimits,
  signal?: AbortSignal,
): Promise<CodeProjectInstructions> {
  validateLimits(limits);
  scope = scope.derive("explore", `project-context:${scope.agentId}`);
  const target = await scope.resolvePath(directory, "read");
  const facts = scope.describe();
  const root = within(facts.rootDirectory, target)
    ? facts.rootDirectory
    : facts.additionalDirectories
        .filter((entry) => within(entry.path, target))
        .sort((left, right) => right.path.length - left.path.length)[0]?.path;
  if (!root) throw new Error("目录不在 Task 授权范围内。");
  const ancestry: string[] = [];
  for (let current = target; ; current = dirname(current)) {
    ancestry.push(current);
    if (current === root) break;
  }
  const result: CodeProjectInstructions = {
    instructions: [],
    truncated: false,
  };
  let remainingBytes = limits.maxTextBytes;
  for (const path of ancestry.reverse()) {
    const instruction = await readInstruction(
      scope,
      path,
      remainingBytes,
      signal,
    );
    if (!instruction) continue;
    if (result.instructions.length >= limits.maxEntries) {
      result.truncated = true;
      break;
    }
    result.instructions.push(instruction);
    remainingBytes -= Buffer.byteLength(instruction.content);
    result.truncated ||= instruction.truncated;
  }
  return result;
}

async function loadLocalSkills(
  scope: ExecutionScopeHandle,
  root: string,
  limits: CodeProjectContextLimits,
  remainingBytes: number,
  result: CodeProjectContext,
  signal?: AbortSignal,
) {
  const seen = new Set<string>();
  let attempted = 0;
  for (const folder of [".agents", ".claude", ".codex"]) {
    let entries: Awaited<ReturnType<typeof scope.backend.listDirectory>>;
    try {
      entries = await scope.backend.listDirectory(
        join(root, folder, "skills"),
        signal,
      );
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    for (const entry of entries) {
      if (!entry.is_dir) continue;
      if (attempted >= limits.maxEntries) {
        result.truncated = true;
        return;
      }
      const path = await scope.resolvePath(
        join(entry.path, "SKILL.md"),
        "read",
      );
      if (!within(root, path))
        throw new Error("项目 Skills 的真实来源必须位于主目录。");
      if (seen.has(path)) continue;
      seen.add(path);
      attempted += 1;
      let metadata: Awaited<ReturnType<typeof readMetadata>>;
      try {
        metadata = await readMetadata(scope, path, remainingBytes, signal);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      remainingBytes -= Buffer.byteLength(metadata.text);
      if (metadata.truncated) {
        result.truncated = true;
        result.issues.push({
          path,
          message:
            "Skill metadata超过项目上下文字节预算，未加载；请用 Read 查看原文件。",
        });
        return;
      }
      try {
        const manifest = parseSkillManifest(metadata.text);
        result.skills.push({
          name: manifest.name,
          description: manifest.description,
          path: await scope.resolvePath(path, "read"),
          files: [],
        });
      } catch (error) {
        result.issues.push({
          path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
