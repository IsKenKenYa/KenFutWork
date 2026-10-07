import type {
  CodeApprovalMode,
  PermissionInvocation,
} from "./approval-types.js";

export type CodePermissionPolicy = "allow" | "ask" | "deny";
export type CodePermissionPolicyInput = Pick<
  PermissionInvocation,
  | "access"
  | "role"
  | "mode"
  | "approvalCeiling"
  | "toolName"
  | "readonlyExecution"
  | "planControl"
>;

/** 仅主Task可控制规划；控制声明不能掩盖资源副作用。 */
export function allowsPlanControl(
  input: Pick<PermissionInvocation, "role" | "access" | "planControl">,
): boolean {
  return (
    (input.planControl === "enter" || input.planControl === "exit") &&
    input.role === "main" &&
    input.access === undefined
  );
}

/** Task policy is independent of the installation-wide tier and its memory. */
export function codePermissionPolicy(
  input: CodePermissionPolicyInput,
): CodePermissionPolicy {
  if (input.planControl !== undefined) {
    if (!allowsPlanControl(input)) return "deny";
    return input.planControl === "exit" ? "ask" : "allow";
  }
  if (!input.access) return "deny";
  if (input.access === "read") return "allow";
  if (input.role === "explore" || input.role === "review") return "deny";
  const taskPolicy = modePolicy(input.mode, input);
  if (input.role !== "worker") return taskPolicy;
  const ceiling = modePolicy(input.approvalCeiling, input);
  if (taskPolicy === "deny" || ceiling === "deny") return "deny";
  return taskPolicy === "ask" || ceiling === "ask" ? "ask" : "allow";
}

function modePolicy(
  mode: CodeApprovalMode,
  input: CodePermissionPolicyInput,
): CodePermissionPolicy {
  if (mode === "plan") {
    return input.role === "main" &&
      input.toolName === "Bash" &&
      input.access === "execute" &&
      input.readonlyExecution === true
      ? "ask"
      : "deny";
  }
  if (mode === "yolo") return "allow";
  if (
    mode === "edit" &&
    input.access === "write" &&
    ["Write", "Edit", "ApplyPatch"].includes(input.toolName)
  )
    return "allow";
  return "ask";
}
