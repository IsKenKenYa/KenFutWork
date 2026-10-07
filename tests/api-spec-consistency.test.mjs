import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, "..");

// OpenAPI 3.1 spec 的路由集合必须与服务端源码的路由注册**一一对应**：
// 路由表/生成器漏抄或源码新增路由未重新生成，都会在这里红灯。
// 这是「spec ↔ 源码」的双向对账，中央路由表本身由 typecheck 与生成器保证与 spec 一致。
//
// 域（tag）封闭清单在这里独立维护，作为「分组清晰、零重复」的唯一裁判：
// 生成器里 tags 从路由表聚合，路由表 tag 打错域时，这里对不上即红。
const CLOSED_TAGS = [
  "blobs",
  "brand-kits",
  "canvases",
  "chat",
  "code",
  "execution-modes",
  "flow",
  "fonts",
  "generate",
  "health",
  "image-proxy",
  "jobs",
  "instance",
  "local-access",
  "mcp",
  "models",
  "permissions",
  "plugins",
  "projects",
  "provider-instances",
  "runs",
  "settings",
  "skills",
  "system",
  "uploads",
  "usage",
  "voice",
];

const SPEC_PATH = "docs/api/openapi.json";

// 源码里注册 HTTP 路由的全部位置：http/ 目录（含 infra 聚合的 health/fonts/image-proxy）
// 加 app.ts。WS 路由字面量在 src/ws/handler.ts（不在扫描范围，WS 不入 HTTP spec）；
// static-web 的 SPA catch-all 经 setNotFoundHandler 注册（不会命中正则，也不属 API）。
function enumerateSourceRoutes() {
  const httpDir = path.join(rootDir, "apps/server/src/http");
  const files = [
    ...readdirSync(httpDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(httpDir, name)),
    path.join(rootDir, "apps/server/src/app.ts"),
    path.join(rootDir, "apps/server/src/features/local-access/routes.ts"),
  ];
  const routePattern =
    /app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*"(\/api\/[^"]+)"/g;
  const routes = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(routePattern)) {
      routes.push(`${match[1].toUpperCase()} ${normalizePath(match[2])}`);
    }
  }
  return routes;
}

// Fastify 路径参数 :name → OpenAPI {name}；通配符 * 原样保留。
function normalizePath(fastifyPath) {
  return fastifyPath.replace(/:(\w+)/g, "{$1}");
}

function specRouteIds(spec) {
  const routes = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if (pathItem[method]) routes.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes;
}

test("OpenAPI spec 与服务端源码路由注册一一对应", async () => {
  const spec = JSON.parse(
    await readFile(path.join(rootDir, SPEC_PATH), "utf8"),
  );
  const source = enumerateSourceRoutes();
  assert.ok(
    source.length > 100,
    `源码应枚举出 100+ 条路由，实际 ${source.length} 条（正则可能失配）`,
  );
  assert.deepEqual(
    [...specRouteIds(spec)].sort(),
    [...source].sort(),
    "spec 路由集合与源码不一致：改了路由必须重新生成 spec（pnpm api:spec），漏抄/多抄路由表同样在此红灯",
  );
});

test("spec 元数据完整：中文注释非空、operationId 唯一、tag 在封闭清单内", async () => {
  const spec = JSON.parse(
    await readFile(path.join(rootDir, SPEC_PATH), "utf8"),
  );

  assert.match(spec.openapi, /^3\.1\./, "必须是 OpenAPI 3.1");
  assert.equal(
    spec.info.title,
    "KenFutWork Community API",
    "info.title 固定：变更会使 Apifox 重导入时新建重复模块",
  );
  assert.match(spec.info.description, /\S/, "info.description 必须有中文说明");

  const declaredTags = new Set(spec.tags.map((tag) => tag.name));
  assert.deepEqual(
    [...declaredTags].sort(),
    [...CLOSED_TAGS].sort(),
    "spec tags 必须与封闭域清单一致：新增域两处同改",
  );
  for (const tag of spec.tags) {
    assert.match(tag.description, /\S/, `tag ${tag.name} 缺中文描述`);
  }

  const seenOperationIds = new Map();
  const problems = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = pathItem[method];
      if (!operation) continue;
      const id = `${method.toUpperCase()} ${path}`;
      if (!/\S/.test(operation.summary ?? ""))
        problems.push(`${id}: summary 为空`);
      if (!/\S/.test(operation.description ?? ""))
        problems.push(`${id}: description 为空`);
      if (seenOperationIds.has(operation.operationId)) {
        problems.push(
          `${id}: operationId ${operation.operationId} 与 ${seenOperationIds.get(operation.operationId)} 重复`,
        );
      }
      seenOperationIds.set(operation.operationId, id);
      const tags = operation.tags ?? [];
      if (tags.length !== 1 || !CLOSED_TAGS.includes(tags[0])) {
        problems.push(
          `${id}: tags ${JSON.stringify(tags)} 不在封闭清单内或不唯一`,
        );
      }
    }
  }
  assert.deepEqual(
    problems,
    [],
    `spec 操作注释/编号/分组问题：\n  ${problems.join("\n  ")}`,
  );
});

test("路由表引用的契约 schema 均从 @kenfutwork/shared 导入", async () => {
  const registrySource = await readFile(
    path.join(rootDir, "apps/server/src/openapi/registry.ts"),
    "utf8",
  );
  const importMatch = registrySource.match(
    /import \{([^}]*)\} from "@kenfutwork\/shared"/,
  );
  assert.ok(importMatch, "registry.ts 应从 @kenfutwork/shared 导入契约 schema");
  const imported = importMatch[1]
    .split(",")
    .map((name) => name.trim().split(/\s+as\s+/)[0])
    .filter(Boolean);

  // shared 的 barrel 是 export * 风格，逐名核对须扫源文件里的具名导出声明。
  const sharedDir = path.join(rootDir, "packages/shared/src");
  const exportedNames = new Set();
  for (const name of readdirSync(sharedDir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(path.join(sharedDir, name), "utf8");
    for (const match of source.matchAll(
      /export\s+(?:const|function|class|async function)\s+(\w+)/g,
    )) {
      exportedNames.add(match[1]);
    }
    for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const clause of match[1].split(",")) {
        const exported = clause
          .trim()
          .split(/\s+as\s+/)
          .pop();
        if (exported) exportedNames.add(exported);
      }
    }
  }
  const missing = imported.filter((name) => !exportedNames.has(name));
  assert.deepEqual(
    missing,
    [],
    `registry.ts 引用了 shared 未导出的契约：${missing.join(", ")}（先在 packages/shared 补导出）`,
  );
});
