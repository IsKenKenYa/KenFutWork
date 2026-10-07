import net from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const freshTransaction = () => ({
  chatRoot: false,
  codeRoot: false,
  forkAck: false,
});

function cstring(bytes, at = 0) {
  const end = bytes.indexOf(0, at);
  if (end < 0) throw new Error("PG 观察器遇到不完整字符串。");
  return { text: bytes.toString("utf8", at, end), next: end + 1 };
}

function bind(bytes) {
  const portal = cstring(bytes);
  const statement = cstring(bytes, portal.next);
  let at = statement.next;
  const formatCount = bytes.readUInt16BE(at);
  at += 2;
  const formats = [];
  for (let index = 0; index < formatCount; index += 1, at += 2)
    formats.push(bytes.readUInt16BE(at));
  const count = bytes.readUInt16BE(at);
  at += 2;
  const parameters = [];
  for (let index = 0; index < count; index += 1) {
    const length = bytes.readInt32BE(at);
    at += 4;
    if (length === -1) {
      parameters.push(null);
      continue;
    }
    const format = formats.length === 1 ? formats[0] : (formats[index] ?? 0);
    parameters.push(
      format === 0 ? bytes.toString("utf8", at, at + length) : null,
    );
    at += length;
  }
  return { portal: portal.text, statement: statement.text, parameters };
}

