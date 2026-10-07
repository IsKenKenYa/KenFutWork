import {
  directoryPickerStatusSchema,
  pickDirectoryResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@kenfutwork/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { LocalAccessVerifier } from "../features/local-access/types.js";
import type { LocalActor } from "../features/local-instance/types.js";
import type { NativeDirectoryPicker } from "../features/system/directory-picker.js";

/**
 * 系统级端点（桌面形态的原生目录对话框）。
 *
 * 消费方两处：Code 模式「打开文件夹」（拿到绝对路径就直接绑成 `projects.work_dir`）、
 * 以及能力探测——客户端用它决定走系统对话框还是回落浏览器目录选择器。
 */
export function registerSystemRoutes(
  app: FastifyInstance,
  options: {
    localAccess: LocalAccessVerifier;
    picker: NativeDirectoryPicker;
    /** 桌面形态判定（非桌面形态时如实报不可用 + 原因）。 */
    desktop: boolean | { available: boolean; reason?: string };
  },
): void {
  const desktop =
    typeof options.desktop === "boolean"
      ? { available: options.desktop }
      : options.desktop;

  const sendUnauthorized = (reply: FastifyReply) => {
    reply.code(401).send(
      unauthenticatedErrorResponseSchema.parse({
        error: {
          code: "unauthorized",
          message: "Missing or invalid bearer token.",
        },
      }),
    );
    return null;
  };
  const authenticate = async (
    request: Parameters<LocalAccessVerifier["authenticate"]>[0],
    reply: FastifyReply,
  ): Promise<LocalActor | null> =>
    (await options.localAccess.authenticate(request)) ??
    sendUnauthorized(reply);

  app.get("/api/system/directory-picker", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const status = desktop.available
      ? options.picker.availability()
      : {
          available: false,
          reason: desktop.reason ?? "当前形态不支持原生目录对话框。",
        };
    return reply.code(200).send(directoryPickerStatusSchema.parse(status));
  });

  app.post("/api/system/pick-directory", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    if (!desktop.available) {
      return reply.code(200).send(
        pickDirectoryResponseSchema.parse({
          status: "unavailable",
          reason:
            desktop.reason ??
            "当前形态没有原生目录对话框（服务端不在你本机上），请改用「填本机路径」。",
        }),
      );
    }
    return reply
      .code(200)
      .send(pickDirectoryResponseSchema.parse(await options.picker.pick()));
  });
}
