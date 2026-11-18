import { createHash } from "node:crypto";

/** Only the digest crosses the contribution boundary; source values may contain credentials. */
export function contributionFingerprint(value: unknown): string {
  return createHash("sha256").update(stableValue(value)).digest("hex");
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
