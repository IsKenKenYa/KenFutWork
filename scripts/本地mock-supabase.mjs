/**
 * 最小 Supabase REST 模拟（本地点击测试用，不入库不提交）。
 * 仅模拟 settings/providers/usage/skills 流所需的 PostgREST 形状。
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_ID = "ws-00000000-0000-0000-0000-000000000001";

const WORKSPACE = {
  id: WORKSPACE_ID,
  name: "Personal",
  type: "personal",
  owner_user_id: USER_ID,
};

const providerInstances = new Map();

function send(res, status, payload, single) {
  const body = single && (payload === null || payload === undefined)
    ? JSON.stringify(payload ?? null)
    : JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const wantsObject = (req.headers.accept ?? "").includes("vnd.pgrst.object");

  if (!path.startsWith("/rest/v1/")) {
    send(res, 200, {});
    return;
  }

  // RPC 一律空对象成功
  if (path.startsWith("/rest/v1/rpc/")) {
    send(res, 200, {});
    return;
  }

  const table = path.slice("/rest/v1/".length).split("?")[0];

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
        const single = (req.headers.accept ?? "").includes(
          "vnd.pgrst.object",
        );
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
        const merged = { ...existing, ...patch, updated_at: new Date().toISOString() };
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
