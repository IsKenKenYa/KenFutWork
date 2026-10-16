import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  generationFileTargetSchema,
  jobResponseSchema,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import { expect, vi } from "vitest";
import { buildApp } from "../../app.js";
import { type JobLoopHandle, startJobLoop } from "../jobs/job-loop.js";
import "../jobs/executors/image-generation.js";
import {
  applicationEnvKey,
  createCodeUiHttpFixture,
} from "./code-ui-http.fixture.js";
import { createCodeUiTestClient } from "./host-client.fixture.js";
import { createCodeSessionFixture } from "./host-session.fixture.js";
import { heldModel } from "./model-stream.fixture.js";

export const RECOVERY_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII=",
  "base64",
);

export function mediaRecoveryLatch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function startMediaSupplier() {
  const requests = { submissions: 0, polls: 0, downloads: 0 };
  let complete = false;
  let downloadGate: Promise<void> | undefined;
  let baseUrl = "";
  const handle = "accepted-media-recovery-handle";
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/api/generate") {
      for await (const _chunk of request) {
        // 消费本机替身请求体；不记录凭据或提示正文。
      }
      requests.submissions += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: handle, status: "running" }));
      return;
    }
    if (request.url === `/v1/api/result?id=${handle}`) {
      requests.polls += 1;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          complete
            ? {
                id: handle,
                status: "succeeded",
                results: [{ url: `${baseUrl}/image.png` }],
              }
            : { id: handle, status: "running" },
        ),
      );
      return;
    }
    if (request.url === "/image.png") {
      requests.downloads += 1;
      await downloadGate;
      response.setHeader("content-type", "image/png");
      response.end(RECOVERY_IMAGE);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("本机媒体替身未取得HTTP端口。");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    handle,
    requests,
    complete: () => {
      complete = true;
    },
    holdDownload: (gate: Promise<void>) => {
      downloadGate = gate;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function rebuildMediaHost(
  fixture: Awaited<ReturnType<typeof createCodeUiHttpFixture>>,
) {
  const saved = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env))
    if (applicationEnvKey(key) && value !== undefined) {
      saved.set(key, value);
      delete process.env[key];
    }
  process.env.KENFUTWORK_PLUGINS_DIR = fixture.pluginsDir;
  try {
    return buildApp({
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
  } finally {
    for (const key of Object.keys(process.env))
      if (applicationEnvKey(key)) delete process.env[key];
    for (const [key, value] of saved) process.env[key] = value;
  }
}

function startMediaWorker(app: ReturnType<typeof buildApp>) {
  const kernel = app.kernel;
  return startJobLoop(
    {
      queue: kernel.get("queue"),
      jobService: kernel.get("jobs"),
      blob: kernel.get("blob"),
      uploads: kernel.get("uploads"),
      projectFiles: kernel.get("projectFiles"),
      generationTargets: kernel.get("generationTargets"),
      modelProviders: kernel.get("modelProviders"),
      canvas: kernel.get("canvas"),
      assetWriter: kernel.get("assetWriter"),
      usageService: kernel.get("usage"),
      env: {
        agentBackendMode: "state",
        agentModel: "fixture",
        port: 0,
        version: "test",
        webOrigin: "http://localhost:3300",
        workerPollIntervalMs: 1000,
      },
    },
    { queues: ["image_generation_jobs"] },
  );
}

export async function createUnifiedMediaRecoveryFixture(
  options: { submit?: boolean } = {},
) {
  const fixture = await createCodeUiHttpFixture();
  const supplier = await startMediaSupplier();
  const model = await heldModel();
  const host = await createCodeSessionFixture(model.baseUrl, {
    client: fixture.client,
    initialConfig: { mode: "yolo", planEnabled: false },
  });
  let app = fixture.app;
  let client = fixture.client;
  let worker: JobLoopHandle | undefined;
  const close = async () => {
    await worker?.shutdown();
    await client.close();
    await app.close();
    await model.close();
    await supplier.close();
    await fixture.close();
    await rm(host.workspacePath, { recursive: true, force: true });
  };
  try {
    const shared = await client.request(
      `/api/projects/${host.projectId}`,
      {
        enabled_modes: ["code", "design"],
      },
      "PATCH",
    );
    expect(shared.status).toBe(204);
    const canvas = await app.kernel
      .get("canvas")
      .createCanvas(fixture.actor, host.projectId, { name: "宿主恢复目标" });
    const mediaProvider = await app.kernel
      .get("modelProviders")
      .createInstance(fixture.actor, {
        name: "本机恢复媒体替身",
        protocol: "grsai",
        baseUrl: supplier.baseUrl,
        apiKey: "integration-only-not-a-key",
        models: [
          {
            id: "nano-banana-2",
            name: "恢复图片",
            capability: "image",
            imageGeneration: { maxOutputs: 1 },
          },
        ],
      });
    const admitted = await host.command("sendText", {
      text: "保持当前Run，核对已受理媒体的宿主恢复",
      mode: "yolo",
      planEnabled: false,
      workContext: { preset: "design", canvasId: canvas.id },
    });
    expect(admitted.body.result.status).toBe("accepted");
    await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
      timeout: 30_000,
    });
    const snapshot = protocol.conversationSnapshotSchema.parse(
      await host.snapshot(),
    );
    const runId = snapshot.control.activeWorks.find(
      (work) => work.kind === "primaryTurn",
    )?.foregroundExecutionId;
    if (!runId) throw new Error("媒体接纳缺少真实前台Run。");
    const handle = await app.kernel
      .get("executionScopes")
      .openTask(fixture.actor, host.sessionId);
    const thread = await app.kernel
      .get("threads")
      .resolveOwnedSessionThread(fixture.actor, host.sessionId);
    const accepted = await app.kernel.get("jobs").createJob(fixture.actor, {
      requestId: randomUUID(),
      projectId: host.projectId,
      sessionId: host.sessionId,
      canvasId: canvas.id,
      threadId: thread.threadId,
      runId,
      expectedScopeGeneration: handle.describe().generation,
      expectedBranchGeneration: handle.branchGeneration,
      jobType: "image_generation",
      payload: {
        prompt: "一个蓝色方块",
        model: "nano-banana-2",
        provider_instance_id: mediaProvider.id,
      },
    });
    const target = generationFileTargetSchema.parse(accepted.file_target);
    expect(target).toMatchObject({
      kind: "task",
      taskId: host.sessionId,
      originRunId: runId,
    });
    const job = async () => {
      const response = await client.request(`/api/jobs/${accepted.id}`);
      expect(response.status).toBe(200);
      return jobResponseSchema.parse(response.body).job;
    };
    if (options.submit !== false) {
      worker = startMediaWorker(app);
      await vi.waitFor(
        async () => expect((await job()).provider_job_id).toBe(supplier.handle),
        { timeout: 30_000 },
      );
      await worker.shutdown();
      worker = undefined;
    }
    return {
      actor: fixture.actor,
      host,
      runId,
      target,
      canvasId: canvas.id,
      jobId: accepted.id,
      supplier,
      model,
      job,
      app: () => app,
      client: () => client,
      async restart() {
        await client.close();
        await app.close();
        app = rebuildMediaHost(fixture);
        const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
        client = createCodeUiTestClient({
          baseUrl,
          origin: fixture.origin,
          headers: {
            authorization: `Bearer ${await app.kernel.get("localAccess").getDesktopToken()}`,
          },
        });
        return client.request(
          `/api/agent/runs/latest?sessionId=${host.sessionId}`,
        );
      },
      startRecovery() {
        supplier.complete();
        worker = startMediaWorker(app);
      },
      async terminalJob() {
        let result = await job();
        await vi.waitFor(
          async () => {
            result = await job();
            expect(["succeeded", "dead_letter", "canceled"]).toContain(
              result.status,
            );
          },
          { timeout: 30_000 },
        );
        return result;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
