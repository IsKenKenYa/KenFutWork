import { z } from "zod";
import {
  cadDescribeInputSchema,
  cadExportInputSchema,
  cadOperationsInputSchema,
  cadPreviewInputSchema,
  cadPrimitiveInputSchema,
  cadPythonInputSchema,
} from "../cad/tool-contracts.js";

export type ApprovalReviewKind = keyof typeof operationSchemas;

const operationSchemas = {
  "cad-python": cadPythonInputSchema,
  "cad-primitive": cadPrimitiveInputSchema,
  "cad-operations": cadOperationsInputSchema,
  "cad-export": cadExportInputSchema,
  "cad-describe": cadDescribeInputSchema,
  "cad-preview": cadPreviewInputSchema,
  write: z
    .object({
      file_path: z.string().min(1),
      content: z.string(),
      create_only: z.boolean().optional(),
      expected_version: z.string().optional(),
    })
    .strict(),
  edit: z
    .object({
      file_path: z.string().min(1),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
      expected_version: z.string().optional(),
    })
    .strict(),
  patch: z.object({ patch_text: z.string().min(1) }).strict(),
  command: z
    .object({
      command: z.string().min(1),
      description: z.string().optional(),
      cwd: z.string().optional(),
      run_in_background: z.boolean().optional(),
      timeout: z.number().int().positive().nullable().optional(),
      env: z.object({}).strict().optional(),
    })
    .strict(),
};

const inputSchema = z
  .object({
    kind: z.enum([
      "write",
      "edit",
      "patch",
      "command",
      "cad-python",
      "cad-primitive",
      "cad-operations",
      "cad-export",
      "cad-describe",
      "cad-preview",
    ]),
    args: z.record(z.string(), z.unknown()),
    userRequest: z.string(),
    rootDirectory: z.string().min(1),
    additionalDirectories: z.array(
      z
        .object({
          path: z.string().min(1),
          access: z.enum(["read-only", "read-write"]),
        })
        .strict(),
    ),
    sandboxMode: z.string().min(1),
    maxCharacters: z.number().int().positive(),
  })
  .strict();

const sensitivePath =
  /(?:^|[/\\\s"'`=:;|()<>])(?:\.env(?:[.\w-]*)?|\.ssh|\.aws|\.azure|\.kube|\.git-credentials|\.netrc|\.npmrc|\.pypirc|credentials?(?:[.\w-]*)?|secrets?(?:[.\w-]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/\\\s"'`]+\.(?:pem|p12|pfx|key))(?:$|[/\\\s"'`?&#:;,|()<>])/iu;
const credentialPatterns = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu,
  /\b(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token)["']?\s*[:=]/iu,
  /\b(?:api[-_]?key|api[-_]?token|token|secret|password|passwd|client[-_]?secret|private[-_]?key|access[-_]?token|refresh[-_]?token|aws[-_]secret[-_]access[-_]key)["']?\s*[:=]\s*\S/iu,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{8,}/iu,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/iu,
];
const sensitiveQueryKey =
  /^(?:signature|sig|token|access[-_]?token|refresh[-_]?token|api[-_]?key|key|auth|authorization|password|policy|key-pair-id|ossaccesskeyid|x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential)|q-(?:signature|ak))$/iu;

function hasSignedUrl(text: string): boolean {
  const urls = text.match(/https?:\/\/[^\s<>"'`]+/giu) ?? [];
  return urls.some((candidate) => {
    try {
      const url = new URL(candidate);
      return (
        Boolean(url.username || url.password) ||
        [...url.searchParams.keys()].some((key) => sensitiveQueryKey.test(key))
      );
    } catch {
      // A malformed URL cannot provide complete, reviewable evidence.
      return true;
    }
  });
}

function hasSensitiveText(value: unknown): boolean {
  if (typeof value === "string")
    return (
      sensitivePath.test(value) ||
      credentialPatterns.some((pattern) => pattern.test(value)) ||
      hasSignedUrl(value)
    );
  if (Array.isArray(value)) return value.some(hasSensitiveText);
  if (value && typeof value === "object")
    return Object.values(value).some(hasSensitiveText);
  return false;
}

/** Whole evidence only: unreviewable arguments remain with human approval. */
export function approvalReviewEvidence(input: {
  kind: ApprovalReviewKind;
  args: Record<string, unknown>;
  userRequest: string;
  rootDirectory: string;
  additionalDirectories: readonly {
    path: string;
    access: "read-only" | "read-write";
  }[];
  sandboxMode: string;
  maxCharacters: number;
}): Record<string, unknown> | undefined {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const context = parsed.data;
  if (Object.values(context.args).some((value) => value === undefined))
    return undefined;
  const operation = operationSchemas[context.kind].safeParse(context.args);
  if (!operation.success) return undefined;
  const evidence = {
    untrustedData: {
      userRequest: context.userRequest,
      workspace: {
        rootDirectory: context.rootDirectory,
        additionalDirectories: context.additionalDirectories,
        sandboxMode: context.sandboxMode,
      },
      operation: { kind: context.kind, args: operation.data },
    },
  };
  if (
    JSON.stringify(evidence).length > context.maxCharacters ||
    hasSensitiveText(evidence)
  )
    return undefined;
  return evidence;
}
