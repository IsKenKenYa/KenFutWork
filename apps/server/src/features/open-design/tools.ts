import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../../kernel/types.js";

/** 与宿主探活同一档超时：这是外部服务，不能把 run 挂死。 */
const OPEN_DESIGN_TOOL_TIMEOUT_MS = 8000;

interface OpenDesignProject {
  id: string;
  name: string;
}

interface OpenDesignFile {
  path?: string;
  name?: string;
  kind?: string;
}

/**
 * OpenDesign 的对话能力（只读面）。
 *
 * 工具由**宿主 feature** 注册而不是插件 bundle：插件 ctx 拿不到宿主配置
 * （`frontendUrl` 来自 env / 桌面 `config/open-design.env`），为此新增插件能力要动
 * 跨端规范能力枚举；`install_plugin` 已经确立了「feature 注册工具、直接读 ctx.env」
 * 的先例，这里沿用它。
 *
 * 未配置前端地址时返回空数组——不注册一个只会报错的工具。
 * 写面（建项目 / 改画布）等上游 POST 契约确认后再加，避免猜协议。
 */
export function createOpenDesignTools(input: {
  frontendUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** 建项目成功后记一笔「最近项目」，右侧面板据此打开对应画布。 */
  onProjectCreated?: (project: { projectId: string; name: string }) => void;
}): ToolDefinition[] {
  const baseUrl = input.frontendUrl?.trim().replace(/\/$/u, "") ?? "";
  if (!baseUrl) return [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? OPEN_DESIGN_TOOL_TIMEOUT_MS;

  async function requestJson<T>(
    path: string,
    what: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: init?.method ?? "GET",
        ...(init?.body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(init.body),
            }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `${what}失败：OpenDesign 不可达（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as {
          error?: { message?: string };
        };
        detail = body?.error?.message ?? "";
      } catch {
        // 非 JSON 错误体：保留状态码即可
      }
      throw new Error(
        `${what}失败：OpenDesign 返回 HTTP ${response.status}${detail ? `（${detail}）` : ""}`,
      );
    }
    return (await response.json()) as T;
  }

  return [
    {
      name: "open_design_projects",
      access: "read",
      scope: "shared",
      description:
        "列出本机 OpenDesign 里的设计项目（id 与名称）。用户提到「之前的原型 / 设计稿」时先用它定位项目，再用 open_design_project_files 看该项目有哪些文件。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const data = await requestJson<{ projects?: OpenDesignProject[] }>(
          "/api/projects",
          "读取 OpenDesign 项目列表",
        );
        const projects = (data.projects ?? []).map((project) => ({
          id: project.id,
          name: project.name,
        }));
        return {
          content: [
            {
              type: "text",
              text: projects.length
                ? projects.map((p) => `${p.name}（${p.id}）`).join("\n")
                : "OpenDesign 里还没有项目。",
            },
          ],
          structuredContent: { projects },
        };
      },
    },
    {
      name: "open_design_project_files",
      access: "read",
      scope: "shared",
      description:
        "列出某个 OpenDesign 项目里的设计文件。先用 open_design_projects 拿 projectId。",
      parameters: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "open_design_projects 返回的项目 id",
          },
        },
        required: ["projectId"],
      },
      execute: async (args) => {
        const projectId = String(args?.projectId ?? "").trim();
        if (!projectId) throw new Error("缺少 projectId：先用 open_design_projects 查。");
        const data = await requestJson<{ files?: OpenDesignFile[] }>(
          `/api/projects/${encodeURIComponent(projectId)}/files`,
          "读取 OpenDesign 项目文件",
        );
        const files = (data.files ?? []).map((file) => ({
          path: file.path ?? file.name ?? "",
          ...(file.kind ? { kind: file.kind } : {}),
        }));
        return {
          content: [
            {
              type: "text",
              text: files.length
                ? files.map((f) => f.path).join("\n")
                : "该项目还没有生成任何设计文件。",
            },
          ],
          structuredContent: { projectId, files },
        };
      },
    },
    {
      name: "open_design_create_project",
      // 会落盘并可能触发上游设计 agent：进默认档审批。
      access: "write",
      scope: "shared",
      description:
        "在 OpenDesign 里新建一个设计项目。prompt 写清要做什么（例如「做一个订单跟踪仪表盘原型」）。返回 projectId；之后用 open_design_project_files 查看生成的设计文件。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "项目名（可读、简短）" },
          prompt: {
            type: "string",
            description: "给设计 agent 的需求描述",
          },
        },
        required: ["name"],
      },
      execute: async (args) => {
        const name = String(args?.name ?? "").trim();
        if (!name) throw new Error("缺少 name：给项目起一个可读的名字。");
        const prompt = String(args?.prompt ?? "").trim();
        // 上游要求客户端生成 id（`isSafeId`），并据此建目录。
        const id = randomUUID();
        const data = await requestJson<{
          project?: { id?: string; name?: string };
        }>("/api/projects", "创建 OpenDesign 项目", {
          method: "POST",
          body: {
            id,
            name,
            ...(prompt ? { pendingPrompt: prompt } : {}),
          },
        });
        const projectId = data?.project?.id ?? id;
        if (!projectId)
          throw new Error("创建 OpenDesign 项目失败：上游未返回项目 id");
        const projectName = data?.project?.name ?? name;
        // 记录失败不能反过来把「已建成的项目」判成失败：只影响右侧能否自动定位。
        try {
          input.onProjectCreated?.({ projectId, name: projectName });
        } catch {
          // ignore
        }
        return {
          content: [
            {
              type: "text",
              text: `已创建 OpenDesign 项目「${projectName}」（${projectId}）。`,
            },
          ],
          structuredContent: { projectId, name: projectName },
        };
      },
    },
  ];
}
