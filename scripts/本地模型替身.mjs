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

/**
 * 工具调用 id 必须**逐次唯一**：LangGraph 的 messages reducer 以 id 关联
 * tool_call 与 ToolMessage，重复 id 会让第二次调用被静默丢弃（实测：整轮 run
 * 在第一个工具后直接结束，且不报错）。
 */
let callSeq = 0;
const nextCallId = () => {
  callSeq += 1;
  return `call_mock_${callSeq}`;
};

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
          .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
          .join(" ");
      }
    }
  }
  return "";
}

function toolResultsSoFar(messages) {
  return messages.filter((m) => m?.role === "tool");
}

/** 工具结果的纯文本（判「写成功」用）。 */
function toolResultText(entry) {
  return typeof entry?.content === "string"
    ? entry.content
    : JSON.stringify(entry?.content ?? "");
}

/** 「python 项目」脚本：多步文件序列 + 最后调一次 MCP 校验。 */
const PY_PROJECT_FILES = [
  {
    file_path: "kfw-py-demo/pyproject.toml",
    content:
      '[project]\nname = "kfw-py-demo"\nversion = "0.1.0"\nrequires-python = ">=3.11"\n',
  },
  {
    file_path: "kfw-py-demo/src/kfw_py_demo/__init__.py",
    content: "__all__ = []\n",
  },
  {
    file_path: "kfw-py-demo/tests/test_smoke.py",
    content:
      "from kfw_py_demo import __all__\n\n\ndef test_smoke():\n    assert __all__ == []\n",
  },
  {
    file_path: "kfw-py-demo/README.md",
    content:
      "# kfw-py-demo\n\n由「计划 / 自主」模式实测创建（本地模型替身驱动）。\n",
  },
  {
    file_path: "kfw-py-demo/.gitignore",
    content: "__pycache__/\n.pytest_cache/\n.venv/\n",
  },
];

/**
 * 「python 项目」脚本的**步进口径**：按**本轮 run** 已有的工具结果条数推进，而不是
 * 按「写成功的条数」。
 *
 * 为什么按本轮：会话带检查点，历史消息会被回放——跨轮计数会让「批准」后的新一轮
 * 以为文件已经写过、直接跳到收尾。为什么按结果条数而不是成功数：被门拦下的调用也会
 * 产生一条工具结果（拒绝折叠成 ToolMessage），按成功数推进会让被拦的步永远重试同一个
 * 文件、直到图的步数上限。
 */
function currentRunToolResults(messages) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  return messages.slice(lastUser + 1).filter((m) => m?.role === "tool");
}

/** 本轮已成功写入的文件数（被门拦下的结果不含 Successfully wrote）。 */
function approvedWriteCount(results) {
  return results.filter((m) => /Successfully wrote/.test(toolResultText(m)))
    .length;
}

function pythonProjectStep(messages) {
  const results = currentRunToolResults(messages);
  if (results.length < PY_PROJECT_FILES.length) {
    return {
      kind: "tool",
      name: "write_file",
      args: PY_PROJECT_FILES[results.length],
    };
  }
  // MCP **只试一次**：被拒（计划模式把外部调用当副作用拦掉）就收尾说明，不再重试。
  // 否则模型会一直重调被拒工具，整轮 run 永远不结束（实测 180s 内 2971 次重试，
  // 既不失败也不结束——图的步数上限对这种情况形同虚设）。
  const mcpAttempted = results.length > PY_PROJECT_FILES.length;
  if (!mcpAttempted) {
    return {
      kind: "tool",
      name: "mcp__py-helper__add",
      args: { a: 2024, b: 4888 },
    };
  }
  const mcpOk = results.some((m) => /6912/.test(toolResultText(m)));
  const skillSeen = JSON.stringify(messages).includes("python-project-init");
  const skillNote = skillSeen
    ? "（已读到技能 python-project-init 的内容）"
    : "（未读到技能内容）";
  return {
    kind: "text",
    text: `python 项目脚手架：本轮尝试写入 ${PY_PROJECT_FILES.length} 个文件，其中成功 ${approvedWriteCount(results)} 个；MCP 校验 ${mcpOk ? "成功（2024+4888=6912）" : "被拒/失败见工具结果"}。${skillNote}`,
  };
}

