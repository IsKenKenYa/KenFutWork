import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import {
  setSurfaceApiBase,
  surfaceRequest,
} from "../src/components/workbench/zcode/host/surfaceApi";
import { fetchBrandKits } from "../src/lib/brand-kit-api";
import {
  LOCAL_ACCESS_LOST_EVENT,
  loadLocalInstance,
} from "../src/lib/local-access";
import {
  ApiAccessError,
  ApiApplicationError,
  fetchProjects,
  generateImageDirect,
  generateVideoDirect,
} from "../src/lib/server-api";
import { fetchTerminalShells } from "../src/lib/terminal-api";

function json(response: ServerResponse, status: number, body: unknown) {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}

const requestId = "aaaaaaaa-1111-4111-8111-111111111111";
const jobId = "bbbbbbbb-1111-4111-8111-111111111111";
let apiBase: string;
const accepted = {
  request_id: requestId,
  jobs: [{ job_id: jobId, status: "queued" }],
};

const server = createServer((request, response) => {
  if (request.url === "/api/projects?kind=design") {
    return json(response, 400, {
      statusCode: 400,
      error: "Bad Request",
      code: "FST_ERR_CTP_EMPTY_JSON_BODY",
      message: "Body cannot be empty when content-type is set",
    });
  }
  if (request.url === "/api/projects?kind=code") {
    return response.writeHead(401).end();
  }
  if (request.url === "/api/brand-kits") {
    return response
      .writeHead(503, { "content-type": "text/html" })
      .end("<h1>upstream connection refused</h1>");
  }
  if (request.url === "/api/voice/transcribe") {
    request.resume();
    return response
      .writeHead(503, { "content-type": "text/html" })
      .end("<h1>upstream connection refused</h1>");
  }
  if (request.url === "/api/voice/speak") {
    request.resume();
    return json(response, 422, {
      error: {
        code: "voice_model_required",
        message: "请先在语音设置选择播报模型。",
      },
    });
  }
  if (request.url === "/api/code/shells") {
    return json(response, 409, {
      error: { code: "shell_selection_changed", message: "请重新选择终端。" },
      extra: "兼容新增字段",
    });
  }
  if (request.url === "/api/instance") {
    return json(response, 500, { error: { code: 123, message: " " } });
  }
  if (request.url === "/api/agent/generate-image") {
    request.resume();
    return json(response, 202, accepted);
  }
  if (request.url === "/api/agent/generate-video") {
    request.resume();
    return response.writeHead(504).end();
  }
  response.writeHead(404).end();
});

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP 回归服务未启动");
  apiBase = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", apiBase);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  if (server.listening) {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

it("旧 HTTP 错误格式按状态显示中文建议，不转发框架原文", async () => {
  await expect(fetchProjects(null)).rejects.toMatchObject({
    code: "application_error",
    message: "请求格式有误，请检查填写内容。",
  });
});

it("空的 401 提示重新连接并保留接入失效通知", async () => {
  const lost = once(window, LOCAL_ACCESS_LOST_EVENT);
  const result = fetchProjects(null, "code");
  await expect(result).rejects.toBeInstanceOf(ApiAccessError);
  await expect(result).rejects.toThrow("本机连接已失效，请从桌面重新打开。");
  await lost;
});

it("非 JSON 的 503 在品牌设置中提示检查本机服务", async () => {
  await expect(fetchBrandKits(null)).rejects.toMatchObject({
    code: "application_error",
    message: "本机服务暂不可用，请确认 KenFutWork 正在运行。",
  });
});

it("保留结构正确的业务码和文案，客户端可接收以后新增的错误码", async () => {
  await expect(fetchTerminalShells(null)).rejects.toMatchObject({
    code: "shell_selection_changed",
    message: "请重新选择终端。",
  });
});

it("Code 请求和壳内内容保留相同的状态、业务码和处理提示", async () => {
  const client = new CodeHttpChannelClient({ apiBase });
  setSurfaceApiBase(apiBase);
  try {
    const error = {
      status: 409,
      code: "shell_selection_changed",
      message: "请重新选择终端。",
    };
    await expect(client.request("/api/code/shells")).rejects.toMatchObject(
      error,
    );
    await expect(surfaceRequest("/api/code/shells")).rejects.toMatchObject(
      error,
    );
    await expect(surfaceRequest("/api/brand-kits")).rejects.toMatchObject({
      status: 503,
      message: "本机服务暂不可用，请确认 KenFutWork 正在运行。",
    });
  } finally {
    setSurfaceApiBase("");
    client.dispose();
  }
});

it("语音转写的网关页面转成处理提示，播报保留服务端给出的原因", async () => {
  const client = new CodeHttpChannelClient({ apiBase });
  try {
    await expect(
      client.transcribeVoice(new Uint8Array([1])),
    ).rejects.toMatchObject({
      status: 503,
      message: "本机服务暂不可用，请确认 KenFutWork 正在运行。",
    });
    await expect(
      client.speakVoice({
        text: "你好",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: "voice_model_required",
      message: "请先在语音设置选择播报模型。",
    });
  } finally {
    client.dispose();
  }
});

it("无有效文案的错误不会显示空白，保留本机连接的 HTTP 状态", async () => {
  await expect(loadLocalInstance()).rejects.toMatchObject({
    status: 500,
    message: "本机服务未能完成请求，请检查工作台状态。",
  });
});

it("生成回执保留原任务编号，网关超时仍由原流程核对提交结果", async () => {
  await expect(
    generateImageDirect(null, "图片", { requestId }),
  ).resolves.toEqual(accepted);
  const result = generateVideoDirect(null, "视频", { requestId });
  await expect(result).rejects.toThrow("提交结果待确认");
  await expect(result).rejects.not.toBeInstanceOf(ApiApplicationError);
});
