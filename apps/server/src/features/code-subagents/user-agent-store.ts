import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  type AgentColor,
  type AgentDiagnostic,
  type AgentPermissionMode,
  createAgentStateId,
  formatModelPickerValue,
  type ModelSelection,
  modelSelectionSchema,
  parseModelPickerValue,
  type SubAgentConfig,
} from "@zcode/shared";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";

/**
 * 用户 / 工作区智能体存储（ZCode 兼容的 Markdown profile）。
 *
 * 身份只由名称决定：`user:user:<name>` / `user:workspace:<name>`；文件落在
 * 用户级 `<dataDir>/agents/<name>.md` 与项目级 `<workspace>/.zcode/agents/<name>.md`。
 * 启用状态与内置覆盖存在实例级 `<dataDir>/agents-state.json`，与 ZCode 的
 * `agents-state.json` 同形（只保留本宿主实际消费的字段）。
 */

export type UserAgentScope = "user" | "workspace";

export interface UserAgentRecord {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
  path: string;
  scope: UserAgentScope;
}

export interface UserAgentState {
  disabledAgentIds: string[];
  builtInModelSelectionOverrides: Record<string, ModelSelection>;
}

export interface UserAgentList {
  agents: UserAgentRecord[];
  diagnostics: AgentDiagnostic[];
  state: UserAgentState;
}