/** 决定这一轮怎么回。返回 {kind:"text", text} 或 {kind:"tool", name, args}。 */
function pickScenario(messages) {
  const user = lastUserText(messages);
  const tools = toolResultsSoFar(messages);
  const wholeConversation = JSON.stringify(messages);
  const inPythonProject =
    /python[\s-]?项目|脚手架|kfw-py-demo/i.test(user) ||
    (/批准/.test(user) && /kfw-py-demo/.test(wholeConversation));

  // 「建 python 项目」整段序列（含批准后继续）：优先于其它规则
  if (inPythonProject) {
    return pythonProjectStep(messages);
  }

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
  if (/web_search|搜索|联网/.test(user)) {
    // 已有搜索结果就不再重调（否则会一直重调同一工具）
    const results = currentRunToolResults(messages);
    const searched = results.find((m) =>
      /https?:\/\/|标题/.test(toolResultText(m)),
    );
    if (searched) {
      return {
        kind: "text",
        text: `搜索已完成，结果摘要：${toolResultText(searched).slice(0, 300)}`,
      };
    }
    return {
      kind: "tool",
      name: "web_search",
      args: {
        query: process.env.MOCK_SEARCH_QUERY ?? "python pytest 参数化 用法",
      },
    };
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
  return {
    kind: "text",
    text: `PONG:${user.replace(/\s+/g, " ").slice(0, 30)}`,
  };
}

/**
 * 响应 id 必须**逐次唯一**：ChatOpenAI 把响应 id 当作 AIMessage.id，而 LangGraph 的
 * add_messages 按 id 去重——同一个 id 的第二次响应会**替换**掉上一条 AIMessage，
 * 工具结果被挤到消息列表末尾，路由判定「没有工具调用」→ 图在第一个工具后静默结束
 * （实测：整轮 run 正常 completed，但后续步骤一个都没发生，且不报任何错）。
 */
let responseSeq = 0;
const nextResponseId = () => {
  responseSeq += 1;
  return `chatcmpl-mock-${responseSeq}`;
};

function chunk(id, delta, finish = null) {
  return {
    id,
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
    /**
     * 语音合成替身（`/v1/audio/speech`）：回一段**真能播**的 16k 单声道 WAV。
     *
     * 为什么替身也要给真音频：语音播报的前端链路（取 blob → decodeAudioData → 播放 →
     * 打断）只有拿到可解码的字节才走得通；回 JSON 或空体测不出接线对不对。
     * 内容是 0.6 秒 440Hz 提示音、不是语音——本脚本不冒充模型，只验证本仓接线。
     */
    if (req.method === "POST" && req.url?.startsWith("/v1/audio/speech")) {
      let speechRaw = "";
      for await (const c of req) speechRaw += c;
      const speechBody = JSON.parse(speechRaw || "{}");
      const rate = 16_000;
      // 时长可调：验收「打断」时需要一段够长的音频（默认 0.6 秒够听清即可）
      const seconds = Number(process.env.MOCK_SPEECH_SECONDS ?? 0.6);
      const frames = Math.max(1, Math.floor(seconds * rate));
      const dataBytes = frames * 2;
      const wav = Buffer.alloc(44 + dataBytes);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(36 + dataBytes, 4);
      wav.write("WAVE", 8);
      wav.write("fmt ", 12);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(rate, 24);
      wav.writeUInt32LE(rate * 2, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(dataBytes, 40);
      for (let i = 0; i < frames; i += 1) {
        // 440Hz 正弦 + 淡入淡出（避免爆音，也让「有没有真播」听得出来）
        const envelope = Math.min(
          1,
          i / (rate * 0.05),
          (frames - i) / (rate * 0.05),
        );
        const sample = Math.sin(2 * Math.PI * 440 * (i / rate)) * 0.3 * envelope;
        wav.writeInt16LE(Math.round(sample * 32_767), 44 + i * 2);
      }
      console.log(
        `[mock-model] speech「${String(speechBody.input ?? "").slice(0, 24)}」（${wav.length} 字节 WAV）`,
      );
      res.writeHead(200, {
        "content-type": "audio/wav",
        "content-length": String(wav.length),
      });
      res.end(wav);
      return;
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
      `[mock-model] ${scenario.kind === "tool" ? `tool_call ${scenario.name} ${JSON.stringify(scenario.args).slice(0, 120)}` : "text"}`,
    );

    const responseId = nextResponseId();
    if (!body.stream) {
      const message =
        scenario.kind === "tool"
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: nextCallId(),
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
        id: responseId,
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
    write(chunk(responseId, { role: "assistant", content: "" }));
    if (scenario.kind === "tool") {
      write(
        chunk(responseId, {
          tool_calls: [
            {
              index: 0,
              id: nextCallId(),
              type: "function",
              function: {
                name: scenario.name,
                arguments: JSON.stringify(scenario.args),
              },
            },
          ],
        }),
      );
      write(chunk(responseId, {}, "tool_calls"));
    } else {
      for (const piece of scenario.text.match(/.{1,8}/gs) ?? []) {
        write(chunk(responseId, { content: piece }));
      }
      write(chunk(responseId, {}, "stop"));
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
