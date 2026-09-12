/**
 * 最小 Supabase REST 模拟（本地点击测试用，不入库不提交）。
 * 仅模拟 settings/providers/usage/skills 流所需的 PostgREST 形状。
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_ID = "ws-00000000-0000-0000-0000-000000000001";

const projects = new Map();
const canvases = new Map();
const sessionsByCanvas = new Map();

const WORKSPACE = {
  id: WORKSPACE_ID,
  name: "Personal",
  type: "personal",
  owner_user_id: USER_ID,
};

const providerInstances = new Map();

function send(res, status, payload, single) {
  const body =
    single && (payload === null || payload === undefined)
      ? JSON.stringify(payload ?? null)
      : JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  console.log(
    `[mock] ${req.method} ${req.url} accept=${req.headers.accept ?? ""}`,
  );
  const wantsObject = (req.headers.accept ?? "").includes("vnd.pgrst.object");

  if (!path.startsWith("/rest/v1/")) {
    send(res, 200, {});
    return;
  }

  const table = path.slice("/rest/v1/".length).split("?")[0];

  // RPC 一律空对象成功；create_project_with_canvas 造项目+主画布
  if (path.startsWith("/rest/v1/rpc/")) {
    if (path.includes("create_project_with_canvas") && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const input = JSON.parse(body || "{}");
        const now = new Date().toISOString();
        const projectId = randomUUID();
        const canvasId = randomUUID();
        const project = {
          id: projectId,
          name: input.p_name ?? "Untitled",
          slug: (input.p_slug ?? `p-${projectId.slice(0, 8)}`).toLowerCase(),
          description: input.p_description ?? null,
          workspace_id: WORKSPACE_ID,
          brand_kit_id: null,
          created_at: now,
          updated_at: now,
        };
        const canvas = {
          id: canvasId,
          name: input.p_canvas_name ?? "Main Canvas",
          is_primary: true,
          project_id: projectId,
          content: { elements: [], appState: {}, files: {} },
        };
        projects.set(project.id, project);
        canvases.set(canvas.id, canvas);
        send(res, 200, { project, canvas });
      });
      return;
    }
    send(res, 200, {});
    return;
  }

  if (table === "projects" && req.method === "GET") {
    send(res, 200, [...projects.values()]);
    return;
  }
  if (table === "canvases" && req.method === "GET") {
    const idParam = (url.searchParams.get("id") ?? "").replace("eq.", "");
    const projectIdParam = (url.searchParams.get("project_id") ?? "")
      .replace("in.(", "")
      .replace(")", "");
    if (idParam) {
      const canvas = canvases.get(idParam) ?? null;
      send(res, 200, canvas, true);
      return;
    }
    let list = [...canvases.values()];
    if (projectIdParam) {
      const ids = projectIdParam.split(",");
      list = list.filter((c) => ids.includes(c.project_id));
    }
    send(res, 200, list);
    return;
  }
  if (table === "sessions") {
    if (req.method === "GET") {
      send(
        res,
        200,
        sessionsByCanvas.get(
          url.searchParams.get("canvas_id")?.replace("eq.", ""),
        ) ?? [],
      );
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const row = JSON.parse(body || "{}");
        const full = {
          id: row.id ?? randomUUID(),
          canvas_id: row.canvas_id ?? "",
          title: row.title ?? "新会话",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const list = sessionsByCanvas.get(full.canvas_id) ?? [];
        list.push(full);
        sessionsByCanvas.set(full.canvas_id, list);
        send(res, 201, full, true);
      });
      return;
    }
  }
  if (table === "messages") {
    if (req.method === "GET") {
      send(res, 200, []);
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        send(res, 201, JSON.parse(body || "{}"), true);
      });
      return;
    }
  }

  if (table === "workspaces" && req.method === "GET") {
    send(res, 200, wantsObject ? WORKSPACE : [WORKSPACE], wantsObject);
    return;
  }
  if (table === "profiles" && req.method === "GET") {
    send(
      res,
      200,
      wantsObject
        ? {
            id: USER_ID,
            email: "tester@local.test",
            display_name: "本地测试",
            avatar_url: null,
          }
        : [
            {
              id: USER_ID,
              email: "tester@local.test",
              display_name: "本地测试",
              avatar_url: null,
            },
          ],
      wantsObject,
    );
    return;
  }
  if (table === "workspace_members" && req.method === "GET") {
    const membership = {
      workspace_id: WORKSPACE_ID,
      user_id: USER_ID,
      role: "owner",
    };
    send(res, 200, wantsObject ? membership : [membership], wantsObject);
    return;
  }
  if (table === "workspace_settings") {
    send(
      res,
      200,
      wantsObject
        ? { default_model: "google:gemini-2.5-flash" }
        : [{ default_model: "google:gemini-2.5-flash" }],
      wantsObject,
    );
    return;
  }
  if (table === "provider_instances") {
    if (req.method === "GET") {
      send(res, 200, [...providerInstances.values()]);
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const row = JSON.parse(body || "{}");
        const full = {
          id: randomUUID(),
          workspace_id: WORKSPACE_ID,
          name: row.name ?? "",
          protocol: row.protocol ?? "openai-compatible",
          base_url: row.base_url ?? null,
          encrypted_api_key: "v1:mock",
          models: row.models ?? [],
          compat: row.compat ?? null,
          enabled: row.enabled ?? true,
          created_by: USER_ID,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        providerInstances.set(full.id, full);
        const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
        send(res, 201, single ? full : [full], single);
      });
      return;
    }
    if (req.method === "PATCH") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const id = (url.searchParams.get("id") ?? "").replace("eq.", "");
        const existing = providerInstances.get(id);
        if (!existing) {
          send(res, 406, { message: "not found", code: "PGRST116" });
          return;
        }
        const patch = JSON.parse(body || "{}");
        const merged = {
          ...existing,
          ...patch,
          updated_at: new Date().toISOString(),
        };
        providerInstances.set(id, merged);
        send(res, 200, merged, true);
      });
      return;
    }
    if (req.method === "DELETE") {
      const id = (url.searchParams.get("id") ?? "").replace("eq.", "");
      providerInstances.delete(id);
      send(res, 204, null);
      return;
    }
  }
  if (table === "usage_records" && req.method === "GET") {
    send(res, 200, []);
    return;
  }
  if (table === "workspace_skills" && req.method === "GET") {
    send(res, 200, []);
    return;
  }

  // 兜底：空数组成功
  send(res, 200, wantsObject ? null : []);
});

server.listen(54321, "127.0.0.1", () => {
  console.log("[mock-supabase] listening on http://127.0.0.1:54321");
});
