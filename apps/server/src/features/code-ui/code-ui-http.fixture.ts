import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { buildApp } from "../../app.js";
import type { ServerEnv } from "../../config/env.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiTestClient } from "./host-client.fixture.js";

function applicationEnvKey(key: string) {
  return (
    /^(KENFUTWORK_|LOOMIC_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|REPLICATE_|METASO_|VOLCES_|LEMON_)/u.test(
      key,
    ) || ["DATABASE_URL", "SUPABASE_DB_URL", "PORT", "HOST"].includes(key)
  );
}

/** 独占真实HTTP/SSE/PG；只用共享迁移创建schema，不读取.env或任何现存DSN。 */
export async function createCodeUiHttpFixture(
  options: {
    authDriver?: ServerEnv["authDriver"];
    builtinPluginsDir?: string;
    allowThirdPartyPlugins?: boolean;
  } = {},
) {
  const database = await createTaskWorkDatabase();
  const directory = database.directory;
  const origin = "http://localhost:3300";
  const pluginsDir = join(directory, "plugins");
  await mkdir(pluginsDir);
  const saved = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (applicationEnvKey(key) && value !== undefined) {
      saved.set(key, value);
      delete process.env[key];
    }
  }
  process.env.KENFUTWORK_PLUGINS_DIR = pluginsDir;
  if (options.builtinPluginsDir)
    process.env.KENFUTWORK_BUILTIN_PLUGINS_DIR = options.builtinPluginsDir;
  if (options.allowThirdPartyPlugins !== undefined)
    process.env.KENFUTWORK_ALLOW_THIRD_PARTY_PLUGINS = String(
      options.allowThirdPartyPlugins,
    );
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    app = buildApp({
      env: {
        databaseUrl: database.connectionString,
        authDriver: options.authDriver ?? "local-trust",
        queueDriver: "in-process",
        credentialSecret: randomBytes(32).toString("hex"),
        agentFilesRoot: join(directory, "agent-files"),
        blobDir: join(directory, "blobs"),
        sandboxRoot: join(directory, "sandbox"),
        checkpointRoot: join(directory, "checkpoints"),
        webOrigin: origin,
        serverHost: "127.0.0.1",
      },
    });
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const host = app;
    const client = createCodeUiTestClient({ baseUrl, origin });
    let closing: Promise<void> | undefined;
    return {
      app: host,
      database,
      directory,
      pluginsDir,
      baseUrl,
      origin,
      client,
      close() {
        closing ??= (async () => {
          await client.close();
          const native = await host.kernel
            .get("agentPersistence")
            .getPersistence();
          await host.close();
          if (native?.checkpointer instanceof PostgresSaver) {
            await native.checkpointer.end();
          }
          if (native?.store instanceof PostgresStore) {
            await native.store.stop();
          }
          await database.close();
        })().catch((error: unknown) => {
          closing = undefined;
          throw error;
        });
        return closing;
      },
    };
  } catch (error) {
    await app?.close();
    await database.close();
    throw error;
  } finally {
    for (const key of Object.keys(process.env))
      if (applicationEnvKey(key)) delete process.env[key];
    for (const [key, value] of saved) process.env[key] = value;
  }
}
