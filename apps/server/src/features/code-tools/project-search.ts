import type { BackendProtocolV2 } from "deepagents";
import { z } from "zod";

import type { ToolDefinition } from "../../kernel/types.js";

const DEFAULT_SEARCH_ROOT = "/workspace";
const DEFAULT_MAX_MATCHES = 5;

const projectSearchSchema = z.object({
  query: z.string().min(1),
  glob: z.string().min(1).optional(),
  maxMatches: z.number().int().min(1).max(20).optional(),
});

type ProjectSearchInput = z.infer<typeof projectSearchSchema>;

type ProjectSearchResult = {
  matchCount: number;
  matches: Array<{
    line: number;
    path: string;
    text: string;
  }>;
  summary: string;
};

export async function runProjectSearch(
  backend: BackendProtocolV2,
  input: ProjectSearchInput,
): Promise<ProjectSearchResult> {
  // deepagents ≥1.13 (V2 协议)：grep 返回结构化 GrepResult（error/matches）
  const result = await backend.grep(
    input.query,
    DEFAULT_SEARCH_ROOT,
    input.glob ?? null,
  );

  if (result.error || !result.matches) {
    return {
      matchCount: 0,
      matches: [],
      summary:
        result.error ?? `No workspace matches found for "${input.query}".`,
    };
  }

  const sortedMatches = [...result.matches].sort((left, right) => {
    if (left.path === right.path) {
      return left.line - right.line;
    }

    return left.path.localeCompare(right.path);
  });

  const matchCount = sortedMatches.length;
  const limitedMatches = sortedMatches.slice(
    0,
    input.maxMatches ?? DEFAULT_MAX_MATCHES,
  );
  const fileCount = new Set(sortedMatches.map((match) => match.path)).size;

  return {
    matchCount,
    matches: limitedMatches.map((match) => ({
      line: match.line,
      path: match.path,
      text: match.text,
    })),
    summary:
      matchCount === 0
        ? `No workspace matches found for "${input.query}".`
        : `Found ${matchCount} workspace match(es) for "${input.query}" across ${fileCount} file(s).`,
  };
}

/**
 * `project_search`（shared）：工作区全文检索，不经 shell。backend 绑定是
 * per-run 的（grep 虚拟工作区）——经内核动态工具缝在 run 起始期解析实例化。
 */
export function createProjectSearchToolDefinition(deps: {
  backend: BackendProtocolV2;
}): ToolDefinition {
  return {
    name: "project_search",
    description:
      "Search the KenFutWork workspace for matching project text without using shell execution.",
    scope: "shared",
    zodSchema: projectSearchSchema,
    parameters: z.toJSONSchema(projectSearchSchema),
    execute: async (args) =>
      runProjectSearch(deps.backend, projectSearchSchema.parse(args)),
  };
}
