import { dirname, extname } from "node:path";
import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { ScopedBackend } from "../execution/scoped-filesystem.js";
import { diffLines, summarizeDiff } from "./diff.js";
import { fileDiffDisplay, fileDiffsDisplay } from "./file-display.js";
import type { FileModelCapabilities } from "./file-types.js";
import { loadCodeDirectoryInstructions } from "./project-instructions.js";
import {
  diffSchema,
  editSchema,
  globSchema,
  grepSchema,
  patchSchema,
  previewSchema,
  readSchema,
  writeSchema,
} from "./tool-schemas.js";

export interface CodeFileToolsDeps {
  backend: ScopedBackend;
  modelCapabilities: FileModelCapabilities;
}
const mediaExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".heic",
  ".heif",
  ".pdf",
]);

function tool(
  name: string,
  schema: z.ZodType,
  description: string,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name,
    scope: "code",
    exposure: "core",
    access: ["Write", "Edit", "ApplyPatch"].includes(name) ? "write" : "read",
    description,
    parameters: z.toJSONSchema(schema),
    zodSchema: schema,
    execute,
  };
}
function project(
  canonicalOutput: object,
  text: string,
  display: Record<string, unknown>,
) {
  return { canonicalOutput, modelContent: [{ type: "text", text }], display };
}

async function withDirectoryInstructions<
  T extends {
    canonicalOutput: object;
    modelContent: Array<Record<string, unknown>>;
  },
>(
  output: T,
  path: string,
  context: ToolExecutionContext,
  backend: ScopedBackend,
) {
  if (!context.scopeHandle) return output;
  const rules = await loadCodeDirectoryInstructions(
    context.scopeHandle,
    dirname(path),
    {
      maxTextBytes: backend.limits.codeReadMaxBytes,
      maxEntries: backend.limits.codeSearchMaxResults,
    },
    context.signal,
  );
  const fragments = rules.instructions.map(
    (entry) =>
      `只适用于 ${entry.scopeDirectory} 及其子目录的规则（来源 ${entry.path}${entry.truncated ? "；已截断，请继续 Read 原文件" : ""}）：\n${entry.content}`,
  );
  if (rules.truncated)
    fragments.push(
      "目录规则受读取预算限制，当前上下文不是完整规则集。请使用 Read 继续读取原规则文件。",
    );
  const suffix = fragments.length ? `\n\n${fragments.join("\n\n")}` : "";
  let appended = false;
  const modelContent = output.modelContent.map((block) => {
    if (appended || block.type !== "text" || typeof block.text !== "string")
      return block;
    appended = true;
    return { ...block, text: `${block.text}${suffix}` };
  });
  if (!appended && suffix) modelContent.push({ type: "text", text: suffix });
  return {
    ...output,
    canonicalOutput: {
      ...output.canonicalOutput,
      instructions: rules.instructions,
      instructionsTruncated: rules.truncated,
    },
    modelContent,
  };
}

function createRead(deps: CodeFileToolsDeps): ToolDefinition {
  return tool(
    "Read",
    readSchema,
    "Read text, images or PDF files in the Task's authorized real directories. Relative paths resolve from the main directory. offset is a 1-based line; column_offset is a zero-based UTF-16 position. Use the returned version-bound continuation to read long lines or more pages. Reading observes only the returned text range.",
    async (args, context) => {
      const input = readSchema.parse(args);
      if (mediaExtensions.has(extname(input.file_path).toLowerCase())) {
        const media = await deps.backend.readMedia({
          path: input.file_path,
          signal: context.signal,
          capabilities: deps.modelCapabilities,
          ...(input.pages ? { pages: input.pages } : {}),
          ...(input.pdf_continuation
            ? { pdfContinuation: input.pdf_continuation }
            : {}),
        });
        return withDirectoryInstructions(
          {
            ...media,
            display: {
              kind: "file_io",
              operation: "read",
              path: media.filePath,
            },
          },
          media.filePath,
          context,
          deps.backend,
        );
      }
      if (input.pages || input.pdf_continuation)
        throw new Error("pages/pdf_continuation 只用于 PDF");
      const page = await deps.backend.readPage({
        path: input.file_path,
        signal: context.signal,
        ...(input.offset !== undefined
          ? { line: Math.max(1, input.offset) }
          : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.column_offset !== undefined
          ? { column: input.column_offset }
          : {}),
        ...(input.continuation ? { continuation: input.continuation } : {}),
      });
      const numbered = page.content
        .split("\n")
        .map((line, index) => `${page.startLine + index}\t${line}`)
        .join("\n");
      return withDirectoryInstructions(
        project(
          page,
          `${page.filePath}\n版本：${page.version}\n${numbered}${page.partialViewNotice ? `\n${page.partialViewNotice}` : ""}`,
          { kind: "file_io", operation: "read", path: page.filePath },
        ),
        page.filePath,
        context,
        deps.backend,
      );
    },
  );
}

