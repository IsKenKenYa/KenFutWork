import { createHash } from "node:crypto";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowProjectFiles } from "../features/flow/project-files.js";
import { registerFlowProjectFileRoutes } from "./flow-project-files.js";

const id = "22222222-2222-4222-8222-222222222222";
const version = "a".repeat(64);
const receipt = { assetId: id, relativePath: "样本.txt", version };
const headers = {
  authorization: "Bearer gateway-test-secret",
  "x-ff-project-binding": "project-binding",
};
const bytes = Buffer.from("abcdef");
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function fixture() {
  const files: FlowProjectFiles = {
    issue: vi.fn<FlowProjectFiles["issue"]>(async () => ({
      version: "v1",
      generation: 1,
      projectId: id,
      bindingToken: "project-binding",
    })),
    upload: vi.fn(async () => receipt),
    metadata: vi.fn(async () => ({
      ...receipt,
      mimeType: "text/plain",
      sizeBytes: bytes.length,
    })),
    read: vi.fn(async () => bytes),
    move: vi.fn(async () => receipt),
    remove: vi.fn(async () => {}),
    readLayout: vi.fn(async () => null),
    saveLayout: vi.fn(async (_token, _id, input) => ({
      content: input.content,
      version,
    })),
    dispose: vi.fn(),
  };
  const app = Fastify();
  apps.push(app);
  await app.register(multipart);
  await registerFlowProjectFileRoutes(app, {
    files,
    secret: "gateway-test-secret",
  });
  return { app, files };
}
describe("Flow 项目文件宿主回调", () => {
  it("multipart传递原始二进制与确切指纹，不把文件名当授权路径", async () => {
    const { app, files } = await fixture();
    const raw = Buffer.from([0, 255, 10, 200]);
    const writeFingerprint = createHash("sha256").update(raw).digest("hex");
    const boundary = "flow-file-test-boundary";
    const input = {
      assetId: id,
      relativePath: "成果.png",
      mimeType: "image/png",
      writeFingerprint,
    };
    const fields = Object.entries(input)
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join("");
    const payload = Buffer.concat([
      Buffer.from(
        `${fields}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored-name.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      raw,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: "POST",
      url: "/api/flow/host/project-files/upload",
      headers: {
        ...headers,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(receipt);
    expect(files.upload).toHaveBeenCalledWith("project-binding", input, raw);
  });
  it("网关密钥与独立项目绑定都必需，无授权不调用文件服务", async () => {
    const { app, files } = await fixture();
    for (const requestHeaders of [
      {},
      { authorization: headers.authorization },
      { ...headers, authorization: "Bearer wrong" },
    ]) {
      const response = await app.inject({
        url: `/api/flow/host/project-files/${id}?version=${version}`,
        headers: requestHeaders,
      });
      expect(response.statusCode).toBe(401);
    }
    expect(files.read).not.toHaveBeenCalled();
    expect(files.metadata).not.toHaveBeenCalled();
  });
  it("读取带精确版本，支持单段与末尾Range，拒绝越界和多段", async () => {
    const { app, files } = await fixture();
    const url = `/api/flow/host/project-files/${id}?version=${version}`;
    const whole = await app.inject({ url, headers });
    expect(whole.statusCode).toBe(200);
    expect(whole.body).toBe("abcdef");
    for (const [range, body, contentRange] of [
      ["bytes=1-3", "bcd", "bytes 1-3/6"],
      ["bytes=-2", "ef", "bytes 4-5/6"],
      ["bytes=4-100", "ef", "bytes 4-5/6"],
    ]) {
      const response = await app.inject({
        url,
        headers: { ...headers, range },
      });
      expect(response.statusCode).toBe(206);
      expect(response.body).toBe(body);
      expect(response.headers["content-range"]).toBe(contentRange);
    }
    for (const range of [
      "bytes=6-",
      "bytes=2-1",
      "bytes=-0",
      "bytes=0-1,3-4",
      "bytes=9007199254740993-",
    ]) {
      const response = await app.inject({
        url,
        headers: { ...headers, range },
      });
      expect(response.statusCode).toBe(416);
      expect(response.headers["content-range"]).toBe("bytes */6");
    }
    expect(files.read).toHaveBeenCalledWith("project-binding", id, version);
  });
  it("缺版本与无效布局创建参数明确失败，不写文件", async () => {
    const { app, files } = await fixture();
    expect(
      (await app.inject({ url: `/api/flow/host/project-files/${id}`, headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/flow/host/project-files/layouts/${id}`,
          headers,
          payload: { content: {}, expectedVersion: "wrong" },
        })
      ).statusCode,
    ).toBe(400);
    expect(files.read).not.toHaveBeenCalled();
    expect(files.saveLayout).not.toHaveBeenCalled();
  });
  it("缺失布局返回404，保存把客户端确切CAS传到文件Provider", async () => {
    const { app, files } = await fixture();
    const url = `/api/flow/host/project-files/layouts/${id}`;
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
    const content = { nodes: [], edges: [] };
    const response = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: { content, expectedVersion: null },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ content, version });
    expect(files.saveLayout).toHaveBeenCalledWith("project-binding", id, {
      content,
      expectedVersion: null,
    });
  });
  it("删除把确切版本传入条件删除端口，不直接调用blob删除", async () => {
    const { app, files } = await fixture();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/flow/host/project-files/${id}?version=${version}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(files.remove).toHaveBeenCalledWith("project-binding", id, version);
  });
});
