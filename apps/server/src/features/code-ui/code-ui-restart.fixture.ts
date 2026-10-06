import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { buildApp } from "../../app.js";
import {
  applicationEnvKey,
  type createCodeUiHttpFixture,
} from "./code-ui-http.fixture.js";
import { createCodeUiTestClient } from "./host-client.fixture.js";

/** 同独占数据目录/PG/Blob冷装配真实服务；新脚本Bearer只留HTTP接入层。 */
export async function restartCodeUiHttpFixture(
  fixture: Awaited<ReturnType<typeof createCodeUiHttpFixture>>,
) {
  await fixture.client.close();
  await fixture.app.close();
  const saved = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env))
    if (applicationEnvKey(key) && value !== undefined) {
      saved.set(key, value);
      delete process.env[key];
    }
  process.env.KENFUTWORK_PLUGINS_DIR = fixture.pluginsDir;
  let app: ReturnType<typeof buildApp> | undefined;
  let client: ReturnType<typeof createCodeUiTestClient> | undefined;
  try {
    app = buildApp({
      env: {
        databaseUrl: fixture.database.connectionString,
        desktopDataDir: fixture.directory,
        queueDriver: "in-process",
        agentFilesRoot: join(fixture.directory, "agent-files"),
        blobDir: join(fixture.directory, "blobs"),
        sandboxRoot: join(fixture.directory, "sandbox"),
        checkpointRoot: join(fixture.directory, "checkpoints"),
        webOrigin: fixture.origin,
        serverHost: "127.0.0.1",
      },
    });
    const activeApp = app;
    const baseUrl = await activeApp.listen({ host: "127.0.0.1", port: 0 });
    const token = await activeApp.kernel.get("localAccess").getDesktopToken();
    client = createCodeUiTestClient({
      baseUrl,
      origin: fixture.origin,
      headers: { authorization: `Bearer ${token}` },
    });
    const stream = await client.openCodeStream();
    const clientId = randomUUID();
    const hello = await stream.rpc("initializeConversationV4", [
      {
        kind: "clientHello",
        protocolVersion: 3,
        clientId,
        appVersion: "owned-output-cold-http",
        clientKind: "desktop",
      },
    ]);
    if (hello.status !== 200) throw new Error("冷恢复真实Code连接初始化失败");
    const activeClient = client;
    // 仅变更外部HTTP地址，业务、认证与Task查询仍走真实新服务。
    fixture.client.request = activeClient.request;
    return {
      client: activeClient,
      stream,
      clientId,
      async close() {
        await activeClient.close();
        await activeApp.close();
      },
    };
  } catch (error) {
    await client?.close();
    await app?.close();
    throw error;
  } finally {
    for (const key of Object.keys(process.env))
      if (applicationEnvKey(key)) delete process.env[key];
    for (const [key, value] of saved) process.env[key] = value;
  }
}
