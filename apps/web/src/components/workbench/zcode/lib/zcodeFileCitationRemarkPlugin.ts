/**
 * zcode 照搬：`@/lib/zcodeFileCitationRemarkPlugin.ts`（references/zcode/packages/ui/src/lib/zcodeFileCitationRemarkPlugin.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */

import {
  type AssistantFilePathResolveOptions,
  resolveAssistantRawFilePath,
} from "@zui/lib/assistantFileReferences";
import { getPathLeaf } from "@zui/lib/path";
import { extractZCodeFileCitations } from "@zui/lib/zcodeFileCitation";
import type { Plugin } from "unified";

interface CitationMarkdownNode {
  children?: CitationMarkdownNode[];
  type: string;
  url?: string;
  value?: string;
}

const SKIPPED_PARENT_TYPES = new Set([
  "code",
  "html",
  "image",
  "inlineCode",
  "link",
]);

function projectCitationTextNode(
  node: CitationMarkdownNode,
  workspacePath: string,
  options: AssistantFilePathResolveOptions,
): CitationMarkdownNode[] | null {
  const value = node.value ?? "";
  const citations = extractZCodeFileCitations(value);
  if (citations.length === 0) return null;

  const nextNodes: CitationMarkdownNode[] = [];
  let cursor = 0;
  for (const citation of citations) {
    const path = resolveAssistantRawFilePath(
      workspacePath,
      citation.path,
      options,
    );
    if (!path) continue;
    if (citation.start > cursor) {
      nextNodes.push({
        type: "text",
        value: value.slice(cursor, citation.start),
      });
    }
    nextNodes.push({
      type: "link",
      url: citation.path,
      children: [{ type: "text", value: getPathLeaf(path) || citation.path }],
    });
    cursor = citation.end;
  }
  if (cursor === 0) return null;
  if (cursor < value.length) {
    nextNodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nextNodes;
}

function transformCitationChildren(
  node: CitationMarkdownNode,
  workspacePath: string,
  options: AssistantFilePathResolveOptions,
): void {
  if (!node.children || SKIPPED_PARENT_TYPES.has(node.type)) return;

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]!;
    if (child.type === "text") {
      const replacement = projectCitationTextNode(
        child,
        workspacePath,
        options,
      );
      if (replacement) {
        node.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
      continue;
    }
    transformCitationChildren(child, workspacePath, options);
  }
}

export function createZCodeFileCitationRemarkPlugin(
  workspacePath: string,
  homePath?: string,
): Plugin {
  return function zcodeFileCitationRemarkPlugin() {
    return (tree: unknown) => {
      transformCitationChildren(
        tree as CitationMarkdownNode,
        workspacePath,
        homePath !== undefined ? { homePath } : {},
      );
    };
  };
}