/** 仅供独占临时 PG 的透明故障候选；不执行 SQL、不创建任何业务回执。 */
export async function createCommitResponseLossProxy(upstreamConnectionString) {
  const destination = new URL(upstreamConnectionString);
  if (!LOOPBACK.has(destination.hostname))
    throw new Error("故障候选只允许回环临时 PG。");
  const sslMode = destination.searchParams.get("sslmode");
  if ((sslMode && sslMode !== "disable") || destination.searchParams.has("ssl"))
    throw new Error("该透明候选只支持显式无 TLS 的回环 PG。");
  let commandId;
  let blackoutAfterCommit = false;
  let rollbackBeforeCommit = false;
  let unavailable = false;
  let closed = false;
  let injected;
  let observerError;
  let resolveInjected;
  const injection = new Promise((resolve) => {
    resolveInjected = resolve;
  });
  const sockets = new Set();
  const server = net.createServer((frontend) => {
    const backend = net.createConnection({
      host: destination.hostname === "[::1]" ? "::1" : destination.hostname,
      port: Number(destination.port || 5432),
    });
    sockets.add(frontend);
    sockets.add(backend);
    let startup = true;
    let frontBuffer = Buffer.alloc(0);
    let backBuffer = Buffer.alloc(0);
    let transaction = freshTransaction();
    let withholdingCommit = false;
    let heldFrames = [];
    const statements = new Map();
    const portals = new Map();
    const failObserver = (error) => {
      observerError ??=
        error instanceof Error ? error.message : "PG 观察失败。";
      frontend.destroy();
      backend.destroy();
    };
    const observeSql = (sql, parameters = []) => {
      const text = sql.toLowerCase().replace(/\s+/gu, " ").trim();
      if (
        unavailable &&
        /public\.code_ui_commands/u.test(text) &&
        /for update/u.test(text)
      ) {
        injected.readbackSuppressed = true;
        frontend.destroy();
        backend.destroy();
        return;
      }
      if (/^begin(?:\s|;|$)/u.test(text)) transaction = freshTransaction();
      if (/\binsert into public\.chat_sessions\b/u.test(text)) {
        transaction.chatRoot = true;
        transaction.targetTaskId = parameters[0];
        transaction.targetThreadId = parameters[3];
      }
      if (/\binsert into public\.code_ui_sessions\b/u.test(text))
        transaction.codeRoot = true;
      if (
        commandId &&
        /^update public\.code_ui_commands set ack\s*=/u.test(text) &&
        parameters.some((value) => value === commandId)
      ) {
        transaction.forkAck = parameters.some((value) => {
          if (typeof value !== "string" || !value.startsWith("{")) return false;
          try {
            const ack = JSON.parse(value);
            return (
              ack.commandId === commandId &&
              ack.status === "accepted" &&
              ack.result?.type === "forkAssistant" &&
              typeof ack.result.sessionId === "string"
            );
          } catch {
            return false;
          }
        });
      }
      if (
        /^commit(?:\s|;|$)/u.test(text) &&
        commandId &&
        !injected &&
        transaction.chatRoot &&
        transaction.codeRoot &&
        transaction.forkAck
      ) {
        if (rollbackBeforeCommit) {
          injected = {
            commitConfirmed: false,
            replySuppressed: true,
            commandId,
            targetTaskId: transaction.targetTaskId,
            targetThreadId: transaction.targetThreadId,
          };
          unavailable = true;
          commandId = undefined;
          resolveInjected(injected);
          frontend.destroy();
          backend.destroy();
          return;
        }
        withholdingCommit = true;
      }
    };
    const observeFront = (chunk) => {
      frontBuffer = Buffer.concat([frontBuffer, chunk]);
      if (startup) {
        if (frontBuffer.length < 4) return;
        const length = frontBuffer.readUInt32BE(0);
        if (frontBuffer.length < length) return;
        const protocol = frontBuffer.readUInt32BE(4);
        if (protocol === 80877103 || protocol === 80877104)
          throw new Error(
            "该候选不解析 SSL/GSS 加密会话；请仅使用独占回环无 TLS DSN。",
          );
        frontBuffer = frontBuffer.subarray(length);
        startup = false;
      }
      while (frontBuffer.length >= 5) {
        const length = frontBuffer.readUInt32BE(1);
        if (frontBuffer.length < length + 1) return;
        const tag = String.fromCharCode(frontBuffer[0]);
        const bytes = frontBuffer.subarray(5, length + 1);
        frontBuffer = frontBuffer.subarray(length + 1);
        if (tag === "Q") observeSql(cstring(bytes).text);
        if (tag === "P") {
          const name = cstring(bytes);
          statements.set(name.text, cstring(bytes, name.next).text);
        }
        if (tag === "B") {
          const value = bind(bytes);
          portals.set(value.portal, value);
        }
        if (tag === "E") {
          const name = cstring(bytes).text;
          const value = portals.get(name);
          if (value)
            observeSql(statements.get(value.statement) ?? "", value.parameters);
          portals.delete(name);
        }
      }
    };
    const writeFront = (frame) => {
      if (!frontend.write(frame)) {
        backend.pause();
        frontend.once("drain", () => backend.resume());
      }
    };
    const observeBack = (chunk) => {
      backBuffer = Buffer.concat([backBuffer, chunk]);
      while (backBuffer.length >= 5) {
        const length = backBuffer.readUInt32BE(1);
        if (backBuffer.length < length + 1) return;
        const frame = backBuffer.subarray(0, length + 1);
        backBuffer = backBuffer.subarray(length + 1);
        const tag = String.fromCharCode(frame[0]);
        if (!withholdingCommit) {
          writeFront(frame);
          continue;
        }
        heldFrames.push(frame);
        if (tag === "C" && cstring(frame.subarray(5)).text === "COMMIT") {
          // 服务端已确认 COMMIT；这条完成帧尚未转发给 pg 客户端。
          injected = {
            commitConfirmed: true,
            replySuppressed: true,
            commandId,
          };
          commandId = undefined;
          heldFrames = [];
          resolveInjected(injected);
          if (blackoutAfterCommit) {
            unavailable = true;
          }
          frontend.destroy();
          backend.destroy();
          return;
        }
        if (tag === "Z") {
          // 真实事务失败/ROLLBACK：不得把它计成已提交的故障证据。
          for (const held of heldFrames) writeFront(held);
          heldFrames = [];
          withholdingCommit = false;
        }
      }
    };
    frontend.on("data", (chunk) => {
      try {
        observeFront(chunk);
        if (!backend.write(chunk)) {
          frontend.pause();
          backend.once("drain", () => frontend.resume());
        }
      } catch (error) {
        failObserver(error);
      }
    });
    backend.on("data", (chunk) => {
      try {
        observeBack(chunk);
      } catch (error) {
        failObserver(error);
      }
    });
    frontend.on("error", () => backend.destroy());
    backend.on("error", () => frontend.destroy());
    frontend.on("end", () => backend.end());
    backend.on("end", () => frontend.end());
    frontend.on("close", () => {
      sockets.delete(frontend);
      backend.destroy();
    });
    backend.on("close", () => {
      sockets.delete(backend);
      frontend.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("PG 代理没有取得回环端口。");
  const proxied = new URL(destination);
  proxied.hostname = "127.0.0.1";
  proxied.port = String(address.port);
  proxied.searchParams.set("sslmode", "disable");
  return {
    connectionString: proxied.toString(),
    arm(expectedCommandId, options = {}) {
      if (closed || commandId || injected || !expectedCommandId)
        throw new Error("故障候选只允许针对一个新 fork 命令注入一次。");
      commandId = expectedCommandId;
      blackoutAfterCommit = options.blackoutAfterCommit === true;
      rollbackBeforeCommit = options.rollbackBeforeCommit === true;
    },
    restore() {
      unavailable = false;
    },
    evidence() {
      return { injected, observerError };
    },
    waitForInjected() {
      return injection;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