const NAME_PATTERN = /^[a-zA-Z0-9-]+$/u;
const NAME_MIN_LENGTH = 3;
const NAME_MAX_LENGTH = 50;
const RESERVED_NAMES = new Set([
  "explore",
  "review",
  "worker",
  "general-purpose",
]);
const COLORS = new Set<AgentColor>([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);
const PERMISSION_MODES = new Set<AgentPermissionMode>(["auto", "plan"]);

const writeQueues = new Map<string, Promise<unknown>>();

function serializeWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

export function userAgentsDirectory(dataDir: string): string {
  return join(dataDir, "agents");
}

export function workspaceAgentsDirectory(workspacePath: string): string {
  return join(workspacePath, ".zcode", "agents");
}

export function userAgentsStatePath(dataDir: string): string {
  return join(dataDir, "agents-state.json");
}

export function defaultAgentsInstructionPath(dataDir: string): string {
  return join(dataDir, "AGENTS.md");
}

export function userAgentId(name: string, scope: UserAgentScope): string {
  return createAgentStateId({ name, scope, source: "user" });
}

export async function readUserAgentState(
  dataDir: string,
): Promise<UserAgentState> {
  const empty: UserAgentState = {
    disabledAgentIds: [],
    builtInModelSelectionOverrides: {},
  };
  try {
    const raw = JSON.parse(
      await readFile(userAgentsStatePath(dataDir), "utf8"),
    ) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
    const record = raw as Record<string, unknown>;
    const disabledAgentIds = Array.isArray(record.disabledAgentIds)
      ? record.disabledAgentIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const overrides =
      record.builtInModelSelectionOverrides &&
      typeof record.builtInModelSelectionOverrides === "object" &&
      !Array.isArray(record.builtInModelSelectionOverrides)
        ? Object.fromEntries(
            Object.entries(
              record.builtInModelSelectionOverrides as Record<string, unknown>,
            ).flatMap(([key, value]) => {
              const parsed = modelSelectionSchema.safeParse(value);
              return parsed.success ? [[key, parsed.data] as const] : [];
            }),
          )
        : {};
    return { disabledAgentIds, builtInModelSelectionOverrides: overrides };
  } catch {
    return empty;
  }
}

export async function writeUserAgentState(
  dataDir: string,
  state: UserAgentState,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeAtomic(
    userAgentsStatePath(dataDir),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export async function setUserAgentEnabled(
  dataDir: string,
  agentId: string,
  enabled: boolean,
): Promise<void> {
  await serializeWrite(userAgentsStatePath(dataDir), async () => {
    const state = await readUserAgentState(dataDir);
    const disabled = new Set(state.disabledAgentIds);
    if (enabled) disabled.delete(agentId);
    else disabled.add(agentId);
    await writeUserAgentState(dataDir, {
      ...state,
      disabledAgentIds: [...disabled].sort(),
    });
  });
}

export async function setBuiltInModelOverride(
  dataDir: string,
  agentName: string,
  selection: ModelSelection | undefined,
): Promise<void> {
  await serializeWrite(userAgentsStatePath(dataDir), async () => {
    const state = await readUserAgentState(dataDir);
    const overrides = { ...state.builtInModelSelectionOverrides };
    if (selection) overrides[agentName] = selection;
    else delete overrides[agentName];
    await writeUserAgentState(dataDir, {
      ...state,
      builtInModelSelectionOverrides: overrides,
    });
  });
}

export async function listUserAgents(
  dataDir: string,
  scope: UserAgentScope,
  directory: string,
): Promise<UserAgentList> {
  const state = await readUserAgentState(dataDir);
  const diagnostics: AgentDiagnostic[] = [];
  const agents: UserAgentRecord[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      diagnostics.push({
        code: "agent_directory_unreadable",
        message: `智能体目录不可读：${directory}`,
        path: directory,
      });
    return { agents, diagnostics, state };
  }
  for (const entry of entries.sort()) {
    if (!/\.md$/iu.test(entry)) continue;
    const path = join(directory, entry);
    try {
      const parsed = parseAgentMarkdown(
        await readFile(path, "utf8"),
        path,
        scope,
      );
      if ("diagnostic" in parsed) {
        diagnostics.push(parsed.diagnostic);
        continue;
      }
      agents.push(parsed.agent);
    } catch {
      diagnostics.push({
        code: "agent_read_failed",
        message: `智能体文件读取失败：${path}`,
        path,
      });
    }
  }
  return { agents, diagnostics, state };
}

export async function createUserAgent(options: {
  dataDir: string;
  directory: string;
  scope: UserAgentScope;
  config: SubAgentConfig;
}): Promise<UserAgentRecord> {
  const config = validateConfig(options.config);
  return serializeWrite(options.directory, async () => {
    const existing = await listUserAgents(
      options.dataDir,
      options.scope,
      options.directory,
    );
    assertNameAvailable(existing.agents, config.name);
    await mkdir(options.directory, { recursive: true });
    const path = join(options.directory, `${config.name.toLowerCase()}.md`);
    const content = serializeAgentMarkdown(config);
    const parsed = parseAgentMarkdown(content, path, options.scope);
    if ("diagnostic" in parsed)
      throw new Error(`智能体配置无法序列化：${parsed.diagnostic.message}`);
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return parsed.agent;
  });
}

export async function updateUserAgent(options: {
  dataDir: string;
  directory: string;
  scope: UserAgentScope;
  agentId: string;
  config: SubAgentConfig;
}): Promise<UserAgentRecord> {
  const config = validateConfig(options.config);
  return serializeWrite(options.directory, async () => {
    const existing = await listUserAgents(
      options.dataDir,
      options.scope,
      options.directory,
    );
    const current = existing.agents.find(
      (agent) => agent.id === options.agentId,
    );
    if (!current) throw new Error("要更新的智能体不存在，请刷新列表后重试。");
    assertNameAvailable(
      existing.agents.filter((agent) => agent.id !== current.id),
      config.name,
    );
    await mkdir(options.directory, { recursive: true });
    const path = join(options.directory, `${config.name.toLowerCase()}.md`);
    const content = serializeAgentMarkdown(config);
    const parsed = parseAgentMarkdown(content, path, options.scope);
    if ("diagnostic" in parsed)
      throw new Error(`智能体配置无法序列化：${parsed.diagnostic.message}`);
    await writeAtomic(path, content);
    if (parsed.agent.id !== current.id)
      await migrateDisabledAgentId(
        options.dataDir,
        current.id,
        parsed.agent.id,
      );
    if (current.path !== path) await rm(current.path, { force: true });
    return parsed.agent;
  });
}

export async function deleteUserAgent(options: {
  dataDir: string;
  directory: string;
  scope: UserAgentScope;
  agentId: string;
}): Promise<void> {
  await serializeWrite(options.directory, async () => {
    const existing = await listUserAgents(
      options.dataDir,
      options.scope,
      options.directory,
    );
    const current = existing.agents.find(
      (agent) => agent.id === options.agentId,
    );
    if (!current) throw new Error("要删除的智能体不存在，请刷新列表后重试。");
    await rm(current.path, { force: true });
    const state = await readUserAgentState(options.dataDir);
    if (state.disabledAgentIds.includes(current.id))
      await writeUserAgentState(options.dataDir, {
        ...state,
        disabledAgentIds: state.disabledAgentIds.filter(
          (id) => id !== current.id,
        ),
      });
  });
}

export async function findUserAgentByName(options: {
  dataDir: string;
  directory: string;
  scope: UserAgentScope;
  name: string;
  enabledOnly?: boolean;
}): Promise<UserAgentRecord | null> {
  const listed = await listUserAgents(
    options.dataDir,
    options.scope,
    options.directory,
  );
  const normalized = options.name.trim().toLowerCase();
  const agent =
    listed.agents.find(
      (candidate) => candidate.name.toLowerCase() === normalized,
    ) ?? null;
  if (!agent) return null;
  if (options.enabledOnly && listed.state.disabledAgentIds.includes(agent.id))
    return null;
  return agent;
}

function validateConfig(config: SubAgentConfig): SubAgentConfig {
  const name = config.name.trim();
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH)
    throw new Error(
      `智能体名称需要 ${NAME_MIN_LENGTH}–${NAME_MAX_LENGTH} 个字符。`,
    );
  if (!NAME_PATTERN.test(name))
    throw new Error("智能体名称只能包含字母、数字和连字符。");
  if (RESERVED_NAMES.has(name.toLowerCase()))
    throw new Error(`「${name}」是内置派发名，不能用于自定义智能体。`);
  if (!config.description.trim()) throw new Error("智能体描述不能为空。");
  if (!config.systemPrompt.trim())
    throw new Error("智能体系统提示词不能为空。");
  const tools = config.tools ? uniqueStrings(config.tools) : undefined;
  const disallowedTools = config.disallowedTools
    ? uniqueStrings(config.disallowedTools)
    : undefined;
  const skills = config.skills ? uniqueStrings(config.skills) : undefined;
  return {
    name,
    description: config.description.trim(),
    systemPrompt: config.systemPrompt.trim(),
    ...(config.color ? { color: config.color } : {}),
    ...(config.modelSelection
      ? { modelSelection: modelSelectionSchema.parse(config.modelSelection) }
      : {}),
    ...(tools ? { tools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(skills ? { skills } : {}),
    ...(config.injectAgentsMd !== undefined
      ? { injectAgentsMd: config.injectAgentsMd }
      : {}),
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
    ...(config.background !== undefined
      ? { background: config.background }
      : {}),
    ...(config.mcpServers?.length ? { mcpServers: config.mcpServers } : {}),
  };
}

function assertNameAvailable(
  agents: readonly UserAgentRecord[],
  name: string,
): void {
  const normalized = name.trim().toLowerCase();
  if (agents.some((agent) => agent.name.toLowerCase() === normalized))
    throw new Error(`智能体「${name}」已存在。`);
}

function uniqueStrings(values: readonly string[]): string[] | undefined {
  const result = [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ];
  return result.length > 0 ? result : undefined;
}

async function migrateDisabledAgentId(
  dataDir: string,
  previousId: string,
  nextId: string,
): Promise<void> {
  if (previousId === nextId) return;
  const state = await readUserAgentState(dataDir);
  if (!state.disabledAgentIds.includes(previousId)) return;
  await writeUserAgentState(dataDir, {
    ...state,
    disabledAgentIds: [
      ...new Set(
        state.disabledAgentIds.filter((id) => id !== previousId).concat(nextId),
      ),
    ].sort(),
  });
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function serializeAgentMarkdown(config: SubAgentConfig): string {
  const frontmatter: Record<string, unknown> = {
    name: config.name.trim(),
    description: config.description.trim(),
  };
  if (config.color) frontmatter.color = config.color;
  if (config.modelSelection) {
    frontmatter.model = formatModelPickerValue(config.modelSelection);
    const level = config.modelSelection.options?.reasoningLevel;
    if (level) frontmatter.thoughtLevel = level;
  }
  if (config.tools?.length) frontmatter.tools = config.tools;
  if (config.disallowedTools?.length)
    frontmatter.disallowedTools = config.disallowedTools;
  if (config.skills?.length) frontmatter.skills = config.skills;
  if (config.permissionMode) frontmatter.permissionMode = config.permissionMode;
  if (config.maxTurns !== undefined) frontmatter.maxTurns = config.maxTurns;
  if (config.background !== undefined)
    frontmatter.background = config.background;
  if (config.injectAgentsMd !== undefined)
    frontmatter.injectAgentsMd = config.injectAgentsMd;
  if (config.mcpServers?.length) frontmatter.mcpServers = config.mcpServers;
  const yaml = dumpYaml(frontmatter, { lineWidth: 0, noRefs: true }).trimEnd();
  return `---\n${yaml}\n---\n${config.systemPrompt.trim()}\n`;
}

export function parseAgentMarkdown(
  content: string,
  path: string,
  scope: UserAgentScope,
): { agent: UserAgentRecord } | { diagnostic: AgentDiagnostic } {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---")) return missingFrontmatter(path);
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return missingFrontmatter(path);
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (end < 0) return missingFrontmatter(path);
  let raw: unknown;
  try {
    raw = loadYaml(lines.slice(1, end).join("\n"));
  } catch {
    return {
      diagnostic: {
        code: "agent_invalid_frontmatter",
        message: "智能体 Markdown 的 frontmatter 不是合法 YAML。",
        path,
      },
    };
  }
  const frontmatter =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const name = stringValue(frontmatter.name);
  const description = stringValue(frontmatter.description);
  if (!name || !description)
    return {
      diagnostic: {
        code: "agent_missing_required_frontmatter",
        message: "智能体 frontmatter 必须包含 name 与 description。",
        path,
      },
    };
  const systemPrompt = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  const color = COLORS.has(frontmatter.color as AgentColor)
    ? (frontmatter.color as AgentColor)
    : undefined;
  const permissionMode = PERMISSION_MODES.has(
    frontmatter.permissionMode as AgentPermissionMode,
  )
    ? (frontmatter.permissionMode as AgentPermissionMode)
    : undefined;
  const modelSelection = parseModelSelection(frontmatter);
  const tools = stringList(frontmatter.tools);
  const disallowedTools = stringList(frontmatter.disallowedTools);
  const skills = stringList(frontmatter.skills);
  const maxTurns = positiveInteger(frontmatter.maxTurns);
  return {
    agent: {
      id: userAgentId(name, scope),
      name,
      description,
      systemPrompt,
      path,
      scope,
      ...(color ? { color } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      ...(tools ? { tools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
      ...(skills ? { skills } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(typeof frontmatter.background === "boolean"
        ? { background: frontmatter.background }
        : {}),
      ...(typeof frontmatter.injectAgentsMd === "boolean"
        ? { injectAgentsMd: frontmatter.injectAgentsMd }
        : {}),
      ...(Array.isArray(frontmatter.mcpServers)
        ? { mcpServers: frontmatter.mcpServers }
        : {}),
    },
  };
}

function missingFrontmatter(path: string): { diagnostic: AgentDiagnostic } {
  return {
    diagnostic: {
      code: "agent_missing_frontmatter",
      message: "智能体 Markdown 必须包含 frontmatter。",
      path,
    },
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return result.length > 0 ? result : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function parseModelSelection(
  frontmatter: Record<string, unknown>,
): ModelSelection | undefined {
  const model = stringValue(frontmatter.model);
  if (!model) return undefined;
  try {
    const selection = parseModelPickerValue(model);
    const level = stringValue(frontmatter.thoughtLevel);
    return modelSelectionSchema.parse({
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(level ? { options: { reasoningLevel: level } } : {}),
    });
  } catch {
    return undefined;
  }
}
