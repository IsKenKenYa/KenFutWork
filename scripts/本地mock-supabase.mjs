/**
 * 最小 Supabase REST 模拟（本地点击测试用，不入库不提交）。
 * 仅模拟 settings/providers/usage/skills 流所需的 PostgREST 形状。
 */

import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_ID = "ws-00000000-0000-0000-0000-000000000001";

const projects = new Map();
const canvases = new Map();
const sessionsByCanvas = new Map();
const chatSessions = new Map();

const WORKSPACE = {
  id: WORKSPACE_ID,
  name: "Personal",
  type: "personal",
  owner_user_id: USER_ID,
};

const profileRow = {
  id: USER_ID,
  email: "tester@local.test",
  display_name: "本地测试",
  avatar_url: null,
};

/** 生成服务端本地 HS256 可验签的会话（密钥与 .env.local 的 SUPABASE_JWT_SECRET 一致）。 */
const LOCAL_JWT_SECRET = "local-click-test-hmac-secret";

function signLocalJwt() {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: USER_ID,
    email: "tester@local.test",
    aud: "authenticated",
    role: "authenticated",
    iat: now,
    exp: now + 3600,
    user_metadata: { display_name: "本地测试" },
  })}`;
  const sig = createHmac("sha256", LOCAL_JWT_SECRET)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${sig}`;
}

function buildLocalSession() {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: signLocalJwt(),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: `local-refresh-${now}`,
    user: {
      id: USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: "tester@local.test",
      email_confirmed_at: new Date().toISOString(),
      confirmed_at: new Date().toISOString(),
      last_sign_in_at: new Date().toISOString(),
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { display_name: "本地测试" },
      identities: [],
      created_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

const providerInstances = new Map();

function send(res, status, payload, single) {
  const body =
    single && (payload === null || payload === undefined)
      ? JSON.stringify(payload ?? null)
      : JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  console.log(
    `[mock] ${req.method} ${req.url} accept=${req.headers.accept ?? ""}`,
  );
  const wantsObject = (req.headers.accept ?? "").includes("vnd.pgrst.object");

  // 浏览器跨域预检（页面源 :3000 → mock :54321）
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    });
    res.end();
    return;
  }

  // GoTrue 最小模拟：账密登录/注册直接发本地会话（本地点击测试用）
  if (path === "/auth/v1/token" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      send(res, 200, buildLocalSession());
    });
    return;
  }
  if (path === "/auth/v1/signup" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // 本地环境视同邮箱已确认，直接返回会话
      send(res, 200, { ...buildLocalSession(), ...{ email_confirm: true } });
    });
    return;
  }

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

  if (table === "projects") {
    if (req.method === "GET") {
      let list = [...projects.values()];
      const idParam = url.searchParams.get("id") ?? "";
      if (idParam) {
        list = list.filter((p) => p.id === idParam.replace("eq.", ""));
      }
      // .is("archived_at", null) → 未归档（mock 行无该字段视为未归档）
      if ((url.searchParams.get("archived_at") ?? "").startsWith("is.null")) {
        list = list.filter((p) => !p.archived_at);
      }
      if (wantsObject) {
        send(res, 200, list[0] ?? null, true);
        return;
      }
      send(res, 200, list);
      return;
    }
    if (req.method === "PATCH") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const id = (url.searchParams.get("id") ?? "").replace("eq.", "");
        const existing = projects.get(id);
        if (!existing) {
          send(res, 406, { message: "not found", code: "PGRST116" });
          return;
        }
        const merged = {
          ...existing,
          ...JSON.parse(body || "{}"),
          updated_at: new Date().toISOString(),
        };
        projects.set(id, merged);
        send(res, 200, merged, true);
      });
      return;
    }
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
  // chat_sessions：会话线程绑定（agent run 的 thread resolve 源）
  if (table === "chat_sessions") {
    if (req.method === "GET") {
      const idParam = (url.searchParams.get("id") ?? "").replace("eq.", "");
      let row = chatSessions.get(idParam) ?? null;
      if (!row && idParam) {
        // 演示 mock：读时建档，保证 agent run 的 thread resolve 成功
        row = {
          id: idParam,
          canvas_id: "",
          thread_id: `thread_${idParam.replace(/-/g, "").slice(0, 20)}`,
          title: "会话",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        chatSessions.set(idParam, row);
      }
      send(res, 200, wantsObject ? row : row ? [row] : [], wantsObject);
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
          thread_id: row.thread_id ?? `thread_${randomUUID()}`,
          title: row.title ?? "新会话",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        chatSessions.set(full.id, full);
        send(res, 201, full, true);
      });
      return;
    }
    if (req.method === "PATCH") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const id = (url.searchParams.get("id") ?? "").replace("eq.", "");
        const existing = chatSessions.get(id);
        if (!existing) {
          send(res, 406, { message: "not found", code: "PGRST116" });
          return;
        }
        const merged = {
          ...existing,
          ...JSON.parse(body || "{}"),
          updated_at: new Date().toISOString(),
        };
        chatSessions.set(id, merged);
        send(res, 200, merged, true);
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
  if (table === "profiles") {
    if (req.method === "GET") {
      send(res, 200, wantsObject ? profileRow : [profileRow], wantsObject);
      return;
    }
    if (req.method === "PATCH") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const patch = JSON.parse(body || "{}");
        profileRow.display_name = patch.display_name ?? profileRow.display_name;
        profileRow.avatar_url = patch.avatar_url ?? profileRow.avatar_url;
        send(res, 200, profileRow, true);
      });
      return;
    }
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
          // 存服务端真实加密密文（解密依赖 LOOMIC_CREDENTIAL_SECRET，不能写假值）
          encrypted_api_key: row.encrypted_api_key ?? "v1:mock",
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