function createGlob(deps: CodeFileToolsDeps): ToolDefinition {
  return tool(
    "Glob",
    globSchema,
    "Find authorized files by glob pattern, with a recoverable continuation when the configured result or byte budget is reached.",
    async (args, context) => {
      const input = globSchema.parse(args);
      const started = Date.now();
      const page = await deps.backend.globPage({
        pattern: input.pattern,
        signal: context.signal,
        ...(input.path ? { path: input.path } : {}),
        ...(input.continuation ? { continuation: input.continuation } : {}),
        ...(input.head_limit !== undefined ? { limit: input.head_limit } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
      });
      const output = {
        durationMs: Date.now() - started,
        numFiles: page.files.length,
        filenames: page.files.map((file) => file.path),
        truncated: page.truncated,
        ...(page.continuation ? { continuation: page.continuation } : {}),
      };
      return project(
        output,
        `${output.filenames.join("\n")}${page.continuation ? `\n继续搜索：${JSON.stringify(page.continuation)}` : ""}`,
        {
          kind: "search",
          operation: "glob",
          pattern: input.pattern,
          ...(input.path ? { path: input.path } : {}),
        },
      );
    },
  );
}

function createGrep(deps: CodeFileToolsDeps): ToolDefinition {
  return tool(
    "Grep",
    grepSchema,
    "Search authorized files with ripgrep regular expressions. Supports filtering, case-insensitive or multiline matching, content/files/count modes and recoverable pages. Search errors are reported explicitly.",
    async (args, context) => {
      const input = grepSchema.parse(args);
      const started = Date.now();
      const page = await deps.backend.grepPage({
        pattern: input.pattern,
        signal: context.signal,
        mode: input.output_mode,
        ...(input.path ? { path: input.path } : {}),
        ...(input.glob ? { glob: input.glob } : {}),
        ...(input.type ? { type: input.type } : {}),
        caseInsensitive: input["-i"],
        multiline: input.multiline,
        onlyMatching: input.output_mode === "content" && input["-o"],
        ...(input.output_mode === "content" && !input["-o"]
          ? {
              contextBefore: input["-B"] ?? input["-C"] ?? input.context ?? 0,
              contextAfter: input["-A"] ?? input["-C"] ?? input.context ?? 0,
            }
          : {}),
        ...(input.continuation ? { continuation: input.continuation } : {}),
        ...(input.head_limit !== undefined ? { limit: input.head_limit } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
      });
      const filenames = [...new Set(page.matches.map((match) => match.path))];
      const lines = new Map<
        string,
        { path: string; line: number; text: string }
      >();
      for (const match of page.matches) {
        for (const line of [...(match.context ?? []), match])
          lines.set(`${match.path}:${line.line}:${line.text}`, {
            path: match.path,
            line: line.line,
            text: line.text,
          });
      }
      const content =
        input.output_mode === "files_with_matches"
          ? filenames.join("\n")
          : input.output_mode === "count"
            ? page.matches
                .map((match) => `${match.path}:${match.count}`)
                .join("\n")
            : (input["-o"] ? page.matches : [...lines.values()])
                .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
                .map(
                  (match) =>
                    `${match.path}:${input["-n"] ? `${match.line}:` : ""}${match.text}`,
                )
                .join("\n");
      const output = {
        mode: input.output_mode,
        durationMs: Date.now() - started,
        numFiles: filenames.length,
        filenames,
        content,
        numLines: page.matches.length,
        ...(input.output_mode !== "files_with_matches"
          ? {
              numMatches: page.matches.reduce(
                (total, match) => total + (match.count ?? 1),
                0,
              ),
            }
          : {}),
        truncated: page.truncated,
        appliedLimit:
          input.head_limit ?? deps.backend.limits.codeSearchMaxResults,
        appliedOffset: input.continuation?.offset ?? input.offset ?? 0,
        ...(page.continuation ? { continuation: page.continuation } : {}),
      };
      return project(
        output,
        `${content}${page.continuation ? `\n继续搜索：${JSON.stringify(page.continuation)}` : ""}`,
        {
          kind: "search",
          operation: "grep",
          pattern: input.pattern,
          ...(input.path ? { path: input.path } : {}),
        },
      );
    },
  );
}

function createWrite(deps: CodeFileToolsDeps): ToolDefinition {
  return tool(
    "Write",
    writeSchema,
    "Create a file, or replace an existing file only after fully reading its current version. Creation never overwrites an existing file. Use Edit for exact partial changes. A stale observation is rejected.",
    async (args, context) => {
      const input = writeSchema.parse(args);
      const result = await deps.backend.writeFile({
        path: input.file_path,
        signal: context.signal,
        content: input.content,
        ...(input.create_only !== undefined
          ? { createOnly: input.create_only }
          : {}),
        ...(input.expected_version
          ? { expectedVersion: input.expected_version }
          : {}),
        ...(context.toolCallId ? { operationId: context.toolCallId } : {}),
      });
      return project(
        result,
        `${result.type === "create" ? "已创建" : "已更新"} ${result.filePath}，版本 ${result.version}`,
        fileDiffDisplay(result, deps.backend.limits.codePatchMaxBytes),
      );
    },
  );
}

function createEdit(deps: CodeFileToolsDeps): ToolDefinition {
  return tool(
    "Edit",
    editSchema,
    "Perform exact string replacement in a file. Read the affected original range first. old_string must be unique unless replace_all=true; remove Read's line-number prefix. Concurrent or external changes require a fresh Read.",
    async (args, context) => {
      const input = editSchema.parse(args);
      const result = await deps.backend.editFile({
        path: input.file_path,
        signal: context.signal,
        oldString: input.old_string,
        newString: input.new_string,
        replaceAll: input.replace_all,
        ...(input.expected_version
          ? { expectedVersion: input.expected_version }
          : {}),
        ...(context.toolCallId ? { operationId: context.toolCallId } : {}),
      });
      return project(
        result,
        `已修改 ${result.filePath}，替换 ${result.occurrences} 处，版本 ${result.version}`,
        fileDiffDisplay(result, deps.backend.limits.codePatchMaxBytes),
      );
    },
  );
}

function createPatch(deps: CodeFileToolsDeps): ToolDefinition {
  return tool(
    "ApplyPatch",
    patchSchema,
    "Apply a *** Begin Patch / *** End Patch patch with Add/Delete/Update File and optional Move to headers. Read existing affected ranges first. File commits share the Edit/Write version guard. Multi-file failures report actual partial commits; they are never claimed atomic.",
    async (args, context) => {
      const input = patchSchema.parse(args);
      const result = await deps.backend.applyPatch({
        patchText: input.patch_text,
        signal: context.signal,
        ...(context.toolCallId ? { operationId: context.toolCallId } : {}),
      });
      return project(
        result,
        `${result.summary}${result.failures.map((failure) => `\n${failure.filePath}：${failure.error}`).join("")}`,
        fileDiffsDisplay(result.files, deps.backend.limits.codePatchMaxBytes),
      );
    },
  );
}

function createPreview(deps: CodeFileToolsDeps): ToolDefinition {
  return tool(
    "preview_file",
    previewSchema,
    "Preview an authorized file through the same scoped reader as Read; returns metadata and a recoverable text page or supported media projection.",
    async (args, context) => {
      const input = previewSchema.parse(args);
      return createRead(deps).execute(
        {
          file_path: input.path,
          ...(input.continuation ? { continuation: input.continuation } : {}),
        },
        context,
      );
    },
  );
}

function createDiff(deps: CodeFileToolsDeps): ToolDefinition {
  return tool(
    "diff_files",
    diffSchema,
    "Compare two authorized text files through the scoped backend and return a real line diff. Both inputs must fit the configured full-read budget.",
    async (args, context) => {
      const input = diffSchema.parse(args);
      const [before, after] = await Promise.all([
        deps.backend.readRaw(input.beforePath, context.signal),
        deps.backend.readRaw(input.afterPath, context.signal),
      ]);
      if (before.error || after.error)
        throw new Error(before.error ?? after.error);
      const beforeText =
        before.data && "mimeType" in before.data
          ? before.data.content
          : undefined;
      const afterText =
        after.data && "mimeType" in after.data ? after.data.content : undefined;
      if (typeof beforeText !== "string" || typeof afterText !== "string")
        throw new Error("diff_files 只支持文本文件");
      context.signal?.throwIfAborted();
      const lines = diffLines(beforeText, afterText);
      const output = {
        beforePath: input.beforePath,
        afterPath: input.afterPath,
        summary: summarizeDiff(lines),
        lines,
      };
      return project(output, output.summary, {
        kind: "file_io",
        operation: "diff",
        beforePath: input.beforePath,
        afterPath: input.afterPath,
      });
    },
  );
}

export function createCodeFileTools(deps: CodeFileToolsDeps): ToolDefinition[] {
  return [
    createRead(deps),
    createGlob(deps),
    createGrep(deps),
    createWrite(deps),
    createEdit(deps),
    createPatch(deps),
    createPreview(deps),
    createDiff(deps),
  ];
}
