function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Result qualification only; each Task consumer must verify its own persisted Run provenance. */
export function isGoalToolEvidence(
  toolName: string,
  outputText: string,
  command = "",
): boolean {
  if (!outputText.trim() || ["GetGoal", "VerifyGoal"].includes(toolName))
    return false;
  if (["Bash", "execute"].includes(toolName)) {
    const result = objectValue(outputText);
    const normalized = command.trim().replace(/;$/u, "").trim();
    return (
      normalized.length > 0 &&
      result?.state === "exited" &&
      result.exitCode === 0 &&
      !["true", ":", "exit 0"].includes(normalized)
    );
  }
  if (["TaskOutput", "task_output"].includes(toolName)) {
    const result = objectValue(outputText);
    if (result?.status !== "completed") return false;
    const summary = objectValue(result.summary);
    return (
      !summary ||
      (!("exitCode" in summary) && !("state" in summary)) ||
      (summary.state === "exited" && summary.exitCode === 0)
    );
  }
  const result = objectValue(outputText);
  return (
    !result?.error &&
    result?.success !== false &&
    result?.ok !== false &&
    (toolName !== "manipulate_canvas" || result?.applied !== 0)
  );
}
