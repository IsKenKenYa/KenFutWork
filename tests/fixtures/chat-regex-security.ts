import assert from "node:assert/strict";
import { extractAssistantFileReferences } from "../../apps/web/src/components/workbench/zcode/lib/assistantFileReferences.js";
import { isValidAssistantPreviewWebsiteUrl } from "../../apps/web/src/components/workbench/zcode/lib/assistantPreviewCards.js";
import {
  buildFileMentionMarkdown,
  INLINE_PLUGIN_MENTION_PATTERN,
  parseMentionMarkdown,
} from "../../apps/web/src/components/workbench/zcode/mentions/mentionMarkdown.js";
import { normalizePromptMentionDisplayLabel } from "../../apps/web/src/components/workbench/zcode/mentions/promptMentionLabel.js";

const label = "folder [draft]\\file";
const markdown = buildFileMentionMarkdown("/work/file.md", label);
assert.deepEqual(parseMentionMarkdown(markdown), [{ type: "file", label }]);
assert.equal(
  normalizePromptMentionDisplayLabel("files", markdown, "fallback"),
  label,
);
const scenario = process.argv.at(-1);
if (scenario === "plugin-token") {
  assert.deepEqual(
    [
      ..."[@Clock](plugin://clock@example)".matchAll(
        INLINE_PLUGIN_MENTION_PATTERN,
      ),
    ].map((match) => match.slice(1)),
    [["Clock", "clock@example"]],
  );
  assert.deepEqual(
    [...`[@${"\\".repeat(160)}x`.matchAll(INLINE_PLUGIN_MENTION_PATTERN)],
    [],
  );
}
if (scenario === "mention-links" || scenario === "prompt-label") {
  for (const malformed of [
    `[](<${"\\=".repeat(80)}x`,
    `[](${"\\(".repeat(80)}x`,
  ]) {
    if (scenario === "mention-links") {
      assert.deepEqual(parseMentionMarkdown(malformed), [
        { type: "text", text: malformed },
      ]);
    } else {
      assert.equal(
        normalizePromptMentionDisplayLabel("files", malformed, "fallback"),
        malformed,
      );
    }
  }
}
if (scenario === "preview-url") {
  for (const punctuation of ["!", "*", "!*"]) {
    const suffix = punctuation.repeat(80);
    assert.equal(
      isValidAssistantPreviewWebsiteUrl(`http://localhost/page${suffix}`),
      true,
    );
    assert.equal(
      isValidAssistantPreviewWebsiteUrl(
        `http://localhost/${suffix}report.html`,
      ),
      !punctuation.includes("*"),
    );
  }
}
if (scenario === "file-url") {
  const path = `/work/${"!".repeat(80)}report.pdf`;
  assert.ok(
    extractAssistantFileReferences(`file://${path}`, "/work").some(
      (reference) => reference.path === path,
    ),
  );
}
console.log(`${scenario}: ok`);
