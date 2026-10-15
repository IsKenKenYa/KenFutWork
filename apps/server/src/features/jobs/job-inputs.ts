import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@kenfutwork/shared";
import type { LocalActor } from "../local-instance/types.js";
import type { UploadService } from "../uploads/upload-service.js";

export class JobInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobInputError";
  }
}

/** 在共享接纳入口保存输入字节；执行时只持有素材引用并重新签发URL。 */
export async function persistJobInputs(
  actor: LocalActor,
  payload: Record<string, unknown>,
  uploads?: UploadService,
  projectId?: string,
) {
  const created: string[] = [];
  const discard = async () => {
    if (uploads)
      await Promise.allSettled(
        created.map((id) => uploads.deleteAsset(actor, id)),
      );
  };
  async function save(
    source: string,
    kind: "image" | "video",
  ): Promise<string> {
    if (!uploads)
      throw new JobInputError("参考素材存储未接通，请检查实例配置。");
    if (source.startsWith("asset://")) {
      await uploads.getAssetUrl(actor, source.slice("asset://".length));
      return source;
    }
    const url = /^(https?:|data:)/i.test(source)
      ? source
      : `data:${kind === "image" ? "image/png" : "video/mp4"};base64,${source}`;
    const response = await fetch(url).catch(() => {
      throw new JobInputError("参考素材暂时无法读取，请检查链接后重试。");
    });
    if (!response.ok)
      throw new JobInputError("参考素材读取失败，请检查链接或重新添加。");
    const mimeType =
      response.headers.get("content-type")?.split(";")[0] ??
      (kind === "image" ? "image/png" : "video/mp4");
    const extension =
      mimeType === "image/jpeg"
        ? "jpg"
        : mimeType === "image/webp"
          ? "webp"
          : kind === "video"
            ? "mp4"
            : "png";
    const stored = await uploads.uploadFile(actor, {
      bucket: "project-assets",
      fileName: `reference-${randomUUID()}.${extension}`,
      fileBuffer: Buffer.from(await response.arrayBuffer()),
      mimeType,
      ...(projectId ? { projectId } : {}),
    });
    created.push(stored.asset.id);
    return `asset://${stored.asset.id}`;
  }
  try {
    const result = { ...payload };
    if (Array.isArray(payload.input_images)) {
      const saved = await Promise.allSettled(
        payload.input_images.map(async (source) => {
          if (typeof source !== "string")
            throw new JobInputError("参考图格式无效，请重新添加。");
          return save(source, "image");
        }),
      );
      result.input_images = saved.map((entry) => {
        if (entry.status === "rejected") throw entry.reason;
        return entry.value;
      });
    }
    if (typeof payload.input_video === "string")
      result.input_video = await save(payload.input_video, "video");
    return { payload: result, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}

export async function resolveJobMediaInputs(
  job: BackgroundJob,
  uploads?: Pick<UploadService, "getAssetUrl">,
): Promise<{ inputImages?: string[]; inputVideo?: string }> {
  async function resolve(source: string) {
    if (!source.startsWith("asset://")) return source;
    if (!uploads)
      throw new Error("参考素材读取服务未接通，请检查工作节点配置。");
    return uploads.getAssetUrl(
      { instanceId: job.instance_id, accessClientId: job.created_by_client_id },
      source.slice("asset://".length),
    );
  }
  const images = job.payload.input_images;
  const video = job.payload.input_video;
  return {
    ...(Array.isArray(images)
      ? {
          inputImages: await Promise.all(
            images.map((source: unknown) => {
              if (typeof source !== "string")
                throw new Error("参考图引用无效。");
              return resolve(source);
            }),
          ),
        }
      : {}),
    ...(typeof video === "string" ? { inputVideo: await resolve(video) } : {}),
  };
}
