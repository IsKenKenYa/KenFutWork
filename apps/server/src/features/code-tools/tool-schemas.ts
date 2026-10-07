import { z } from "zod";

const count = z.number().int().nonnegative();
const cursor = z.object({
  line: z.number().int().positive(),
  column: count,
  version: z.string().min(1),
});
const searchCursor = z.object({
  offset: count,
  fingerprint: z.string().min(1),
  skip: count.optional(),
  resume: z
    .object({
      path: z.string().min(1),
      line: z.number().int().positive(),
      matchOffset: count,
      modifiedAt: z.string().optional(),
    })
    .optional(),
});
const pdfCursor = z.object({
  page: z.number().int().positive(),
  character: count,
  version: z.string().min(1),
});
const semanticBoolean = z.preprocess((value) => {
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(text)) return true;
    if (["false", "0", "no", "n", "off"].includes(text)) return false;
  }
  return value === 1 ? true : value === 0 ? false : value;
}, z.boolean());

export const readSchema = z.object({
  file_path: z.string().min(1),
  offset: count.optional(),
  limit: z.number().int().positive().optional(),
  column_offset: count.optional(),
  continuation: cursor.optional(),
  pages: z.string().optional(),
  pdf_continuation: pdfCursor.optional(),
});
export const globSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  continuation: searchCursor.optional(),
  head_limit: count.optional(),
  offset: count.optional(),
});
export const grepSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .default("files_with_matches"),
  "-B": count.optional(),
  "-A": count.optional(),
  "-C": count.optional(),
  context: count.optional(),
  "-n": z.boolean().default(true),
  "-i": z.boolean().default(false),
  "-o": z.boolean().default(false),
  type: z.string().optional(),
  head_limit: count.optional(),
  offset: count.optional(),
  multiline: z.boolean().default(false),
  continuation: searchCursor.optional(),
});
export const writeSchema = z.object({
  file_path: z.string().min(1),
  content: z.string(),
  create_only: z.boolean().optional(),
  expected_version: z.string().optional(),
});
export const editSchema = z.object({
  file_path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: semanticBoolean.default(false),
  expected_version: z.string().optional(),
});
export const patchSchema = z.object({ patch_text: z.string().min(1) }).strict();
export const previewSchema = z.object({
  path: z.string().min(1),
  continuation: cursor.optional(),
});
export const diffSchema = z.object({
  beforePath: z.string().min(1),
  afterPath: z.string().min(1),
});
