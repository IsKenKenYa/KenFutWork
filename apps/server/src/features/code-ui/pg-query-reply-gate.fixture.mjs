import net from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function cstring(bytes, at = 0) {
  const end = bytes.indexOf(0, at);
  if (end < 0) throw new Error("PG 读取门遇到不完整字符串。");
  return { text: bytes.toString("utf8", at, end), next: end + 1 };
}

function checkpointSelect(sql) {
  return (
    /^\s*select\b/iu.test(sql) &&
    /\b(?:from|join)\s+"?langgraph"?\s*\.\s*"?checkpoints"?(?=\s|$|[;,])/iu.test(
      sql,
    )
  );
}

function readBind(bytes, statements) {
  const portal = cstring(bytes);
  const statement = cstring(bytes, portal.next);
  const sql = statements.get(statement.text) ?? "";
  // 不解析其它业务 SQL 的值，避免复制凭证或无关大对象。
  if (!checkpointSelect(sql)) return { portal: portal.text, sql, values: [] };
  let at = statement.next;
  const formatCount = bytes.readUInt16BE(at);
  at += 2;
  const formats = [];
  for (let index = 0; index < formatCount; index += 1, at += 2)
    formats.push(bytes.readUInt16BE(at));
  const count = bytes.readUInt16BE(at);
  at += 2;
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const length = bytes.readInt32BE(at);
    at += 4;
    if (length === -1) {
      values.push(null);
      continue;
    }
    const format = formats.length === 1 ? formats[0] : (formats[index] ?? 0);
    values.push(
      format === 0
        ? bytes.toString("utf8", at, at + length)
        : {
            format: "binary",
            base64: bytes.subarray(at, at + length).toString("base64"),
          },
    );
    at += length;
  }
  return { portal: portal.text, sql, values };
}

function frameReader(onFrame, startup = false) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (startup) {
      if (pending.length < 8) return;
      const length = pending.readUInt32BE(0);
      if (pending.length < length) return;
      const protocol = pending.readUInt32BE(4);
      if (protocol === 80877103 || protocol === 80877104)
        throw new Error("PG 读取门仅支持无 TLS/GSS 的独占回环连接。");
      pending = pending.subarray(length);
      startup = false;
    }
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1);
      if (length < 4) throw new Error("PG 读取门遇到无效帧长度。");
      if (pending.length < length + 1) return;
      const frame = pending.subarray(0, length + 1);
      pending = pending.subarray(length + 1);
      onFrame(String.fromCharCode(frame[0]), frame.subarray(5), frame);
    }
  };
}

function frontendReader(onQuery) {
  const statements = new Map();
  const portals = new Map();
  return frameReader((tag, bytes) => {
    if (tag === "Q") onQuery(cstring(bytes).text, []);
    if (tag === "P") {
      const name = cstring(bytes);
      statements.set(name.text, cstring(bytes, name.next).text);
    }
    if (tag === "B") {
      const bound = readBind(bytes, statements);
      portals.set(bound.portal, bound);
    }
    if (tag === "E") {
      const name = cstring(bytes).text;
      const bound = portals.get(name);
      if (bound) onQuery(bound.sql, bound.values);
      portals.delete(name);
    }
  }, true);
}

function attachConnection(frontend, destination, control, sockets) {
  const backend = net.createConnection({
    host: destination.hostname === "[::1]" ? "::1" : destination.hostname,
    port: Number(destination.port || 5432),
  });
  sockets.add(frontend);
  sockets.add(backend);
  let selected;
  const forward = (frame) => {
    if (frontend.destroyed || frontend.writableEnded) return;
    if (!frontend.write(frame)) {
      backend.pause();
      frontend.once("drain", () => backend.resume());
    }
  };
  const fail = (error) => {
    control.fail(error);
    frontend.destroy();
    backend.destroy();
  };
  const readFrontend = frontendReader((sql, values) => {
    selected ??= control.select(sql, values, forward);
  });
  const readBackend = frameReader((tag, bytes, frame) => {
    if (selected && !selected.released) selected.frames.push(frame);
    else forward(frame);
    if (!selected || selected.serverReadyForQuery) return;
    if (tag === "C") selected.commandTag = cstring(bytes).text;
    if (tag === "E") selected.queryFailed = true;
    if (tag === "Z") {
      selected.serverReadyForQuery = true;
      selected.transactionStatus = String.fromCharCode(bytes[0]);
      control.confirm(selected);
    }
  });
  frontend.on("data", (chunk) => {
    try {
      readFrontend(chunk);
      if (!backend.write(chunk)) {
        frontend.pause();
        backend.once("drain", () => frontend.resume());
      }
    } catch (error) {
      fail(error);
    }
  });
  backend.on("data", (chunk) => {
    try {
      readBackend(chunk);
    } catch (error) {
      fail(error);
    }
  });
  frontend.on("error", () => backend.destroy());
  backend.on("error", () => frontend.destroy());
  frontend.on("end", () => backend.end());
  backend.on("end", () => frontend.end());
  frontend.on("close", () => {
    sockets.delete(frontend);
    backend.destroy();
    if (selected) control.disconnected(selected);
  });
  backend.on("close", () => {
    sockets.delete(backend);
    frontend.destroy();
  });
}

