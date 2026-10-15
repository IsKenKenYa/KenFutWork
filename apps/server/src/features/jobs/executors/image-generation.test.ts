import { randomUUID } from "node:crypto";
import { backgroundJobSchema } from "@kenfutwork/shared";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { type ExecutorContext, getExecutor } from "../job-executor.js";

const { generate } = vi.hoisted(() => ({
  generate: vi.fn(async () => ({
    url: "https://provider.invalid/image",
    mimeType: "image/png",
    width: 12,
    height: 13,
  })),
}));
vi.mock("./instance-provider.js", () => ({
  resolveInstanceImageProviderFromPayload: async () => ({
    provider: { name: "test-provider", generate },
    configRevision: 7,
  }),
}));

import "./image-generation.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it.each([false, true, "download-retry", "actual-image"])(
  "真实image executor按ProjectFile receipt上传并拒绝失租调用（%s）",
  async (lostLease) => {
    const projectId = randomUUID();
    const job = backgroundJobSchema.parse({
      id: randomUUID(),
      instance_id: randomUUID(),
      project_id: projectId,
      session_id: null,
      canvas_id: null,
      thread_id: null,
      file_target: {
        kind: "project",
        projectId,
        sessionId: null,
        canvasId: null,
      },
      queue_name: "image_generation_jobs",
      job_type: "image_generation",
      status: "running",
      payload: {
        prompt: "image",
        model: "model",
        provider_instance_id: randomUUID(),
        output_format: "webp",
      },
      result: null,
      error_code: null,
      error_message: null,
      provider_job_id: null,
      attempt_count: 1,
      max_attempts: 3,
      created_by_client_id: null,
      created_at: "now",
      updated_at: "now",
      started_at: null,
      completed_at: null,
      failed_at: null,
      canceled_at: null,
    });
    const objectPath = `project-files/${job.id}`;
    const prepareWrite = vi.fn(async () => ({
      assetId: job.id,
      objectPath,
      relativePath: `${job.id}.png`,
      bucket: "project-assets",
    }));
    const recordGeneratedAsset = vi.fn();
    const upload = vi.fn(
      async (_path: string, _body?: Uint8Array, _options?: unknown) => {},
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      ),
    );
    const context = {
      jobService: {
        getJobForWorker: async () => job,
        beginSubmission: async () => {
          const attemptId = randomUUID();
          job.payload._generation_execution = {
            phase: "submitting",
            attemptId,
          };
          return attemptId;
        },
        saveExecution: async (_id: string, execution: unknown) => {
          job.payload._generation_execution = execution;
        },
      },
      generationTargets: {
        resolve: async () => ({ kind: "project", projectId }),
      },
      projectFiles: { prepareWrite },
      assetWriter: { recordGeneratedAsset },
      blob: {
        bucket: () => ({
          upload,
          resolveUrl: async () => "project-url",
          download: async () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
          remove: async () => {},
        }),
      },
      renewVt: async () => {},
    } as unknown as ExecutorContext;
    if (lostLease === true) {
      context.assertExecution = async () => {
        throw Object.assign(new Error("失租"), { code: "job_lease_lost" });
      };
      await expect(
        getExecutor("image_generation")!(job.id, {}, context),
      ).rejects.toMatchObject({ code: "job_lease_lost" });
      expect(generate).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      return;
    }
    if (lostLease === "download-retry") {
      const request = vi
        .fn()
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
      vi.stubGlobal("fetch", request);
      context.jobService.saveExecution = async (_id, execution) => {
        job.payload._generation_execution = execution;
      };
      await expect(
        getExecutor("image_generation")!(job.id, {}, context),
      ).rejects.toThrow();
      await getExecutor("image_generation")!(job.id, {}, context);
      expect(generate).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledTimes(2);
      expect(
        upload.mock.calls.filter(([path]) => path === objectPath),
      ).toHaveLength(1);
      return;
    }
    const bytes =
      lostLease === "actual-image"
        ? await sharp({
            create: { width: 48, height: 32, channels: 3, background: "red" },
          })
            .png()
            .toBuffer()
        : Buffer.from([1, 2, 3]);
    if (lostLease === "actual-image")
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(bytes)),
      );
    const result = await getExecutor("image_generation")!(job.id, {}, context);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ outputFormat: "webp" }),
    );
    expect(prepareWrite).toHaveBeenCalledWith(
      { instanceId: job.instance_id, accessClientId: null },
      expect.objectContaining({
        assetId: job.id,
        relativePath: `${job.id}.png`,
      }),
    );
    expect(upload).toHaveBeenCalledWith(objectPath, bytes, {
      contentType: "image/png",
      upsert: true,
    });
    expect(recordGeneratedAsset).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      asset_id: job.id,
      object_path: objectPath,
      signed_url: "project-url",
      width: lostLease === "actual-image" ? 48 : 12,
      height: lostLease === "actual-image" ? 32 : 13,
    });
  },
);
