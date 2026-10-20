import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../kernel/types.js";
import { createOpenDesignTools } from "./tools.js";

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`未注册工具 ${name}`);
  return tool;
}

const respond = (body: unknown, status = 200) =>
  vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;

describe("createOpenDesignTools", () => {
  it("未配置前端地址时不注册任何工具（不摆只会报错的空壳）", () => {
    expect(createOpenDesignTools({ frontendUrl: undefined })).toEqual([]);
    expect(createOpenDesignTools({ frontendUrl: "   " })).toEqual([]);
  });

  it("列出项目：返回名称、id 与结构化内容", async () => {
    const fetchImpl = respond({
      projects: [
        { id: "p1", name: "高端地产展示页" },
        { id: "p2", name: "订单仪表盘" },
      ],
    });
    const tools = createOpenDesignTools({
      frontendUrl: "http://127.0.0.1:7456/",
      fetchImpl,
    });
    const result = (await byName(tools, "open_design_projects").execute!(
      {},
      {} as never,
    )) as { structuredContent: { projects: unknown[] }; content: unknown[] };
    expect(result.structuredContent.projects).toEqual([
      { id: "p1", name: "高端地产展示页" },
      { id: "p2", name: "订单仪表盘" },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:7456/api/projects",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("列文件：缺 projectId 时给可执行的提示，不发请求", async () => {
    const fetchImpl = respond({ files: [] });
    const tools = createOpenDesignTools({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl,
    });
    await expect(
      byName(tools, "open_design_project_files").execute!({}, {} as never),
    ).rejects.toThrow(/先用 open_design_projects/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("上游报错时把状态码与原因写进消息，不吞成空结果", async () => {
    const fetchImpl = respond({ error: { message: "project not found" } }, 404);
    const tools = createOpenDesignTools({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl,
    });
    await expect(
      byName(tools, "open_design_project_files").execute!(
        { projectId: "missing" },
        {} as never,
      ),
    ).rejects.toThrow(/HTTP 404（project not found）/);
  });

  it("不可达时给出「不可达」而不是原始 fetch 异常", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const tools = createOpenDesignTools({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl,
    });
    await expect(
      byName(tools, "open_design_projects").execute!({}, {} as never),
    ).rejects.toThrow(/OpenDesign 不可达/);
  });

  it("建项目：按上游契约带客户端生成的 id 与 pendingPrompt", async () => {
    const fetchImpl = respond({
      project: { id: "created-id", name: "订单仪表盘" },
    });
    const tools = createOpenDesignTools({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl,
    });
    const result = (await byName(
      tools,
      "open_design_create_project",
    ).execute!(
      { name: "订单仪表盘", prompt: "做一个订单跟踪仪表盘原型" },
      {} as never,
    )) as { structuredContent: { projectId: string; name: string } };
    expect(result.structuredContent).toEqual({
      projectId: "created-id",
      name: "订单仪表盘",
    });
    const [, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.name).toBe("订单仪表盘");
    expect(body.pendingPrompt).toBe("做一个订单跟踪仪表盘原型");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("建项目：缺 name 时不发请求", async () => {
    const fetchImpl = respond({});
    const tools = createOpenDesignTools({
      frontendUrl: "http://127.0.0.1:7456",
      fetchImpl,
    });
    await expect(
      byName(tools, "open_design_create_project").execute!({}, {} as never),
    ).rejects.toThrow(/缺少 name/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