/** 真实 SELECT 已到 ReadyForQuery 才确认门控；不执行 SQL，不改任何响应帧。 */
export async function createPgQueryReplyGate(directConnectionString) {
  const destination = new URL(directConnectionString);
  if (!LOOPBACK.has(destination.hostname))
    throw new Error("PG 读取门只允许独占临时回环数据库。");
  const sslMode = destination.searchParams.get("sslmode");
  if ((sslMode && sslMode !== "disable") || destination.searchParams.has("ssl"))
    throw new Error("PG 读取门只支持无 TLS 的回环数据库。");
  const sockets = new Set();
  let armed = false;
  let armedOnce = false;
  let closed = false;
  let settled = false;
  let selected;
  let observerError;
  let resolveEntered;
  let rejectEntered;
  const entered = new Promise((resolve, reject) => {
    resolveEntered = resolve;
    rejectEntered = reject;
  });
  // finally 的关闭可发生在调用方尚未 await entered 时。
  void entered.catch(() => {});
  const evidence = () => ({
    matched: Boolean(selected),
    serverReadyForQuery: selected?.serverReadyForQuery ?? false,
    replyHeld: Boolean(
      selected && !selected.released && selected.frames.length,
    ),
    readCompleted: selected?.commandTag?.startsWith("SELECT ") ?? false,
    queryFailed: selected?.queryFailed ?? false,
    released: selected?.released ?? false,
    connectionClosed: selected?.connectionClosed ?? false,
    sql: selected?.sql,
    values: structuredClone(selected?.values ?? []),
    commandTag: selected?.commandTag,
    transactionStatus: selected?.transactionStatus,
    observerError,
  });
  const fail = (error) => {
    observerError ??=
      error instanceof Error ? error.message : "PG 读取门观察失败。";
    if (!settled) {
      settled = true;
      rejectEntered(new Error(observerError));
    }
  };
  const control = {
    fail,
    select(sql, values, forward) {
      if (!armed || selected || !checkpointSelect(sql)) return;
      armed = false;
      selected = {
        sql,
        values,
        forward,
        frames: [],
        released: false,
        serverReadyForQuery: false,
        queryFailed: false,
        connectionClosed: false,
      };
      return selected;
    },
    confirm() {
      if (!settled) {
        settled = true;
        resolveEntered(evidence());
      }
    },
    disconnected(gate) {
      gate.connectionClosed = true;
      if (!settled)
        fail(new Error("原生读取连接在 ReadyForQuery 前断开，未确认门控。"));
    },
  };
  const server = net.createServer((socket) =>
    attachConnection(socket, destination, control, sockets),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("PG 读取门没有回环端口。");
  const proxied = new URL(destination);
  proxied.hostname = "127.0.0.1";
  proxied.port = String(address.port);
  proxied.searchParams.set("sslmode", "disable");
  const release = () => {
    armed = false;
    if (!selected || selected.released) return;
    selected.released = true;
    for (const frame of selected.frames) selected.forward(frame);
    selected.frames = [];
  };
  return {
    connectionString: proxied.toString(),
    entered,
    evidence,
    release,
    arm() {
      if (closed || armedOnce || armed || selected || settled)
        throw new Error(
          "PG 读取门仅能为下一条原生 checkpoint SELECT 启用一次。",
        );
      armedOnce = true;
      armed = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      release();
      if (!settled) fail(new Error("PG 读取门已关闭，未确认实际查询门控。"));
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
