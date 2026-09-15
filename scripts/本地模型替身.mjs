/**
 * 本地「模型替身」：OpenAI 兼容的 /v1/chat/completions（含流式与工具调用），
 * 用来在**没有可用模型网关**时验证本仓库自己的接线（六档模式门、工具注册与执行、
 * 技能注入、沙箱落点、run 生命周期）。
 *
 * 它**不是产品组件**，也不冒充真实模型：回复是脚本化的（见 pickScenario），
 * 目的只是让 agent 回合能跑起来、让工具真的被调用、让结果可断言。
 * 真实验收仍须用真实供应商（BYOK / 平台池）。
 *
 * 用法：
 *   node scripts/本地模型替身.mjs           # 监听 127.0.0.1:9098
 *   # 供应商实例：协议 openai-compatible、baseUrl=http://127.0.0.1:9098/v1、任意非空 Key
 *
 * 脚本化行为（按最后一条用户消息与上下文判定）：
 *   - 消息里出现「批准」           → 直接收尾文本（用于计划模式的批准门）
 *   - 上下文里已有工具结果        → 用工具结果收尾（证明工具真的执行过）
 *   - 消息里提到 MCP / mcp__      → 发一次工具调用 mcp__py-helper__add(2024, 4888)
 *   - 消息里提到 技能 / SKILL      → 文本回执（技能注入由服务端完成，这里只回话）
 *   - 其它                        → 回显 PONG:<用户消息前 30 字符>
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_MODEL_PORT ?? 9098);
const MODEL_ID = process.env.MOCK_MODEL_ID ?? "mock-1";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  return (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
          .join(" ");
      }
    }
  }
  return "";
}

function toolResultsSoFar(messages) {
  return messages.filter((m) => m?.role === "tool");
}

/** 决定这一轮怎么回。返回 {kind:"text", text} 或 {kind:"tool", name, args}。 */
function pickScenario(messages) {
  const user = lastUserText(messages);
  const tools = toolResultsSoFar(messages);

  if (/写文件|创建文件|write_file/.test(user)) {
    return {
      kind: "tool",
      name: "write_file",
      args: {
        file_path: "kfw-mock-check.txt",
        content: "mock 模型替身写入：计划模式应被拦，自主模式应落盘。",
      },
    };
  }
  if (/批准/.test(user)) {
    return { kind: "text", text: "已收到批准，继续执行完成。" };
  }
  if (tools.length > 0) {
    const last = tools[tools.length - 1];
    const text =
      typeof last.content === "string"
        ? last.content
        : JSON.stringify(last.content ?? "");
    return { kind: "text", text: `工具已执行，结果为：${text.slice(0, 120)}` };
  }
  if (/MCP|mcp__/i.test(user)) {
    return {
      kind: "tool",
      name: "mcp__py-helper__add",
      args: { a: 2024, b: 4888 },
    };
  }
  if (/写文件|创建文件|创建文件|write_file/.test(user)) {
    return {
      kind: "tool",
      name: "write_file",
      args: {
        file_path: "kfw-mock-check.txt",
        content: "mock 模型替身写入：计划模式应被拦，自主模式应落盘。",
      },
    };
  }
  if (/web_search|搜索|联网/.test(user)) {
    return {
      kind: "tool",
      name: "web_search",
      args: { query: process.env.MOCK_SEARCH_QUERY ?? "python pytest 参数化 用法" },
    };
  }
  return { kind: "text", text: `PONG:${user.replace(/\s+/g, " ").slice(0, 30)}` };
}

function chunk(delta, finish = null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      return json(res, 200, {
        object: "list",
        data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "mock" }],
      });
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      return json(res, 404, { error: { message: "not found" } });
    }

    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const messages = body.messages ?? [];
    const scenario = pickScenario(messages);
    console.log(
      `[mock-model] ${scenario.kind === "tool" ? `tool_call ${scenario.name}` : "text"}`,
    );

    if (!body.stream) {
      const message =
        scenario.kind === "tool"
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_mock_1",
                  type: "function",
                  function: {
                    name: scenario.name,
                    arguments: JSON.stringify(scenario.args),
                  },
                },
              ],
            }
          : { role: "assistant", content: scenario.text };
      return json(res, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            message,
            finish_reason: scenario.kind === "tool" ? "tool_calls" : "stop",
          },
        ],
      });
    }

    const write = sse(res);
    write(chunk({ role: "assistant", content: "" }));
    if (scenario.kind === "tool") {
      write(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_mock_1",
              type: "function",
              function: {
                name: scenario.name,
                arguments: JSON.stringify(scenario.args),
              },
            },
          ],
        }),
      );
      write(chunk({}, "tool_calls"));
    } else {
      for (const piece of scenario.text.match(/.{1,8}/gs) ?? []) {
        write(chunk({ content: piece }));
      }
      write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return undefined;
  } catch (error) {
    console.log(`[mock-model] 请求处理异常：${error.message}`);
    if (!res.headersSent) json(res, 500, { error: { message: error.message } });
    else res.end();
    return undefined;
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-model] 本地模型替身监听 http://127.0.0.1:${PORT}/v1`);
});
