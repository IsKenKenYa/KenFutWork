/**
 * MCP 精选目录（内置，离线可用）。
 *
 * 用户反馈「看不到丰富的 MCP」——MCP 此前只能手填命令，没有可浏览的入口。
 * 这里内置一批**官方参考实现/常用 server**，界面上一键添加（参数用占位符让用户补，
 * 例如文件系统服务允许访问哪个目录），避免让用户自己去查 npx/uvx 的包名与参数。
 *
 * 取舍：只收 stdio 型（本项目的 MCP 客户端目前只支持 stdio 子进程）；
 * `requires` 标明本机前提（Node 的 npx / Python 的 uvx），界面据此提示。
 */

export interface CuratedParam {
  /** 占位符键，出现在 argsTemplate 的 `{{key}}` 中。 */
  key: string;
  label: string;
  example: string;
  required: boolean;
}

export interface CuratedMcpServer {
  id: string;
  /** 建议的 server 名（用户可改；会出现在工具名 mcp__<name>__<tool> 里）。 */
  name: string;
  title: string;
  description: string;
  command: string;
  /** 可含 `{{key}}` 占位符，由 params 补齐。 */
  argsTemplate: string[];
  params: CuratedParam[];
  /** 需要用户提供的环境变量键（如访问令牌）。 */
  envKeys?: string[];
  /** 本机运行前提（界面提示用户先装好）。 */
  requires: "node" | "python";
  homepage?: string;
}

export const CURATED_MCP_SERVERS: readonly CuratedMcpServer[] = [
  {
    id: "filesystem",
    name: "filesystem",
    title: "本地文件系统",
    description:
      "让 agent 读写你指定的目录（只在该目录内）。适合把项目文件夹交给它处理。",
    command: "npx",
    argsTemplate: ["-y", "@modelcontextprotocol/server-filesystem", "{{dir}}"],
    params: [
      {
        key: "dir",
        label: "允许访问的目录",
        example: "D:/Desktop/MyProject",
        required: true,
      },
    ],
    requires: "node",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "fetch",
    name: "fetch",
    title: "网页抓取",
    description: "抓取网页并转成 Markdown，适合让 agent 读在线文档。",
    command: "uvx",
    argsTemplate: ["mcp-server-fetch"],
    params: [],
    requires: "python",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "git",
    name: "git",
    title: "Git 仓库",
    description: "读取仓库状态、提交历史与差异（本地 git 操作）。",
    command: "uvx",
    argsTemplate: ["mcp-server-git", "--repository", "{{repo}}"],
    params: [
      {
        key: "repo",
        label: "仓库路径",
        example: "D:/Desktop/MyProject",
        required: true,
      },
    ],
    requires: "python",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    id: "memory",
    name: "memory",
    title: "长期记忆",
    description: "基于知识图谱的持久记忆，让 agent 跨会话记住事实与偏好。",
    command: "npx",
    argsTemplate: ["-y", "@modelcontextprotocol/server-memory"],
    params: [],
    requires: "node",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "sequential-thinking",
    name: "sequential-thinking",
    title: "分步推理",
    description: "提供一个结构化分步思考工具，适合复杂任务的显式拆解。",
    command: "npx",
    argsTemplate: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    params: [],
    requires: "node",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "time",
    name: "time",
    title: "时间与时区",
    description: "时区转换与当前时间查询（不需要联网）。",
    command: "uvx",
    argsTemplate: ["mcp-server-time"],
    params: [],
    requires: "python",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
  },
  {
    id: "sqlite",
    name: "sqlite",
    title: "SQLite 数据库",
    description: "对指定 SQLite 文件执行查询与结构探索。",
    command: "uvx",
    argsTemplate: ["mcp-server-sqlite", "--db-path", "{{db}}"],
    params: [
      {
        key: "db",
        label: "数据库文件路径",
        example: "D:/data/app.db",
        required: true,
      },
    ],
    requires: "python",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
  },
  {
    id: "github",
    name: "github",
    title: "GitHub",
    description:
      "读写仓库 issue / PR、查代码。需要 Personal Access Token（只读权限即可起步）。",
    command: "npx",
    argsTemplate: ["-y", "@modelcontextprotocol/server-github"],
    params: [],
    envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    requires: "node",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
  },
  {
    id: "everything",
    name: "everything",
    title: "Everything（参考实现）",
    description:
      "官方参考 server：一堆示例工具与资源，用于验证 MCP 链路是否正常。",
    command: "npx",
    argsTemplate: ["-y", "@modelcontextprotocol/server-everything"],
    params: [],
    requires: "node",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
  },
];

/** 用参数值把模板渲染成最终 args。返回缺失的必填参数（fail loud 在调用方）。 */
export function buildCuratedArgs(
  entry: CuratedMcpServer,
  values: Record<string, string>,
): { args: string[]; missing: string[] } {
  const missing: string[] = [];
  const args = entry.argsTemplate.map((arg) => {
    const match = /^\{\{(\w+)\}\}$/.exec(arg);
    if (!match) {
      return arg;
    }
    const key = match[1] as string;
    const value = (values[key] ?? "").trim();
    if (!value) {
      const param = entry.params.find((p) => p.key === key);
      if (param?.required) {
        missing.push(param.label);
      }
      return "";
    }
    return value;
  });
  return { args: args.filter((arg) => arg.length > 0), missing };
}
