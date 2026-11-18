export const TOOL_INTERRUPTION_SUMMARY = "执行已中断";

/** Private provenance for control exits from an owned Run, never inferred from text. */
export class OwnedToolInterruption extends Error {
  constructor() {
    super(TOOL_INTERRUPTION_SUMMARY);
    this.name = "OwnedToolInterruption";
  }
}

/** SDK middleware may wrap the original error in one or more standard causes. */
export function findOwnedToolInterruption(
  error: unknown,
): OwnedToolInterruption | undefined {
  const visited = new Set<Error>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof OwnedToolInterruption) return current;
    visited.add(current);
    current = current.cause;
  }
  return undefined;
}
