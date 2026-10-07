import { z } from "zod";
import type { AgentContextResourceBinding } from "./context-history.js";

const reference = z.string().refine((value) => value.trim().length > 0);
const endpointSchema = z.object({
  id: reference,
  outputRef: reference,
  childSessionId: reference.optional(),
});
const bindingsSchema = z.array(
  z.object({ source: endpointSchema, target: endpointSchema }),
);

export function parseContextResourceBindings(value: unknown) {
  return bindingsSchema.parse(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function register(map: Map<string, string>, source: string, target: string) {
  const previous = map.get(source);
  if (previous !== undefined && previous !== target)
    throw new Error("只读历史资源映射存在冲突，未复制上下文。");
  map.set(source, target);
}

function replace(
  payload: Record<string, unknown>,
  key: string,
  values: ReadonlyMap<string, string>,
) {
  const previous = payload[key];
  const next = typeof previous === "string" ? values.get(previous) : undefined;
  return next !== undefined && next !== previous
    ? { ...payload, [key]: next }
    : payload;
}

/** 原生消息与原 UI 行共用精确字段语义，不处理普通正文或递归扫描任意对象。 */
export function createContextResourceRebinder(
  input: readonly AgentContextResourceBinding[],
) {
  const bindings = parseContextResourceBindings(input);
  const ids = new Map<string, string>();
  const paths = new Map<string, string>();
  const children = new Map<string, string>();
  for (const binding of bindings) {
    register(ids, binding.source.id, binding.target.id);
    register(paths, binding.source.outputRef, binding.target.outputRef);
    if (binding.source.childSessionId || binding.target.childSessionId) {
      if (!binding.source.childSessionId || !binding.target.childSessionId)
        throw new Error("只读历史资源的子会话映射不完整，未复制上下文。");
      register(
        children,
        binding.source.childSessionId,
        binding.target.childSessionId,
      );
    }
  }
  const payload = (toolName: string, value: unknown): unknown => {
    if (!["Task", "TaskOutput", "Bash"].includes(toolName)) return value;
    if (typeof value === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return value;
      }
      const next = payload(toolName, parsed);
      return next === parsed ? value : JSON.stringify(next);
    }
    if (Array.isArray(value)) {
      const next = value.map((item) => payload(toolName, item));
      return next.some((item, index) => item !== value[index]) ? next : value;
    }
    if (!record(value)) return value;
    let next = replace(value, "taskId", ids);
    next = replace(next, "outputPath", paths);
    next = replace(next, "outputRef", paths);
    if (toolName === "Task") next = replace(next, "childSessionId", children);
    if (record(next.display)) {
      const display = replace(next.display, "outputPath", paths);
      if (display !== next.display) next = { ...next, display };
    }
    return next;
  };
  const args = (toolName: string, value: unknown): unknown => {
    if (toolName !== "TaskOutput") return value;
    if (typeof value === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return value;
      }
      const next = args(toolName, parsed);
      return next === parsed ? value : JSON.stringify(next);
    }
    return record(value) ? replace(value, "task_id", ids) : value;
  };
  return { bindings, payload, args };
}

export function rebindContextResourcePayload(
  toolName: string,
  payload: unknown,
  bindings: readonly AgentContextResourceBinding[],
): unknown {
  return createContextResourceRebinder(bindings).payload(toolName, payload);
}

export function rebindContextResourceArgs(
  toolName: string,
  args: unknown,
  bindings: readonly AgentContextResourceBinding[],
): unknown {
  return createContextResourceRebinder(bindings).args(toolName, args);
}
