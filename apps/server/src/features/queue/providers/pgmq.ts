import pg from "pg";

import type { QueueClient, QueueMessage } from "../types.js";

/**
 * 队列缝的**服务端/自托管 Provider**：Postgres 扩展 PGMQ。
 *
 * 与原 `queue/pgmq-client.ts` 行为一致（含服务端长轮询 `read_with_poll`，用于压低空闲
 * 轮询量），只是方法名对齐缝的中立命名（`deleteMessage` / `setVisibilityTimeout`）。
 */
export function createPgmqQueue(options: {
  databaseUrl: string;
  maxConnections?: number;
}): QueueClient {
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    max: options.maxConnections ?? 5,
  });

  // 瞬时断连不该把进程带走
  pool.on("error", (error) => {
    console.error("[queue:pgmq] Pool error (non-fatal):", error.message);
  });

  return {
    async send(queue, payload, delaySeconds = 0) {
      const { rows } = await pool.query<{ send: number }>(
        "SELECT * FROM pgmq.send($1::text, $2::jsonb, $3::integer)",
        [queue, JSON.stringify(payload), delaySeconds],
      );
      return rows[0]!.send;
    },

    async read<T>(
      queue: string,
      visibilityTimeoutSeconds: number,
      quantity: number,
    ) {
      const { rows } = await pool.query(
        "SELECT * FROM pgmq.read($1::text, $2::integer, $3::integer)",
        [queue, visibilityTimeoutSeconds, quantity],
      );
      return rows as QueueMessage<T>[];
    },

    async readWithPoll<T>(
      queue: string,
      visibilityTimeoutSeconds: number,
      quantity: number,
      maxPollSeconds = 5,
      pollIntervalMs = 500,
    ) {
      const { rows } = await pool.query(
        "SELECT * FROM pgmq.read_with_poll($1::text, $2::integer, $3::integer, $4::integer, $5::integer)",
        [
          queue,
          visibilityTimeoutSeconds,
          quantity,
          maxPollSeconds,
          pollIntervalMs,
        ],
      );
      return rows as QueueMessage<T>[];
    },

    async deleteMessage(queue, msgId) {
      const { rows } = await pool.query<{ delete: boolean }>(
        "SELECT pgmq.delete($1::text, $2::bigint)",
        [queue, msgId],
      );
      return rows[0]?.delete === true;
    },

    async archive(queue, msgId) {
      const { rows } = await pool.query<{ archive: boolean }>(
        "SELECT pgmq.archive($1::text, $2::bigint)",
        [queue, msgId],
      );
      return rows[0]?.archive === true;
    },

    async setVisibilityTimeout(queue, msgId, visibilityTimeoutSeconds) {
      await pool.query(
        "SELECT pgmq.set_vt($1::text, $2::bigint, $3::integer)",
        [queue, msgId, visibilityTimeoutSeconds],
      );
    },

    async shutdown() {
      await pool.end();
    },
  };
}
