import type { BundleFormat, PluginExportArtifact } from "@loomic/shared";

/**
 * 插件导出：把插件发布为**可分发的 bundle 骨架**。
 *
 * 产物同时是两种宿主都认的 bundle：
 * - dsh：`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` + `index.js`
 * - 本项目：同一份文件，额外带 `loomic.bundle` 声明
 *
 * 因此一份导出物可以 `dsh plugin add <目录>`，也可以直接回灌本项目安装流程，
 * 无需转换步骤——这就是「双方互通」的具体含义。
 *
 * 诚实边界：本函数导出的是**声明与骨架**（能力声明 + 工具 schema + 装载形状），
 * 工具 `execute` 是占位实现。真正的业务逻辑属于插件作者；导出解决的是
 * 「形状与能力契约可移植」，不是「把 Loomic 内部实现搬过去」。
 */

export interface PluginExportToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface PluginExportSpec {
  name: string;
  version: string;
  description: string;
  license?: string | null;
  repositoryUrl?: string | null;
  /** 需要的能力（须在本项目支持面内，否则导出物装不回来） */
  capabilities: readonly string[];
  tools: readonly PluginExportToolSpec[];
  /** 额外说明（写入 README） */
  note?: string;
}

/** 模型可见工具名的合法形态（与 dsh 的 function-name 契约一致）。 */
const MAX_TOOL_NAME_LENGTH = 64;

export function sanitizeToolName(raw: string): string {
  const normalized = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (normalized.length <= MAX_TOOL_NAME_LENGTH) return normalized;
  // 截断时保留后缀哈希，避免不同名字塌缩成同一个
  // 用简单确定性摘要（无需加密强度）
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = (hash * 31 + raw.charCodeAt(index)) >>> 0;
  }
  const suffix = hash.toString(16).padStart(8, "0").slice(0, 8);
  return `${normalized.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length - 1)}_${suffix}`;
}

/** 包名 → 合法 npm 包名（导出物的 name 字段）。 */
function sanitizePackageName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return normalized || "loomic-plugin";
}

function renderIndexJs(spec: PluginExportSpec, packageName: string): string {
  const tools = spec.tools.map((tool) => ({
    name: sanitizeToolName(tool.name),
    description: tool.description,
    parameters: tool.parameters,
  }));

  return `/**
 * ${spec.name} — 由 Loomic 导出的插件骨架（双端兼容 bundle）。
 *
 * 装载形状与 dsh 一致：导出 \`name\` / \`inject\` / \`apply(ctx)\`。
 * 实现工具逻辑：替换下面的占位 execute。
 */

export const name = ${JSON.stringify(spec.name)};

export const inject = ${JSON.stringify([...spec.capabilities])};

/** 工具声明（能力契约可移植的部分）。 */
const TOOLS = ${JSON.stringify(tools, null, 2)};

export function apply(ctx) {
  for (const tool of TOOLS) {
    ctx.effect(() =>
      ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        // 占位实现：导出的是骨架，业务逻辑由插件作者补全
        execute: async () => ({
          content: [
            {
              type: "text",
              text: \`${packageName} 的 \${tool.name} 尚未实现。\`,
            },
          ],
        }),
      }),
    );
  }
}
`;
}

function renderPatch(spec: PluginExportSpec, packageName: string): string {
  const rowId = sanitizePackageName(spec.name);
  const lines = [
    "- insert:",
    `    - id: ${rowId}`,
    `      name: ${packageName}`,
  ];
  if (spec.capabilities.length > 0) {
    lines.push(`      inject: [${spec.capabilities.join(", ")}]`);
  }
  return `${lines.join("\n")}\n`;
}

function renderReadme(
  spec: PluginExportSpec,
  format: BundleFormat,
  packageName: string,
): string {
  const sections = [
    `# ${spec.name}`,
    "",
    spec.description,
    "",
    `版本：${spec.version}`,
    "",
    "## 能力声明",
    "",
    spec.capabilities.length > 0
      ? spec.capabilities.map((capability) => `- \`${capability}\``).join("\n")
      : "（未声明能力）",
    "",
    "## 工具",
    "",
    spec.tools.length > 0
      ? spec.tools
          .map(
            (tool) =>
              `- \`${sanitizeToolName(tool.name)}\`：${tool.description}`,
          )
          .join("\n")
      : "（无工具）",
    "",
    "## 安装",
    "",
  ];

  if (format === "dsh") {
    sections.push(
      "作为 deepseek-harness bundle 安装：",
      "",
      "```sh",
      `dsh plugin --profile <profile> add ./${packageName}-${spec.version}.tgz`,
      "```",
      "",
      "或用仓库地址安装（建议固定提交）：",
      "",
      "```sh",
      `dsh plugin --profile <profile> add github:<owner>/<repo>#<sha>`,
      "```",
    );
  } else {
    sections.push(
      "在本项目的插件市场里填仓库链接或本地目录路径安装；安装前会先跑兼容性门禁。",
    );
  }

  if (spec.note) {
    sections.push("", "## 说明", "", spec.note);
  }

  sections.push(
    "",
    "## 骨架提示",
    "",
    "`index.js` 里的 `execute` 是占位实现，请替换为真实逻辑。",
    "",
  );

  return sections.join("\n");
}

/**
 * 生成的骨架总要经 `ctx.tools` 注册工具，故能力声明必须含 `tools`，
 * 否则声明与实现不一致（门禁按声明的并集判定，会让产物自相矛盾）。
 */
function resolveCapabilities(spec: PluginExportSpec): string[] {
  return [...new Set(["tools", ...spec.capabilities])];
}

/**
 * 生成导出产物（文件集合 + 安装指引）。
 * 不写盘：由调用方决定落盘位置或直接回灌安装流程。
 *
 * 产物**始终双声明**（`dsh.bundle` + `loomic.bundle`），因此一份产物两端都能装；
 * `format` 只决定 README 里的安装指引面向哪个宿主。
 */
export function exportPluginBundle(
  spec: PluginExportSpec,
  format: BundleFormat,
): PluginExportArtifact {
  const packageName = sanitizePackageName(spec.name);
  const capabilities = resolveCapabilities(spec);
  const resolvedSpec: PluginExportSpec = { ...spec, capabilities };
  const pkg: Record<string, unknown> = {
    name: packageName,
    version: spec.version,
    description: spec.description,
    type: "module",
    main: "index.js",
    files: ["index.js", "cordis.patch.yml", "README.md"],
    license: spec.license ?? "MIT",
    ...(spec.repositoryUrl
      ? { repository: { type: "git", url: spec.repositoryUrl } }
      : {}),
    // 双声明：两种宿主都认同一份产物
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
    loomic: { bundle: { patch: "./cordis.patch.yml" } },
  };

  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "cordis.patch.yml": renderPatch(resolvedSpec, packageName),
    "index.js": renderIndexJs(resolvedSpec, packageName),
    "README.md": renderReadme(resolvedSpec, format, packageName),
  };

  return {
    name: spec.name,
    version: spec.version,
    format,
    files,
    installHint:
      format === "dsh"
        ? `dsh plugin --profile <profile> add ./${packageName}-${spec.version}.tgz`
        : "在本项目插件市场填入该 bundle 的仓库链接或本地目录路径安装。",
  };
}
